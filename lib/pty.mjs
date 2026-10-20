// Interactive terminal sessions backed by Windows ConPTY.
//
// A tiny C# helper (lib/conpty/WdbConPty.cs) is compiled on first use with the in-box
// .NET Framework csc.exe. Each session is one helper process that owns a pseudo console,
// a Job Object (kill-on-close) and the child process tree. Output is kept in a bounded
// ring buffer addressed by absolute byte cursors.
import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import readline from "node:readline";
import { spawn, execFile } from "node:child_process";
import { fileURLToPath } from "node:url";

const SOURCE_PATH = fileURLToPath(new URL("./conpty/WdbConPty.cs", import.meta.url));
const MIN_WINDOWS_BUILD = 17763;
const MAX_SESSIONS = 16;
const DEFAULT_BUFFER_BYTES = 8 * 1024 * 1024;
const BLOCK_BYTES = 64 * 1024;
const MAX_WRITE_BYTES = 1024 * 1024;
const WRITE_CHUNK_BYTES = 48 * 1024;
const MAX_COMMAND_LINE = 32000;
const START_TIMEOUT_MS = 15000;
const RESIZE_TIMEOUT_MS = 5000;
const CLOSE_TIMEOUT_MS = 5000;
const EXIT_DRAIN_TIMEOUT_MS = 10000;
const MAX_STDERR_LINES = 50;
const CTRL_C_SETTLE_MS = 250;
const CTRL_C_GRACE_MS = 100;
const SIGNALS = ["SIGINT", "SIGTERM", "SIGKILL", "SIGHUP", "SIGQUIT", "SIGBREAK"];
const POWERSHELL_FLAGS = ["-NoLogo", "-NoProfile", "-ExecutionPolicy", "Bypass"];

const compileMemo = new Map();
let sourceCache = null;

function ptyError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}
function invalid(message) { return ptyError("PTY_INVALID_ARGUMENT", message); }
function boundedInt(value, fallback, min, max, name) {
  if (value === undefined || value === null) return fallback;
  if (!Number.isSafeInteger(value) || value < min || value > max) throw invalid(name + " must be an integer between " + min + " and " + max);
  return value;
}
function sleep(ms) { return new Promise(resolve => setTimeout(resolve, ms)); }

function sourceInfo() {
  if (!sourceCache) {
    const source = fs.readFileSync(SOURCE_PATH);
    sourceCache = { source: source, hash: crypto.createHash("sha256").update(source).digest("hex").slice(0, 12) };
  }
  return sourceCache;
}
function findCsc() {
  const configured = process.env.WDB_CSC;
  if (configured && configured.trim()) return fileExists(configured.trim()) ? configured.trim() : null;
  const windir = process.env.WINDIR || process.env.SystemRoot || "C:\\Windows";
  for (const framework of ["Framework64", "Framework"]) {
    const candidate = path.join(windir, "Microsoft.NET", framework, "v4.0.30319", "csc.exe");
    if (fileExists(candidate)) return candidate;
  }
  return null;
}
function fileExists(file) {
  try { return fs.statSync(file).isFile(); } catch { return false; }
}
function windowsBuild() {
  const parts = os.release().split(".").map(item => Number(item));
  return { major: parts[0] || 0, build: parts[2] || 0 };
}

// --- command line construction (MSVCRT / CommandLineToArgvW rules) ---------------------
export function quoteWindowsArg(arg) {
  if (arg.length > 0 && !/[ \t\n\v"]/.test(arg)) return arg;
  let result = "\"";
  let backslashes = 0;
  for (const ch of arg) {
    if (ch === "\\") { backslashes++; continue; }
    if (ch === "\"") { result += "\\".repeat(backslashes * 2 + 1) + "\""; backslashes = 0; continue; }
    result += "\\".repeat(backslashes) + ch;
    backslashes = 0;
  }
  return result + "\\".repeat(backslashes * 2) + "\"";
}
function quoteProgram(program) {
  // argv[0] is parsed without backslash escapes; it can only be wrapped in quotes.
  if (program.includes("\"")) throw invalid("the executable path must not contain double quotes");
  return program.length > 0 && !/[ \t]/.test(program) ? program : "\"" + program + "\"";
}
function buildCommandLine(args, shellFile) {
  const hasCommand = args.command !== undefined && args.command !== null;
  const hasArgv = args.argv !== undefined && args.argv !== null;
  if (hasCommand && hasArgv) throw invalid("Provide either command or argv, not both");
  if (hasArgv) {
    if (!Array.isArray(args.argv) || args.argv.length === 0) throw invalid("argv must be a non-empty array of strings (first element is the executable)");
    for (const item of args.argv) {
      if (typeof item !== "string") throw invalid("argv must contain only strings");
      if (item.includes("\0")) throw invalid("argv entries must not contain NUL characters");
    }
    if (!args.argv[0]) throw invalid("argv[0] (the executable) must be a non-empty string");
    return [quoteProgram(args.argv[0])].concat(args.argv.slice(1).map(quoteWindowsArg)).join(" ");
  }
  const shell = quoteProgram(shellFile) + " " + POWERSHELL_FLAGS.join(" ");
  if (!hasCommand) return shell;
  if (typeof args.command !== "string" || !args.command.trim()) throw invalid("command must be a non-empty string");
  if (args.command.includes("\0")) throw invalid("command must not contain NUL characters");
  return shell + " -EncodedCommand " + Buffer.from(args.command, "utf16le").toString("base64");
}

// --- output ring buffer with absolute byte cursors ---------------------------------------
class OutputRing {
  constructor(capacity) {
    this.capacity = capacity;
    this.blocks = [];
    this.head = 0;
    this.total = 0;
    this.oldest = 0;
  }
  append(data) {
    let offset = 0;
    while (offset < data.length) {
      let last = this.blocks.length > this.head ? this.blocks[this.blocks.length - 1] : null;
      if (!last || last.len === last.buf.length) {
        last = { start: this.total, buf: Buffer.allocUnsafe(BLOCK_BYTES), len: 0 };
        this.blocks.push(last);
      }
      const count = Math.min(last.buf.length - last.len, data.length - offset);
      data.copy(last.buf, last.len, offset, offset + count);
      last.len += count;
      offset += count;
      this.total += count;
    }
    const floor = this.total - this.capacity;
    if (floor > this.oldest) {
      this.oldest = floor;
      while (this.head < this.blocks.length - 1) {
        const block = this.blocks[this.head];
        if (block.start + block.len > this.oldest) break;
        this.blocks[this.head] = null;
        this.head++;
      }
      if (this.head > 64 && this.head * 2 > this.blocks.length) {
        this.blocks = this.blocks.slice(this.head);
        this.head = 0;
      }
    }
  }
  read(from, maxBytes) {
    const count = Math.max(0, Math.min(maxBytes, this.total - from));
    const out = Buffer.allocUnsafe(count);
    if (count === 0) return out;
    let lo = this.head, hi = this.blocks.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (this.blocks[mid].start <= from) lo = mid; else hi = mid - 1;
    }
    let written = 0, position = from;
    for (let i = lo; i < this.blocks.length && written < count; i++) {
      const block = this.blocks[i];
      const begin = position - block.start;
      const take = Math.min(block.len - begin, count - written);
      block.buf.copy(out, written, begin, begin + take);
      written += take;
      position += take;
    }
    return out;
  }
}

function completeUtf8Length(buf) {
  const n = buf.length;
  let i = n - 1, continuation = 0;
  while (i >= 0 && continuation < 3 && (buf[i] & 0xC0) === 0x80) { i--; continuation++; }
  if (i < 0) return n;
  const lead = buf[i];
  const need = lead < 0x80 ? 1 : (lead & 0xE0) === 0xC0 ? 2 : (lead & 0xF0) === 0xE0 ? 3 : (lead & 0xF8) === 0xF0 ? 4 : 1;
  return n - i < need ? i : n;
}

const ANSI_PATTERN = new RegExp([
  "\\x1b\\][\\s\\S]*?(?:\\x07|\\x1b\\\\)",            // OSC ... BEL | ST
  "\\x1b[PX^_][\\s\\S]*?\\x1b\\\\",                    // DCS / SOS / PM / APC ... ST
  "\\x1b\\[[0-?]*[ -/]*[@-~]",                        // CSI
  "\\x9b[0-?]*[ -/]*[@-~]",                           // 8-bit CSI
  "\\x1b(?:\\][^\\x07\\x1b]*|[PX^_][\\s\\S]*|\\[[0-?]*[ -/]*)$", // sequence cut off at the end
  "\\x1b[ -/]*[0-~]",                                 // two-char / nF escape sequences
  "\\x1b$"
].join("|"), "g");
export function stripAnsi(text) { return text.replace(ANSI_PATTERN, ""); }

function taskkillTree(pid) {
  return new Promise(resolve => {
    if (!pid) { resolve(); return; }
    let child;
    try { child = spawn("taskkill.exe", ["/PID", String(pid), "/T", "/F"], { windowsHide: true, stdio: "ignore" }); }
    catch { resolve(); return; }
    child.once("error", () => resolve());
    child.once("close", () => resolve());
  });
}

function runCompiler(csc, args) {
  return new Promise(resolve => {
    execFile(csc, args, { windowsHide: true, timeout: 180000, maxBuffer: 4 * 1024 * 1024, encoding: "utf8" }, (error, stdout, stderr) => {
      const output = ((stdout || "") + "\n" + (stderr || "")).trim();
      resolve({ ok: !error, output: output || (error ? error.message : "") });
    });
  });
}

// Best effort: remove helpers built from older sources and temp files left by crashed builds.
// Executables still running (another bridge instance) cannot be deleted and are skipped.
async function pruneStaleHelpers(binDir, keep) {
  let names;
  try { names = await fsp.readdir(binDir); } catch { return; }
  const cutoff = Date.now() - 10 * 60 * 1000;
  for (const name of names) {
    if (name === keep || !name.startsWith("wdb-conpty-")) continue;
    const file = path.join(binDir, name);
    try {
      if (/^wdb-conpty-[0-9a-f]{12}\.exe$/.test(name)) { await fsp.rm(file, { force: true }); continue; }
      if (/\.tmp\.(exe|cs)$/.test(name) && (await fsp.stat(file)).mtimeMs < cutoff) await fsp.rm(file, { force: true });
    } catch {}
  }
}

async function ensureHelper(dataDir) {
  const info = sourceInfo();
  const binDir = path.join(dataDir, "bin");
  const exe = path.join(binDir, "wdb-conpty-" + info.hash + ".exe");
  if (compileMemo.has(exe)) return compileMemo.get(exe);
  const promise = (async () => {
    if (fileExists(exe)) return exe;
    const csc = findCsc();
    if (!csc) throw ptyError("PTY_UNAVAILABLE", "csc.exe (.NET Framework 4) was not found; set WDB_CSC to its path to build the ConPTY helper");
    await fsp.mkdir(binDir, { recursive: true });
    const stem = path.join(binDir, "wdb-conpty-" + info.hash + "." + process.pid + "-" + crypto.randomBytes(4).toString("hex") + ".tmp");
    const tmpSource = stem + ".cs", tmpExe = stem + ".exe";
    try {
      await fsp.writeFile(tmpSource, info.source);
      const result = await runCompiler(csc, ["/nologo", "/optimize+", "/target:exe", "/platform:anycpu", "/utf8output", "/out:" + tmpExe, tmpSource]);
      if (!result.ok || !fileExists(tmpExe)) {
        throw ptyError("PTY_UNAVAILABLE", "Failed to compile the ConPTY helper with " + csc + ": " + (result.output || "unknown error").slice(0, 4000));
      }
      try { await fsp.rename(tmpExe, exe); }
      catch (error) { if (!fileExists(exe)) throw error; }
      await pruneStaleHelpers(binDir, path.basename(exe));
      return exe;
    } finally {
      await fsp.rm(tmpSource, { force: true }).catch(() => {});
      await fsp.rm(tmpExe, { force: true }).catch(() => {});
    }
  })();
  compileMemo.set(exe, promise);
  promise.catch(() => { if (compileMemo.get(exe) === promise) compileMemo.delete(exe); });
  return promise;
}

function bufferCapacity() {
  const raw = process.env.WDB_PTY_BUFFER_BYTES;
  if (raw === undefined || raw === "") return DEFAULT_BUFFER_BYTES;
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < 1024 || value > 1024 * 1024 * 1024) return DEFAULT_BUFFER_BYTES;
  return value;
}

export function createPtyManager(options) {
  const opts = options || {};
  const dataDir = opts.dataDir;
  const resolveShell = opts.resolveShell;
  const buildEnv = opts.buildEnv || (overrides => Object.assign({}, process.env, overrides || {}));
  const resolvePath = opts.resolvePath || (p => path.resolve(p));
  const homeDir = opts.homeDir || os.homedir();
  if (typeof dataDir !== "string" || !dataDir) throw new Error("createPtyManager requires dataDir");
  if (typeof resolveShell !== "function") throw new Error("createPtyManager requires resolveShell()");

  const sessions = new Map();
  let starting = 0;

  function available() {
    if (process.platform !== "win32") return { available: false, reason: "ConPTY terminals require Windows; current platform is " + process.platform };
    const version = windowsBuild();
    if (version.major < 10 || version.build < MIN_WINDOWS_BUILD) return { available: false, reason: "ConPTY requires Windows 10 version 1809 (build " + MIN_WINDOWS_BUILD + ") or later; this system reports " + os.release() };
    const csc = findCsc();
    if (csc) return { available: true, csc: csc };
    try {
      const exe = path.join(dataDir, "bin", "wdb-conpty-" + sourceInfo().hash + ".exe");
      if (fileExists(exe)) return { available: true };
    } catch {}
    return { available: false, reason: "csc.exe (.NET Framework 4) was not found under %WINDIR%\\Microsoft.NET; set WDB_CSC to build the ConPTY helper" };
  }

  function getSession(id) {
    if (typeof id !== "string" || !id) throw invalid("session_id must be a non-empty string");
    const session = sessions.get(id);
    if (!session) throw ptyError("PTY_NOT_FOUND", "No PTY session with id " + id + " (it may have been closed)");
    return session;
  }

  function notify(session) {
    const waiters = Array.from(session.waiters);
    session.waiters.clear();
    for (const wake of waiters) wake();
  }
  function waitForChange(session, ms) {
    return new Promise(resolve => {
      let timer = null;
      const wake = () => { if (timer) clearTimeout(timer); session.waiters.delete(wake); resolve(); };
      timer = setTimeout(wake, Math.max(0, ms));
      session.waiters.add(wake);
    });
  }
  async function waitUntil(session, predicate, ms) {
    const deadline = Date.now() + ms;
    while (!predicate()) {
      const left = deadline - Date.now();
      if (left <= 0) return false;
      await waitForChange(session, left);
    }
    return true;
  }
  function stderrText(session) {
    return session.stderrLines.join("\n").trim();
  }

  function markEnded(session) {
    if (session.ended) return;
    session.ended = true;
    session.childExited = true;
    if (session.exitTimer) { clearTimeout(session.exitTimer); session.exitTimer = null; }
    if (session.endTimer) { clearTimeout(session.endTimer); session.endTimer = null; }
    const pendingResizes = session.resizeWaiters.splice(0);
    for (const waiter of pendingResizes) waiter.reject(ptyError("PTY_EXITED", "The PTY session ended before the resize was acknowledged"));
    if (session.startWaiter) {
      const waiter = session.startWaiter;
      session.startWaiter = null;
      const detail = session.startError || stderrText(session) || ("helper exited with code " + session.helperExitCode);
      waiter.reject(ptyError("PTY_START_FAILED", "Failed to start PTY session: " + detail));
    }
    notify(session);
  }

  function handleEvent(session, event) {
    switch (event.event) {
      case "started":
        session.pid = Number.isSafeInteger(event.pid) ? event.pid : null;
        if (session.startWaiter) { const waiter = session.startWaiter; session.startWaiter = null; waiter.resolve(); }
        break;
      case "resized": {
        const waiter = session.resizeWaiters.shift();
        if (event.ok !== false) {
          session.cols = event.cols;
          session.rows = event.rows;
          if (waiter) waiter.resolve(event);
        } else if (waiter) {
          waiter.reject(ptyError("PTY_RESIZE_FAILED", "Resize failed: " + (event.error || "unknown error")));
        }
        break;
      }
      case "exit":
        session.childExited = true;
        session.exitCode = Number.isSafeInteger(event.code) ? event.code : null;
        // The helper drains remaining output and exits on its own; guard against a hang.
        if (!session.exitTimer) {
          session.exitTimer = setTimeout(() => {
            session.exitTimer = null;
            if (!session.ended) { try { session.helper.kill(); } catch {} }
          }, EXIT_DRAIN_TIMEOUT_MS);
          session.exitTimer.unref();
        }
        notify(session);
        break;
      case "error":
        session.startError = String(event.message || "unknown helper error");
        pushStderr(session, "error: " + session.startError);
        break;
      case "warning":
        pushStderr(session, "warning: " + String(event.message || ""));
        break;
      default:
        break;
    }
  }
  function pushStderr(session, line) {
    session.stderrLines.push(String(line).slice(0, 2000));
    if (session.stderrLines.length > MAX_STDERR_LINES) session.stderrLines.splice(0, session.stderrLines.length - MAX_STDERR_LINES);
  }

  function sendControl(session, line) {
    return new Promise((resolve, reject) => {
      const stdin = session.helper.stdin;
      if (!stdin || stdin.destroyed || stdin.writableEnded || session.ended) {
        reject(ptyError("PTY_EXITED", "The PTY session has exited"));
        return;
      }
      try {
        stdin.write(line + "\n", "ascii", error => {
          if (error) reject(ptyError("PTY_EXITED", "Failed to send input to the PTY helper: " + error.message));
          else resolve();
        });
      } catch (error) {
        reject(ptyError("PTY_EXITED", "Failed to send input to the PTY helper: " + error.message));
      }
    });
  }

  async function terminate(session, timeoutMs) {
    if (session.ended) return;
    sendControl(session, "k").catch(() => {});
    if (await waitUntil(session, () => session.childExited || session.ended, Math.min(3000, timeoutMs))) return;
    await taskkillTree(session.helperPid);
  }

  function describe(session) {
    return {
      session_id: session.id,
      pid: session.pid,
      label: session.label,
      command_line: session.commandLine,
      cols: session.cols,
      rows: session.rows,
      started_at: session.startedAt,
      exited: session.ended,
      exit_code: session.ended ? session.exitCode : null,
      total_bytes: session.ring.total
    };
  }

  async function start(args) {
    args = args || {};
    const status = available();
    if (!status.available) throw ptyError("PTY_UNAVAILABLE", status.reason);
    const cols = boundedInt(args.cols, 120, 20, 500, "cols");
    const rows = boundedInt(args.rows, 30, 5, 300, "rows");
    if (args.label !== undefined && args.label !== null && typeof args.label !== "string") throw invalid("label must be a string");
    if (typeof args.label === "string" && args.label.length > 100) throw invalid("label must be at most 100 characters");
    if (args.cwd !== undefined && args.cwd !== null && typeof args.cwd !== "string") throw invalid("cwd must be a string");
    if (args.env !== undefined && args.env !== null && (typeof args.env !== "object" || Array.isArray(args.env))) throw invalid("env must be an object");
    const shell = resolveShell();
    const shellFile = shell && typeof shell.file === "string" ? shell.file : null;
    if (!shellFile && (args.argv === undefined || args.argv === null)) throw ptyError("PTY_UNAVAILABLE", "No PowerShell executable is available");
    const commandLine = buildCommandLine(args, shellFile || "");
    const cwd = resolvePath(args.cwd === undefined || args.cwd === null || args.cwd === "" ? homeDir : args.cwd);
    let cwdStat;
    try { cwdStat = fs.statSync(cwd); } catch { cwdStat = null; }
    if (!cwdStat || !cwdStat.isDirectory()) throw invalid("cwd does not exist or is not a directory: " + cwd);
    const env = buildEnv(args.env || undefined);
    const label = typeof args.label === "string" && args.label ? args.label
      : (args.command ? String(args.command) : Array.isArray(args.argv) ? args.argv.join(" ") : "PowerShell").replace(/\s+/g, " ").trim().slice(0, 100);

    if (sessions.size + starting >= MAX_SESSIONS) throw ptyError("PTY_LIMIT", "Too many open PTY sessions (limit " + MAX_SESSIONS + ", including exited sessions that have not been closed); close some with close()");
    starting++;
    try {
      const exe = await ensureHelper(dataDir);
      const encoded = Buffer.from(commandLine, "utf8").toString("base64");
      if (exe.length + encoded.length + 32 > MAX_COMMAND_LINE) throw invalid("The command line is too long for CreateProcess (" + commandLine.length + " characters); write long scripts to a file and run that instead");

      const session = {
        id: crypto.randomUUID(),
        helper: null,
        helperPid: null,
        pid: null,
        commandLine: commandLine,
        cwd: cwd,
        cols: cols,
        rows: rows,
        label: label,
        startedAt: new Date().toISOString(),
        ring: new OutputRing(bufferCapacity()),
        readCursor: 0,
        childExited: false,
        ended: false,
        exitCode: null,
        helperExitCode: null,
        waiters: new Set(),
        resizeWaiters: [],
        stderrLines: [],
        startWaiter: null,
        startError: null,
        exitTimer: null,
        endTimer: null
      };

      const started = new Promise((resolve, reject) => { session.startWaiter = { resolve: resolve, reject: reject }; });
      started.catch(() => {});

      let helper;
      try {
        helper = spawn(exe, [String(cols), String(rows), encoded], { cwd: cwd, env: env, windowsHide: true, stdio: ["pipe", "pipe", "pipe"] });
      } catch (error) {
        throw ptyError("PTY_START_FAILED", "Failed to launch the ConPTY helper: " + error.message);
      }
      session.helper = helper;
      session.helperPid = helper.pid || null;
      helper.stdin.on("error", () => {});
      helper.stdout.on("error", () => {});
      helper.stderr.on("error", () => {});
      helper.stdout.on("data", chunk => {
        session.ring.append(chunk);
        notify(session);
      });
      const events = readline.createInterface({ input: helper.stderr, crlfDelay: Infinity, terminal: false });
      events.on("line", line => {
        const text = line.trim();
        if (!text) return;
        let event = null;
        if (text.startsWith("{")) { try { event = JSON.parse(text); } catch { event = null; } }
        if (event && typeof event === "object" && typeof event.event === "string") handleEvent(session, event);
        else pushStderr(session, text);
      });
      events.on("error", () => {});
      helper.once("error", error => {
        pushStderr(session, "helper process error: " + error.message);
        if (!session.startError) session.startError = "helper process error: " + error.message;
        markEnded(session);
      });
      helper.once("exit", code => {
        session.helperExitCode = code;
        // 'close' normally follows once stdout/stderr are drained; do not wait forever.
        session.endTimer = setTimeout(() => markEnded(session), 2000);
        session.endTimer.unref();
      });
      helper.once("close", code => {
        if (session.helperExitCode === null) session.helperExitCode = code;
        markEnded(session);
      });
      // Live sessions must not keep the host process alive on their own; when the host exits
      // the helper sees EOF on stdin and tears down the whole job.
      try { helper.unref(); } catch {}
      for (const stream of [helper.stdin, helper.stdout, helper.stderr]) {
        try { if (stream && typeof stream.unref === "function") stream.unref(); } catch {}
      }

      const timer = setTimeout(() => {
        if (session.startWaiter) {
          const waiter = session.startWaiter;
          session.startWaiter = null;
          waiter.reject(ptyError("PTY_START_FAILED", "Timed out after " + START_TIMEOUT_MS + " ms waiting for the PTY session to start" + (stderrText(session) ? ": " + stderrText(session) : "")));
        }
      }, START_TIMEOUT_MS);
      try {
        await started;
      } catch (error) {
        try { helper.kill(); } catch {}
        taskkillTree(session.helperPid).catch(() => {});
        throw error;
      } finally {
        clearTimeout(timer);
      }
      sessions.set(session.id, session);
      return {
        session_id: session.id,
        pid: session.pid,
        helper_pid: session.helperPid,
        command_line: session.commandLine,
        cwd: session.cwd,
        cols: session.cols,
        rows: session.rows,
        label: session.label,
        started_at: session.startedAt
      };
    } finally {
      starting--;
    }
  }

  async function read(args) {
    args = args || {};
    const session = getSession(args.session_id);
    const encoding = args.encoding === undefined || args.encoding === null ? "utf8" : args.encoding;
    if (encoding !== "utf8" && encoding !== "base64") throw invalid("encoding must be utf8 or base64");
    const maxBytes = boundedInt(args.max_bytes, 65536, 1, 4194304, "max_bytes");
    const waitMs = boundedInt(args.wait_ms, 0, 0, 60000, "wait_ms");
    const requested = args.cursor === undefined || args.cursor === null ? session.readCursor : boundedInt(args.cursor, 0, 0, Number.MAX_SAFE_INTEGER, "cursor");
    if (requested > session.ring.total) throw invalid("cursor " + requested + " is beyond total_bytes " + session.ring.total);
    if (waitMs > 0 && requested >= session.ring.total && !session.ended) {
      await waitUntil(session, () => requested < session.ring.total || session.ended, waitMs);
    }
    const ring = session.ring;
    let start = Math.max(requested, ring.oldest);
    let bytes = ring.read(start, maxBytes);
    if (encoding === "utf8") {
      if (start > requested) {
        // Output was evicted mid-stream; skip a partial leading character.
        let skip = 0;
        while (skip < 3 && skip < bytes.length - 1 && (bytes[skip] & 0xC0) === 0x80) skip++;
        if (skip > 0) { start += skip; bytes = bytes.subarray(skip); }
      }
      const complete = completeUtf8Length(bytes);
      if (complete > 0 && complete < bytes.length) bytes = bytes.subarray(0, complete);
    }
    const next = start + bytes.length;
    session.readCursor = next;
    let data = encoding === "base64" ? bytes.toString("base64") : bytes.toString("utf8");
    if (args.strip_ansi === true && encoding === "utf8") data = stripAnsi(data);
    return {
      session_id: session.id,
      cursor: start,
      next_cursor: next,
      oldest_cursor: ring.oldest,
      total_bytes: ring.total,
      bytes: bytes.length,
      dropped_bytes: start - requested,
      data: data,
      encoding: encoding,
      exited: session.ended,
      exit_code: session.ended ? session.exitCode : null
    };
  }

  async function write(args) {
    args = args || {};
    const session = getSession(args.session_id);
    if (typeof args.data !== "string") throw invalid("data must be a string");
    const encoding = args.encoding === undefined || args.encoding === null ? "utf8" : args.encoding;
    if (encoding !== "utf8" && encoding !== "base64") throw invalid("encoding must be utf8 or base64");
    const bytes = encoding === "base64" ? Buffer.from(args.data, "base64") : Buffer.from(args.data, "utf8");
    if (bytes.length > MAX_WRITE_BYTES) throw invalid("data is " + bytes.length + " bytes; at most " + MAX_WRITE_BYTES + " bytes may be written per call");
    if (session.childExited || session.ended) throw ptyError("PTY_EXITED", "The PTY session has exited (exit code " + session.exitCode + ")");
    for (let offset = 0; offset < bytes.length; offset += WRITE_CHUNK_BYTES) {
      await sendControl(session, "w " + bytes.subarray(offset, offset + WRITE_CHUNK_BYTES).toString("base64"));
    }
    return { session_id: session.id, bytes_written: bytes.length };
  }

  async function resize(args) {
    args = args || {};
    const session = getSession(args.session_id);
    if (args.cols === undefined || args.rows === undefined) throw invalid("cols and rows are required");
    const cols = boundedInt(args.cols, 120, 20, 500, "cols");
    const rows = boundedInt(args.rows, 30, 5, 300, "rows");
    if (session.childExited || session.ended) throw ptyError("PTY_EXITED", "The PTY session has exited");
    let waiter;
    const acknowledged = new Promise((resolve, reject) => { waiter = { resolve: resolve, reject: reject }; });
    acknowledged.catch(() => {});
    session.resizeWaiters.push(waiter);
    try {
      await sendControl(session, "r " + cols + " " + rows);
    } catch (error) {
      const index = session.resizeWaiters.indexOf(waiter);
      if (index >= 0) session.resizeWaiters.splice(index, 1);
      throw error;
    }
    let timer;
    const timeout = new Promise((resolve, reject) => {
      timer = setTimeout(() => reject(ptyError("PTY_TIMEOUT", "Timed out waiting for the PTY helper to acknowledge the resize")), RESIZE_TIMEOUT_MS);
    });
    try {
      await Promise.race([acknowledged, timeout]);
    } finally {
      clearTimeout(timer);
    }
    return { session_id: session.id, cols: cols, rows: rows, applied: true };
  }

  async function signal(args) {
    args = args || {};
    const session = getSession(args.session_id);
    const name = args.signal;
    if (!SIGNALS.includes(name)) throw invalid("signal must be one of " + SIGNALS.join(", "));
    if (session.childExited || session.ended) throw ptyError("PTY_EXITED", "The PTY session has exited");
    if (name === "SIGINT" || name === "SIGQUIT" || name === "SIGBREAK") {
      // ConPTY turns ETX into CTRL_C_EVENT for the attached processes. There is no way to
      // inject CTRL_BREAK_EVENT through terminal input, so SIGBREAK/SIGQUIT are sent as Ctrl+C.
      const before = session.ring.total;
      await sendControl(session, "w " + Buffer.from([3]).toString("base64"));
      // While the console processes Ctrl+C it discards pending input, so keystrokes sent
      // immediately afterwards would be lost. Give the interrupt a moment to land (until the
      // program reacts with output, bounded) before letting the caller type again.
      await waitUntil(session, () => session.ring.total > before || session.childExited || session.ended, CTRL_C_SETTLE_MS);
      await sleep(CTRL_C_GRACE_MS);
      return { session_id: session.id, signal: name, delivered: true, method: "ctrl_c" };
    }
    await terminate(session, CLOSE_TIMEOUT_MS);
    return { session_id: session.id, signal: name, delivered: true, method: "terminate" };
  }

  async function close(args) {
    args = args || {};
    const session = getSession(args.session_id);
    sessions.delete(session.id);
    if (!session.ended) {
      sendControl(session, "k").catch(() => {});
      try { session.helper.stdin.end(); } catch {}
      if (!(await waitUntil(session, () => session.ended, CLOSE_TIMEOUT_MS))) {
        await taskkillTree(session.helperPid);
        if (!(await waitUntil(session, () => session.ended, 3000))) {
          try { session.helper.kill(); } catch {}
          markEnded(session);
        }
      }
    }
    notify(session);
    return { session_id: session.id, closed: true, exit_code: session.exitCode, exited: session.ended, total_bytes: session.ring.total };
  }

  function list() {
    const items = Array.from(sessions.values()).map(describe);
    items.sort((a, b) => a.started_at < b.started_at ? -1 : a.started_at > b.started_at ? 1 : 0);
    return { sessions: items, count: items.length };
  }

  async function closeAll() {
    const ids = Array.from(sessions.keys());
    await Promise.all(ids.map(id => close({ session_id: id }).catch(() => null)));
    return ids.length;
  }

  return { start: start, read: read, write: write, resize: resize, signal: signal, close: close, list: list, closeAll: closeAll, available: available };
}
