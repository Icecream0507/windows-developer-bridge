#!/usr/bin/env node
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import fsp from "node:fs/promises";
import crypto from "node:crypto";
import readline from "node:readline";
import { spawn, spawnSync } from "node:child_process";
import { isCodexPatch, applyCodexPatch } from "./lib/patch.mjs";

const VERSION = "0.3.0";
const IS_WIN = process.platform === "win32";
const HOME = os.homedir();
const DATA_DIR = process.env.WDB_DATA_DIR || (process.env.LOCALAPPDATA ? path.join(process.env.LOCALAPPDATA, "WindowsDeveloperBridge") : path.join(HOME, ".windows-developer-bridge"));
const JOB_DIR = path.join(DATA_DIR, "jobs");
const UNLOCK_FILE = path.join(DATA_DIR, "FULL_ACCESS_ENABLED");
const AUDIT_LOG = path.join(DATA_DIR, "audit.jsonl");
const AUDIT_MAX_BYTES = 10 * 1024 * 1024;
const DEFAULT_TIMEOUT = 600000;
const JOB_RETENTION_MS = 14 * 24 * 60 * 60 * 1000;
const CODEX_BIN = process.env.CODEX_BIN || "codex";
const SUPPORTED_PROTOCOLS = ["2025-11-25", "2025-06-18", "2025-03-26", "2024-11-05"];
const PS_FLAGS = ["-NoLogo", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass"];
// Runs before every script: UTF-8 console I/O (Windows PowerShell 5.1 defaults to the OEM code page),
// a wide buffer so errors are not hard-wrapped at 120 columns, and no progress-bar noise.
const PS_PROLOGUE = [
  "try { $__wdbUtf8 = New-Object System.Text.UTF8Encoding $false; [Console]::OutputEncoding = $__wdbUtf8; [Console]::InputEncoding = $__wdbUtf8; $OutputEncoding = $__wdbUtf8 } catch {}",
  "try { $Host.UI.RawUI.BufferSize = New-Object System.Management.Automation.Host.Size(250, 3000) } catch {}",
  "$ProgressPreference = 'SilentlyContinue'",
].join("\r\n") + "\r\n";
const jobs = new Map();
const activeChildren = new Set();
const revokedChildren = new WeakSet();
let ptyManagerPromise = null;

function send(message) { process.stdout.write(JSON.stringify(message) + "\n"); }
function ok(id, result) { if (id !== undefined) send({ jsonrpc: "2.0", id: id, result: result }); }
function fail(id, code, message) { if (id !== undefined) send({ jsonrpc: "2.0", id: id, error: { code: code, message: message } }); }
function textResult(value) {
  const content = typeof value === "string" ? value : JSON.stringify(value, null, 2);
  const result = { content: [{ type: "text", text: content }] };
  if (value && typeof value === "object" && !Array.isArray(value)) result.structuredContent = value;
  return result;
}
function toolError(message, code) { return Object.assign(new Error(message), { code: code }); }
function tool(name, title, description, properties, required, annotations) {
  return { name: name, title: title, description: description, inputSchema: { type: "object", properties: properties || {}, required: required || [], additionalProperties: false }, annotations: Object.assign({ title: title, readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false }, annotations || {}) };
}
const str = (description, extra) => Object.assign({ type: "string" }, description ? { description: description } : {}, extra || {});
const int = (minimum, maximum, description) => Object.assign({ type: "integer", minimum: minimum, maximum: maximum }, description ? { description: description } : {});
const bool = description => Object.assign({ type: "boolean" }, description ? { description: description } : {});
const envSchema = { type: "object", additionalProperties: { type: ["string", "number", "boolean", "null"] }, description: "Environment overrides; null removes a variable." };
const cwdSchema = str("Working directory (absolute path or ~). Defaults to the user's home directory.");
const sessionId = str("pty session_id returned by pty_start.");
const TOOLS = [
  tool("bridge_status", "Bridge status", "Report the Windows host, PowerShell/Git/Codex availability, data paths, full-access lock state, running jobs and terminal sessions. Always available, even while locked.", {}, [], { readOnlyHint: true, idempotentHint: true }),
  tool("shell_exec", "Run PowerShell", "Run PowerShell source as the logged-in Windows user and wait for it to finish. Uses PowerShell 7 (pwsh) when installed, otherwise Windows PowerShell 5.1. Output is UTF-8. exitCode follows `exit N` or the last native command's exit code. Read piped input with [Console]::In.ReadToEnd(). For long-running servers use shell_start; for interactive programs use pty_start.", { command: str("PowerShell source to execute (multi-line allowed)."), cwd: cwdSchema, env: envSchema, stdin: str("Text written to the process's standard input."), timeout_ms: int(0, 1800000, "Kill the process tree after this many ms (default 600000; 0 = no limit)."), max_output_bytes: int(1024, 64000000, "Per-stream capture limit (default 1048576). When exceeded the head and tail are kept.") }, ["command"], { destructiveHint: true, openWorldHint: true }),
  tool("shell_start", "Start background job", "Start PowerShell source as a detached background job (dev servers, builds, watchers). Output is written to persistent log files; poll with shell_job_status. Jobs survive bridge restarts and record their exit code.", { command: str("PowerShell source to execute."), cwd: cwdSchema, env: envSchema, label: { type: "string", maxLength: 100, description: "Short human-readable name." } }, ["command"], { destructiveHint: true, openWorldHint: true }),
  tool("shell_job_status", "Background job status", "Inspect a background job: state, exit code and stdout/stderr. By default returns the log tails; pass stdout_offset/stderr_offset (from the previous call's next offsets) to page through output incrementally. wait_ms blocks until the job finishes or the wait elapses.", { job_id: str(), max_log_bytes: int(1024, 8000000, "Max bytes returned per stream (default 100000)."), stdout_offset: int(0, Number.MAX_SAFE_INTEGER), stderr_offset: int(0, Number.MAX_SAFE_INTEGER), wait_ms: int(0, 120000, "Wait up to this long for the job to exit (default 0).") }, ["job_id"], { readOnlyHint: true, idempotentHint: true }),
  tool("shell_job_list", "List background jobs", "List background jobs (newest first) with their current state and exit code.", { include_finished: bool("Include exited/terminated jobs (default true)."), limit: int(1, 1000, "Maximum jobs returned (default 100).") }, [], { readOnlyHint: true, idempotentHint: true }),
  tool("shell_job_kill", "Stop background job", "Terminate a background job and its whole process tree (taskkill /T /F). On Windows every signal is a forced termination.", { job_id: str(), signal: { type: "string", enum: ["SIGTERM", "SIGKILL", "SIGINT", "SIGHUP"] } }, ["job_id"], { destructiveHint: true }),
  tool("fs_read", "Read file", "Read a file with byte-offset pagination (UTF-8 text or base64). UTF-8 pages never split a character; continue with offset = nextOffset while truncated is true.", { path: str("Absolute path or ~-relative path."), encoding: { type: "string", enum: ["utf8", "base64"] }, offset: int(0, Number.MAX_SAFE_INTEGER), max_bytes: int(1, 64000000, "Default 1000000.") }, ["path"], { readOnlyHint: true, idempotentHint: true }),
  tool("fs_write", "Write file", "Create or replace a file (atomic by default; parent directories are created) or append to it.", { path: str(), content: str("File content (UTF-8 text, or base64 when encoding=base64)."), encoding: { type: "string", enum: ["utf8", "base64"] }, append: bool(), atomic: bool("Write to a temp file and rename over the target (default true)."), create_parents: bool("Create missing parent directories (default true)."), mode: int(0, 4095, "POSIX mode; on Windows only the owner-write bit is honoured (read-only attribute).") }, ["path", "content"], { destructiveHint: true }),
  tool("fs_list", "List directory", "List a directory, optionally recursively (bounded). Directory symlinks/junctions are reported but not traversed.", { path: str(), recursive: bool(), include_hidden: bool("Include dot-files (default true)."), max_entries: int(1, 100000, "Default 5000."), max_depth: int(0, 100, "Default 10.") }, ["path"], { readOnlyHint: true, idempotentHint: true }),
  tool("fs_stat", "Stat path", "Return metadata about a path without following a final symlink. Reports exists=false instead of failing when the path is missing.", { path: str() }, ["path"], { readOnlyHint: true, idempotentHint: true }),
  tool("fs_manage", "Manage files", "mkdir, remove, move, copy, chmod or symlink. copy/move create the destination's parent directories; force replaces an existing destination. Directory symlinks are created as junctions on Windows.", { operation: { type: "string", enum: ["mkdir", "remove", "move", "copy", "chmod", "symlink"] }, path: str("Source path (for symlink: the link to create)."), destination: str("Destination path (for symlink: the link target)."), recursive: bool("Required to remove or copy a non-empty directory; mkdir -p semantics."), force: bool(), mode: int(0, 4095) }, ["operation", "path"], { destructiveHint: true }),
  tool("apply_patch", "Apply patch", "Apply a patch to files under cwd. Accepts the Codex/OpenAI '*** Begin Patch' format (Add File / Update File / Delete File / Move to, applied natively and atomically) or a unified git diff (applied with git apply). Paths in the patch are relative to cwd.", { patch: str("Patch text."), cwd: str("Directory the patch paths are relative to (default home)."), check_only: bool("Validate without writing."), reverse: bool("Unified diffs only."), three_way: bool("Unified diffs only (git apply --3way).") }, ["patch"], { destructiveHint: true }),
  tool("pty_start", "Start terminal", "Start an interactive terminal session backed by a real Windows ConPTY. Omit command and argv for an interactive PowerShell; pass command (PowerShell source) or argv ([exe, ...args]) to run a program (REPLs, ssh, installers, TUI apps). Read output with pty_read, send keystrokes with pty_write (use \\r for Enter).", { command: str("PowerShell source to run inside the terminal."), argv: { type: "array", items: { type: "string" }, minItems: 1, description: "Executable and arguments, run directly." }, cwd: cwdSchema, env: envSchema, cols: int(20, 500, "Default 120."), rows: int(5, 300, "Default 30."), label: { type: "string", maxLength: 100 } }, [], { destructiveHint: true, openWorldHint: true }),
  tool("pty_read", "Read terminal", "Read terminal output by absolute byte cursor. Omit cursor to continue after the previous read. wait_ms long-polls for new output. strip_ansi removes VT escape sequences from the returned text.", { session_id: sessionId, cursor: int(0, Number.MAX_SAFE_INTEGER), max_bytes: int(1, 4194304, "Default 65536."), wait_ms: int(0, 60000, "Default 0."), encoding: { type: "string", enum: ["utf8", "base64"] }, strip_ansi: bool() }, ["session_id"], { readOnlyHint: true }),
  tool("pty_write", "Write to terminal", "Send input to a terminal session exactly as given (\\r = Enter, \\u0003 = Ctrl+C, \\u001b[A = Up).", { session_id: sessionId, data: str("Input to send."), encoding: { type: "string", enum: ["utf8", "base64"] } }, ["session_id", "data"], { destructiveHint: true }),
  tool("pty_resize", "Resize terminal", "Resize a terminal session's pseudo console.", { session_id: sessionId, cols: int(20, 500), rows: int(5, 300) }, ["session_id", "cols", "rows"], { idempotentHint: true }),
  tool("pty_signal", "Signal terminal", "SIGINT/SIGQUIT/SIGBREAK send Ctrl+C to the foreground program; SIGTERM/SIGKILL/SIGHUP terminate the session's whole process tree.", { session_id: sessionId, signal: { type: "string", enum: ["SIGINT", "SIGTERM", "SIGKILL", "SIGHUP", "SIGQUIT", "SIGBREAK"] } }, ["session_id"], { destructiveHint: true }),
  tool("pty_close", "Close terminal", "Terminate a terminal session (whole process tree) and release it. Its output can no longer be read afterwards.", { session_id: sessionId }, ["session_id"], { destructiveHint: true }),
  tool("pty_list", "List terminals", "List open terminal sessions.", {}, [], { readOnlyHint: true, idempotentHint: true }),
  tool("codex_thread_read", "Read Codex thread", "Read a stored Codex thread through the Codex app-server without resuming it or starting a model turn.", { thread_id: str(), include_turns: bool(), timeout_ms: int(1000, 120000) }, ["thread_id"], { readOnlyHint: true, idempotentHint: true }),
  tool("codex_thread_list", "List Codex threads", "Page through stored Codex threads without resuming them or starting model turns.", {
    limit: int(1, 200), cursor: str(), search_term: str(), cwd: str(), archived: bool(), is_pinned: bool(),
    use_state_db_only: bool(), model_providers: { type: "array", items: { type: "string" } },
    source_kinds: { type: "array", items: { type: "string", enum: ["cli", "vscode", "exec", "appServer", "subAgent", "subAgentReview", "subAgentCompact", "subAgentThreadSpawn", "subAgentOther", "unknown"] } },
    sort_key: { type: "string", enum: ["created_at", "updated_at", "recency_at"] }, sort_direction: { type: "string", enum: ["asc", "desc"] }, timeout_ms: int(1000, 120000)
  }, [], { readOnlyHint: true, idempotentHint: true }),
  tool("codex_thread_turns_list", "List Codex turns", "Page persisted turns of a stored Codex thread without resuming it or starting a model turn.", {
    thread_id: str(), limit: int(1, 200), cursor: str(), sort_direction: { type: "string", enum: ["asc", "desc"] },
    items_view: { type: "string", enum: ["notLoaded", "summary", "full"] }, timeout_ms: int(1000, 120000)
  }, ["thread_id"], { readOnlyHint: true, idempotentHint: true }),
  tool("audit_tail", "Audit log", "Read the bounded tail of the local JSONL audit log (tool names, argument keys and hashes; never raw arguments).", { max_bytes: int(1024, 8000000) }, [], { readOnlyHint: true, idempotentHint: true })
];
const TOOL_MAP = new Map(TOOLS.map(item => [item.name, item]));

function typeMatches(type, value) {
  switch (type) {
    case "string": return typeof value === "string";
    case "integer": return Number.isSafeInteger(value);
    case "number": return typeof value === "number" && Number.isFinite(value);
    case "boolean": return typeof value === "boolean";
    case "null": return value === null;
    case "array": return Array.isArray(value);
    case "object": return Boolean(value) && typeof value === "object" && !Array.isArray(value);
    default: return true;
  }
}
function checkValue(name, schema, value) {
  const types = Array.isArray(schema.type) ? schema.type : [schema.type];
  if (!types.some(type => typeMatches(type, value))) throw toolError(name + " must be " + types.join(" or "), "INVALID_ARGUMENT");
  if (schema.enum && !schema.enum.includes(value)) throw toolError(name + " must be one of: " + schema.enum.join(", "), "INVALID_ARGUMENT");
  if (typeof value === "number" && ((schema.minimum !== undefined && value < schema.minimum) || (schema.maximum !== undefined && value > schema.maximum))) throw toolError(name + " must be between " + schema.minimum + " and " + schema.maximum, "INVALID_ARGUMENT");
  if (typeof value === "string" && schema.maxLength !== undefined && value.length > schema.maxLength) throw toolError(name + " must be at most " + schema.maxLength + " characters", "INVALID_ARGUMENT");
  if (Array.isArray(value)) {
    if (schema.minItems !== undefined && value.length < schema.minItems) throw toolError(name + " must contain at least " + schema.minItems + " item(s)", "INVALID_ARGUMENT");
    if (schema.items) value.forEach((item, index) => checkValue(name + "[" + index + "]", schema.items, item));
  }
  if (types.includes("object") && schema.additionalProperties && typeof schema.additionalProperties === "object" && value && typeof value === "object") {
    for (const [key, item] of Object.entries(value)) checkValue(name + "." + key, schema.additionalProperties, item);
  }
}
// Validates against the advertised schema. Optional arguments sent as null are treated as omitted,
// because several MCP clients fill unused optional fields with null.
function validateArgs(definition, input) {
  const props = definition.inputSchema.properties, args = {};
  for (const [key, value] of Object.entries(input)) {
    if (!Object.prototype.hasOwnProperty.call(props, key)) throw toolError("Unknown argument \"" + key + "\" for " + definition.name + ". Allowed: " + (Object.keys(props).join(", ") || "(none)"), "INVALID_ARGUMENT");
    if (value === null && !definition.inputSchema.required.includes(key)) continue;
    checkValue(key, props[key], value);
    args[key] = value;
  }
  for (const key of definition.inputSchema.required) if (args[key] === undefined) throw toolError("Missing required argument \"" + key + "\" for " + definition.name, "INVALID_ARGUMENT");
  return args;
}

function resolvePath(input) {
  if (typeof input !== "string" || !input.trim()) throw toolError("path must be a non-empty string", "INVALID_ARGUMENT");
  let value = input.trim();
  if (value === "~") value = HOME;
  else if (value.startsWith("~/") || value.startsWith("~\\")) value = path.join(HOME, value.slice(2));
  return path.resolve(value);
}
async function existingDir(input) {
  const dir = resolvePath(input === undefined ? HOME : input);
  let stat;
  try { stat = await fsp.stat(dir); } catch { throw toolError("cwd does not exist: " + dir, "INVALID_CWD"); }
  if (!stat.isDirectory()) throw toolError("cwd is not a directory: " + dir, "INVALID_CWD");
  return dir;
}
function boundedInt(value, fallback, min, max, name) {
  if (value === undefined) return fallback;
  if (!Number.isSafeInteger(value) || value < min || value > max) throw toolError(name + " must be an integer between " + min + " and " + max, "INVALID_ARGUMENT");
  return value;
}
function requireWindows(name) {
  if (!IS_WIN) throw toolError(name + " requires Windows; current platform is " + process.platform + ". Windows integration tests must run on Windows.", "UNSUPPORTED_PLATFORM");
}
function redact(value) {
  return String(value).replace(/(token|secret|password|api[_-]?key)(\s*[:=]\s*)[^\s,;]+/gi, "$1$2[REDACTED]");
}
async function audit(event, details) {
  await fsp.mkdir(DATA_DIR, { recursive: true });
  const record = { at: new Date().toISOString(), event: event, pid: process.pid, details: redact(JSON.stringify(details || {})).slice(0, 4000) };
  try { if ((await fsp.stat(AUDIT_LOG)).size > AUDIT_MAX_BYTES) await fsp.rename(AUDIT_LOG, AUDIT_LOG + ".1"); } catch {}
  await fsp.appendFile(AUDIT_LOG, JSON.stringify(record) + "\n", { encoding: "utf8", mode: 0o600 });
}
function envFor(overrides) {
  const env = Object.assign({}, process.env);
  for (const [key, value] of Object.entries(overrides || {})) {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) throw toolError("Invalid environment variable name: " + key, "INVALID_ARGUMENT");
    // Windows environment names are case-insensitive; drop differently-cased duplicates first.
    if (IS_WIN) for (const existing of Object.keys(env)) if (existing !== key && existing.toLowerCase() === key.toLowerCase()) delete env[existing];
    if (value === null) delete env[key]; else env[key] = String(value);
  }
  return env;
}
function isFile(file) { try { return fs.statSync(file).isFile(); } catch { return false; } }
const whichCache = new Map();
function which(name) {
  if (whichCache.has(name)) return whichCache.get(name);
  let found = null;
  if (path.isAbsolute(name)) found = isFile(name) ? name : null;
  else {
    const exts = IS_WIN ? (path.extname(name) ? [""] : String(process.env.PATHEXT || ".COM;.EXE;.BAT;.CMD").split(";").filter(Boolean)) : [""];
    const dirs = String(process.env.PATH || process.env.Path || "").split(path.delimiter).filter(Boolean).map(dir => dir.replace(/^"(.*)"$/, "$1"));
    outer: for (const dir of dirs) for (const ext of exts) { const candidate = path.join(dir, name + ext); if (isFile(candidate)) { found = candidate; break outer; } }
  }
  whichCache.set(name, found);
  return found;
}
let powershellCache = null;
function resolvePowerShell() {
  if (powershellCache && isFile(powershellCache.file)) return powershellCache;
  const candidates = [];
  const configured = process.env.WDB_POWERSHELL && process.env.WDB_POWERSHELL.trim();
  if (configured) candidates.push({ file: path.isAbsolute(configured) ? configured : which(configured), source: "WDB_POWERSHELL" });
  if (IS_WIN) {
    candidates.push({ file: which("pwsh.exe"), source: "PATH" });
    candidates.push({ file: path.join(process.env.ProgramFiles || "C:\\Program Files", "PowerShell", "7", "pwsh.exe"), source: "ProgramFiles" });
    candidates.push({ file: path.join(process.env.SystemRoot || process.env.WINDIR || "C:\\Windows", "System32", "WindowsPowerShell", "v1.0", "powershell.exe"), source: "Windows PowerShell 5.1" });
  } else candidates.push({ file: which("pwsh"), source: "PATH" });
  for (const candidate of candidates) {
    if (candidate.file && isFile(candidate.file)) {
      powershellCache = { file: candidate.file, kind: /pwsh(\.exe)?$/i.test(candidate.file) ? "pwsh" : "powershell", source: candidate.source };
      return powershellCache;
    }
  }
  throw toolError("No PowerShell executable found. Install PowerShell 7 or set WDB_POWERSHELL to powershell.exe/pwsh.exe.", "SHELL_NOT_FOUND");
}
function psQuote(value) { return "'" + String(value).replace(/'/g, "''") + "'"; }
// The user's source runs as its own script file (so `exit N` and line numbers behave normally);
// the wrapper normalises the exit code and, for background jobs, persists it.
function psWrapper(userScript, exitFile, pidFile) {
  return "\ufeff" + (pidFile ? "try { [System.IO.File]::WriteAllText(" + psQuote(pidFile) + ", [string]$PID) } catch {}\r\n" : "") + PS_PROLOGUE +
    "$global:LASTEXITCODE = $null\r\n$__wdbCode = 0\r\n" +
    "try { & " + psQuote(userScript) + "; if ($global:LASTEXITCODE -is [int]) { $__wdbCode = $global:LASTEXITCODE } }\r\n" +
    "catch { [Console]::Error.WriteLine(($_ | Out-String)); $__wdbCode = 1 }\r\n" +
    (exitFile ? "finally { try { [System.IO.File]::WriteAllText(" + psQuote(exitFile) + ", [string]$__wdbCode) } catch {} }\r\n" : "") +
    "exit $__wdbCode\r\n";
}
function boundedCapture(maxBytes) {
  const headMax = Math.floor(maxBytes / 2), tailMax = maxBytes - headMax;
  const head = [], tail = [];
  let headLength = 0, tailLength = 0, total = 0;
  return {
    push(chunk) {
      total += chunk.length;
      if (headLength < headMax) {
        const take = chunk.subarray(0, headMax - headLength);
        head.push(take); headLength += take.length; chunk = chunk.subarray(take.length);
      }
      if (!chunk.length) return;
      tail.push(chunk); tailLength += chunk.length;
      while (tailLength - tail[0].length >= tailMax) tailLength -= tail.shift().length;
    },
    result() {
      const headBuf = Buffer.concat(head);
      let tailBuf = Buffer.concat(tail);
      if (tailBuf.length > tailMax) tailBuf = tailBuf.subarray(tailBuf.length - tailMax);
      const omitted = total - headBuf.length - tailBuf.length;
      const text = omitted > 0 ? headBuf.toString("utf8") + "\n...[" + omitted + " bytes omitted]...\n" + tailBuf.toString("utf8") : Buffer.concat([headBuf, tailBuf]).toString("utf8");
      return { text: text, bytes: total, truncated: omitted > 0 };
    },
  };
}
// Console tools such as taskkill print in the OEM code page (e.g. 936/GBK on Chinese Windows).
let oemDecoder = null;
function decodeOem(buffer) {
  if (!oemDecoder) {
    const names = { 936: "gbk", 950: "big5", 932: "shift_jis", 949: "euc-kr", 866: "ibm866", 65001: "utf-8" };
    let page = null;
    if (IS_WIN) { try { page = Number((spawnSync("cmd.exe", ["/d", "/c", "chcp"], { encoding: "latin1", windowsHide: true }).stdout.match(/(\d+)\s*$/) || [])[1]); } catch {} }
    try { oemDecoder = new TextDecoder(names[page] || "utf-8"); } catch { oemDecoder = new TextDecoder("utf-8"); }
  }
  return oemDecoder.decode(buffer);
}
function killTree(pid) {
  return new Promise(resolve => {
    if (!pid) return resolve({ code: null, stdout: "", stderr: "no pid" });
    const killer = spawn("taskkill.exe", ["/PID", String(pid), "/T", "/F"], { windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
    const stdout = [], stderr = [];
    killer.stdout.on("data", chunk => stdout.push(chunk)); killer.stderr.on("data", chunk => stderr.push(chunk));
    killer.once("error", error => resolve({ code: null, stdout: "", stderr: error.message }));
    killer.once("close", code => resolve({ code: code, stdout: decodeOem(Buffer.concat(stdout)).trim(), stderr: decodeOem(Buffer.concat(stderr)).trim() }));
  });
}
function pidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); return true; } catch (error) { return error.code === "EPERM"; }
}
async function runPowerShell(args) {
  requireWindows("shell_exec");
  const cwd = await existingDir(args.cwd), timeout = boundedInt(args.timeout_ms, DEFAULT_TIMEOUT, 0, 1800000, "timeout_ms");
  const max = boundedInt(args.max_output_bytes, 1048576, 1024, 64000000, "max_output_bytes");
  const ps = resolvePowerShell(), env = envFor(args.env);
  const tempDir = await fsp.mkdtemp(path.join(os.tmpdir(), "wdb-ps-"));
  const userScript = path.join(tempDir, "command.ps1"), wrapper = path.join(tempDir, "run.ps1");
  await fsp.writeFile(userScript, "\ufeff" + args.command, "utf8");
  await fsp.writeFile(wrapper, psWrapper(userScript), "utf8");
  const stdout = boundedCapture(max), stderr = boundedCapture(max);
  let child, timedOut = false, settled = false, timer;
  const started = Date.now();
  try {
    child = spawn(ps.file, [...PS_FLAGS, "-File", wrapper], { cwd: cwd, env: env, windowsHide: true, stdio: ["pipe", "pipe", "pipe"] });
    activeChildren.add(child);
    child.stdout.on("data", chunk => stdout.push(chunk));
    child.stderr.on("data", chunk => stderr.push(chunk));
    child.stdin.on("error", () => {});
    const finished = new Promise((resolve, reject) => {
      child.once("error", error => { activeChildren.delete(child); reject(error); });
      child.once("close", (code, signal) => { settled = true; activeChildren.delete(child); resolve({ exitCode: code, signal: signal }); });
    });
    child.stdin.end(args.stdin === undefined ? "" : args.stdin, "utf8");
    if (timeout > 0) timer = setTimeout(() => {
      if (settled) return;
      timedOut = true;
      killTree(child.pid).then(result => { if (result.code !== 0) try { child.kill(); } catch {} });
    }, timeout);
    const exit = await finished;
    const out = stdout.result(), err = stderr.result();
    return { command: args.command, cwd: cwd, shell: ps.file, exitCode: exit.exitCode, signal: exit.signal, timedOut: timedOut, revoked: revokedChildren.has(child), durationMs: Date.now() - started, stdout: out.text, stderr: err.text, stdoutBytes: out.bytes, stderrBytes: err.bytes, outputTruncated: out.truncated || err.truncated };
  } finally {
    if (timer) clearTimeout(timer);
    await fsp.rm(tempDir, { recursive: true, force: true }).catch(() => {});
  }
}
async function ensureJobs() { await fsp.mkdir(JOB_DIR, { recursive: true }); }
async function fullAccessUnlocked() {
  try { const stat = await fsp.lstat(UNLOCK_FILE); return stat.isFile() && !stat.isSymbolicLink(); }
  catch (error) { if (error && error.code === "ENOENT") return false; throw error; }
}
async function ptyManager() {
  if (!ptyManagerPromise) {
    ptyManagerPromise = import("./lib/pty.mjs").then(module => module.createPtyManager({
      dataDir: DATA_DIR, homeDir: HOME, resolvePath: resolvePath, buildEnv: envFor,
      resolveShell: () => ({ file: resolvePowerShell().file }),
    }));
    ptyManagerPromise.catch(() => { ptyManagerPromise = null; });
  }
  return ptyManagerPromise;
}
async function revokeKnownJobs() {
  if (!IS_WIN) return;
  for (const child of activeChildren) {
    if (!child.pid) continue;
    revokedChildren.add(child);
    await killTree(child.pid);
  }
  if (ptyManagerPromise) await ptyManagerPromise.then(manager => manager.closeAll()).catch(() => {});
  await ensureJobs().catch(() => {});
  const names = await fsp.readdir(JOB_DIR).catch(() => []);
  for (const name of names.filter(item => item.endsWith(".json"))) {
    let meta;
    try { meta = JSON.parse(await fsp.readFile(path.join(JOB_DIR, name), "utf8")); } catch { continue; }
    if (meta.state !== "running" || !Number.isInteger(meta.pid) || meta.pid <= 0) continue;
    await killTree(meta.pid);
    meta.state = "revoked";
    meta.finishedAt = new Date().toISOString();
    await writeJob(meta).catch(() => {});
  }
}
async function requireFullAccess() {
  if (await fullAccessUnlocked()) return;
  await revokeKnownJobs();
  throw toolError("Full access is locked. Explicitly create " + UNLOCK_FILE + " on this Windows user profile (or run `wdb unlock`) to enable local command and filesystem tools.", "FULL_ACCESS_LOCKED");
}
function jobFile(id, suffix) { if (!/^[a-f0-9-]{8,80}$/i.test(id)) throw toolError("Invalid job_id", "INVALID_ARGUMENT"); return path.join(JOB_DIR, id + (suffix || ".json")); }
async function writeJob(meta) {
  await ensureJobs();
  const target = jobFile(meta.jobId), tmp = target + "." + crypto.randomBytes(4).toString("hex") + ".tmp";
  await fsp.writeFile(tmp, JSON.stringify(meta, null, 2), { mode: 0o600 });
  await renameWithRetry(tmp, target); jobs.set(meta.jobId, meta);
}
async function loadJob(id) {
  if (jobs.has(id)) return jobs.get(id);
  let meta;
  try { meta = JSON.parse(await fsp.readFile(jobFile(id), "utf8")); }
  catch (error) { if (error.code === "ENOENT") throw toolError("Unknown job_id: " + id, "JOB_NOT_FOUND"); throw error; }
  jobs.set(id, meta); return meta;
}
async function readExitFile(meta) {
  if (!meta.exitPath) return null;
  try {
    const [raw, stat] = await Promise.all([fsp.readFile(meta.exitPath, "utf8"), fsp.stat(meta.exitPath)]);
    const code = Number.parseInt(raw.trim(), 10);
    return Number.isInteger(code) ? { code: code, at: stat.mtime.toISOString() } : null;
  } catch { return null; }
}
async function refreshJob(meta) {
  if (meta.state !== "running") return meta;
  if (!meta.pid) {
    meta.pid = await readPidFile(meta);
    if (meta.pid) { delete meta.note; await writeJob(meta).catch(() => {}); }
    else if (Date.now() - Date.parse(meta.startedAt) < 60000) return meta;
  }
  let exit = await readExitFile(meta);
  if (!exit && meta.pid && pidAlive(meta.pid)) return meta;
  if (!exit) { await new Promise(resolve => setTimeout(resolve, 200)); exit = await readExitFile(meta); }
  if (exit) { meta.state = "exited"; meta.exitCode = exit.code; meta.finishedAt = meta.finishedAt || exit.at; }
  else if (!meta.pid || !pidAlive(meta.pid)) { meta.state = "exited"; meta.exitCode = meta.exitCode === undefined ? null : meta.exitCode; meta.finishedAt = meta.finishedAt || new Date().toISOString(); meta.note = "Process ended without recording an exit code (killed externally or crashed)."; }
  else return meta;
  await writeJob(meta).catch(() => {});
  return meta;
}
async function readLog(filename, offset, maxBytes) {
  let stat;
  try { stat = await fsp.stat(filename); } catch { return { content: "", size: 0, offset: offset || 0, nextOffset: offset || 0, truncated: false }; }
  const start = offset === undefined ? Math.max(0, stat.size - maxBytes) : Math.min(offset, stat.size);
  const length = Math.min(maxBytes, stat.size - start), handle = await fsp.open(filename, "r");
  try {
    const buffer = Buffer.alloc(length), result = await handle.read(buffer, 0, length, start);
    return { content: buffer.subarray(0, result.bytesRead).toString("utf8"), size: stat.size, offset: start, nextOffset: start + result.bytesRead, truncated: offset === undefined ? start > 0 : start + result.bytesRead < stat.size };
  } finally { await handle.close(); }
}
async function tailFile(filename, maxBytes) {
  const log = await readLog(filename, undefined, maxBytes);
  return { content: log.content, returnedBytes: Buffer.byteLength(log.content), truncated: log.truncated };
}
async function readPidFile(meta) {
  if (!meta.pidPath) return null;
  const pid = Number.parseInt(await fsp.readFile(meta.pidPath, "utf8").catch(() => ""), 10);
  return Number.isInteger(pid) && pid > 0 ? pid : null;
}
// Background jobs must outlive the bridge. libuv kills non-detached children when the bridge exits,
// and PowerShell started with `detached` (no console) exits immediately without running anything.
// So a short-lived cmd.exe (inside libuv's job, with a hidden console) runs `start /b`; the
// PowerShell it starts is outside that job, shares the hidden console and reports its own PID.
async function startJob(args) {
  requireWindows("shell_start");
  await ensureJobs();
  const cwd = await existingDir(args.cwd), env = envFor(args.env), ps = resolvePowerShell();
  const id = crypto.randomUUID();
  const stdoutPath = jobFile(id, ".stdout.log"), stderrPath = jobFile(id, ".stderr.log"), scriptPath = jobFile(id, ".command.ps1"), wrapperPath = jobFile(id, ".run.ps1"), exitPath = jobFile(id, ".exit"), pidPath = jobFile(id, ".pid");
  if (/["%]/.test(ps.file + JOB_DIR)) throw toolError("PowerShell or job directory path contains \" or %, which cmd.exe cannot launch safely: " + ps.file + " / " + JOB_DIR, "UNSUPPORTED_PATH");
  await fsp.writeFile(scriptPath, "\ufeff" + args.command, "utf8");
  await fsp.writeFile(wrapperPath, psWrapper(scriptPath, exitPath, pidPath), "utf8");
  const line = "start \"\" /b \"" + ps.file + "\" " + PS_FLAGS.join(" ") + " -File \"" + wrapperPath + "\" 1>\"" + stdoutPath + "\" 2>\"" + stderrPath + "\"";
  const cmd = path.join(process.env.SystemRoot || process.env.WINDIR || "C:\\Windows", "System32", "cmd.exe");
  const launcher = spawn(cmd, ["/d", "/s", "/c", "\"" + line + "\""], { cwd: cwd, env: env, windowsHide: true, windowsVerbatimArguments: true, stdio: "ignore" });
  const launched = await new Promise((resolve, reject) => { launcher.once("error", reject); launcher.once("exit", resolve); });
  if (launched !== 0) throw toolError("cmd.exe failed to launch the background job (exit " + launched + ")", "JOB_START_FAILED");
  const meta = { jobId: id, pid: null, label: String(args.label || args.command.split(/\r?\n/)[0].slice(0, 80)).slice(0, 100), command: redact(args.command).slice(0, 2000), cwd: cwd, shell: ps.file, stdoutPath: stdoutPath, stderrPath: stderrPath, exitPath: exitPath, pidPath: pidPath, startedAt: new Date().toISOString(), state: "running", exitCode: null };
  const deadline = Date.now() + 15000;
  while (!meta.pid && Date.now() < deadline) {
    meta.pid = await readPidFile(meta);
    if (!meta.pid) await new Promise(resolve => setTimeout(resolve, 50));
  }
  if (!meta.pid) {
    const stderr = (await readLog(stderrPath, 0, 4000)).content.trim();
    if (stderr) throw toolError("Background job failed to start: " + stderr, "JOB_START_FAILED");
    meta.note = "PowerShell has not reported its PID yet; shell_job_status will pick it up.";
  }
  await writeJob(meta);
  return { jobId: id, pid: meta.pid, label: meta.label, state: meta.state, cwd: cwd, shell: ps.file, stdoutPath: stdoutPath, stderrPath: stderrPath };
}
async function jobStatus(args) {
  const max = boundedInt(args.max_log_bytes, 100000, 1024, 8000000, "max_log_bytes"), wait = boundedInt(args.wait_ms, 0, 0, 120000, "wait_ms");
  let meta = await refreshJob(await loadJob(args.job_id));
  const deadline = Date.now() + wait;
  while (meta.state === "running" && Date.now() < deadline) {
    await new Promise(resolve => setTimeout(resolve, Math.min(250, Math.max(1, deadline - Date.now()))));
    meta = await refreshJob(meta);
  }
  const stdout = await readLog(meta.stdoutPath, args.stdout_offset, max), stderr = await readLog(meta.stderrPath, args.stderr_offset, max);
  return Object.assign({}, meta, { running: meta.state === "running", stdout: stdout.content, stderr: stderr.content, stdoutTruncated: stdout.truncated, stderrTruncated: stderr.truncated, stdoutSize: stdout.size, stderrSize: stderr.size, stdoutNextOffset: stdout.nextOffset, stderrNextOffset: stderr.nextOffset });
}
async function listJobs(args) {
  await ensureJobs();
  const includeFinished = args.include_finished !== false, limit = boundedInt(args.limit, 100, 1, 1000, "limit");
  const names = (await fsp.readdir(JOB_DIR)).filter(name => /^[a-f0-9-]+\.json$/i.test(name)), result = [];
  for (const name of names) {
    let meta;
    try { meta = jobs.get(name.slice(0, -5)) || JSON.parse(await fsp.readFile(path.join(JOB_DIR, name), "utf8")); } catch { continue; }
    meta = await refreshJob(meta);
    if (!includeFinished && meta.state !== "running") continue;
    result.push({ jobId: meta.jobId, pid: meta.pid, label: meta.label, state: meta.state, cwd: meta.cwd || null, startedAt: meta.startedAt, finishedAt: meta.finishedAt || null, exitCode: meta.exitCode === undefined ? null : meta.exitCode });
  }
  result.sort((a, b) => String(b.startedAt).localeCompare(String(a.startedAt)));
  return { jobs: result.slice(0, limit), count: Math.min(result.length, limit), total: result.length, running: result.filter(item => item.state === "running").length };
}
async function killJob(args) {
  const meta = await refreshJob(await loadJob(args.job_id));
  requireWindows("shell_job_kill");
  if (meta.state !== "running") return { jobId: meta.jobId, pid: meta.pid, killed: false, state: meta.state, exitCode: meta.exitCode, reason: "Job is not running" };
  if (!meta.pid) return { jobId: meta.jobId, killed: false, reason: "No recorded PID" };
  const result = await killTree(meta.pid);
  for (let i = 0; i < 30 && pidAlive(meta.pid); i++) await new Promise(resolve => setTimeout(resolve, 100));
  const killed = result.code === 0 || !pidAlive(meta.pid);
  if (killed) { meta.state = "terminated"; meta.finishedAt = new Date().toISOString(); await writeJob(meta); }
  return { jobId: meta.jobId, pid: meta.pid, killed: killed, state: meta.state, signal: args.signal || "SIGTERM", taskkill: result };
}
async function pruneJobs() {
  const names = await fsp.readdir(JOB_DIR).catch(() => []);
  const cutoff = Date.now() - JOB_RETENTION_MS;
  for (const name of names.filter(item => /^[a-f0-9-]+\.json$/i.test(item))) {
    try {
      const meta = JSON.parse(await fsp.readFile(path.join(JOB_DIR, name), "utf8"));
      if (meta.state === "running" || Date.parse(meta.finishedAt || meta.startedAt) > cutoff) continue;
      const id = name.slice(0, -5);
      for (const suffix of [".json", ".stdout.log", ".stderr.log", ".command.ps1", ".run.ps1", ".exit", ".pid"]) await fsp.rm(path.join(JOB_DIR, id + suffix), { force: true });
    } catch {}
  }
}
async function fileList(args) {
  const root = resolvePath(args.path), recursive = args.recursive === true, includeHidden = args.include_hidden !== false;
  const maxEntries = boundedInt(args.max_entries, 5000, 1, 100000, "max_entries"), maxDepth = boundedInt(args.max_depth, 10, 0, 100, "max_depth");
  const rootStat = await fsp.stat(root);
  if (!rootStat.isDirectory()) throw toolError("Not a directory: " + root + " (use fs_stat or fs_read for files)", "NOT_A_DIRECTORY");
  const entries = []; let truncated = false, skipped = 0;
  async function walk(dir, depth) {
    if (entries.length >= maxEntries) { truncated = true; return; }
    let names;
    try { names = await fsp.readdir(dir, { withFileTypes: true }); }
    catch (error) { if (dir === root) throw error; skipped++; return; }
    names.sort((a, b) => a.name.localeCompare(b.name));
    for (const item of names) {
      if (!includeHidden && item.name.startsWith(".")) continue;
      if (entries.length >= maxEntries) { truncated = true; return; }
      const fullPath = path.join(dir, item.name);
      let stat;
      try { stat = await fsp.lstat(fullPath); } catch { skipped++; continue; }
      const type = stat.isSymbolicLink() ? "symlink" : stat.isDirectory() ? "directory" : stat.isFile() ? "file" : "other";
      const entry = { name: item.name, path: fullPath, relativePath: path.relative(root, fullPath) || ".", type: type, size: stat.size, modifiedAt: stat.mtime.toISOString() };
      if (stat.isSymbolicLink()) entry.symlinkTarget = await fsp.readlink(fullPath).catch(() => null);
      entries.push(entry);
      if (recursive && type === "directory" && depth < maxDepth) await walk(fullPath, depth + 1);
    }
  }
  await walk(root, 0);
  return { root: root, entries: entries, count: entries.length, truncated: truncated, skippedUnreadable: skipped };
}
async function renameWithRetry(from, to) {
  // Antivirus scanners and indexers briefly lock freshly written files on Windows.
  for (let attempt = 0; ; attempt++) {
    try { return await fsp.rename(from, to); }
    catch (error) {
      if (!IS_WIN || attempt >= 6 || !["EPERM", "EACCES", "EBUSY"].includes(error.code)) throw error;
      await new Promise(resolve => setTimeout(resolve, 50 * (attempt + 1)));
    }
  }
}
async function setMode(target, mode) {
  if (IS_WIN) { await fsp.chmod(target, (mode & 0o200) ? 0o666 : 0o444); return "Windows only supports the read-only attribute; owner-write bit " + ((mode & 0o200) ? "set (writable)" : "cleared (read-only)"); }
  await fsp.chmod(target, mode);
  return null;
}
async function manageFs(args) {
  const target = resolvePath(args.path), dest = args.destination === undefined ? undefined : resolvePath(args.destination), recursive = args.recursive === true, force = args.force === true;
  let note = null;
  switch (args.operation) {
    case "mkdir": await fsp.mkdir(target, { recursive: recursive, ...(args.mode === undefined ? {} : { mode: args.mode }) }); break;
    case "remove": await fsp.rm(target, { recursive: recursive, force: force }); break;
    case "move":
      if (!dest) throw toolError("destination is required for move", "INVALID_ARGUMENT");
      await fsp.lstat(target);
      if (force) await fsp.rm(dest, { recursive: true, force: true });
      else if (await fsp.lstat(dest).then(() => true, () => false)) throw toolError("destination already exists: " + dest + " (pass force=true to replace it)", "EEXIST");
      await fsp.mkdir(path.dirname(dest), { recursive: true });
      try { await renameWithRetry(target, dest); }
      catch (error) {
        if (!error || error.code !== "EXDEV") throw error;
        const stat = await fsp.lstat(target);
        await fsp.cp(target, dest, { recursive: stat.isDirectory(), force: force, errorOnExist: !force, preserveTimestamps: true, verbatimSymlinks: true });
        await fsp.rm(target, { recursive: stat.isDirectory(), force: true });
      }
      break;
    case "copy": {
      if (!dest) throw toolError("destination is required for copy", "INVALID_ARGUMENT");
      const stat = await fsp.lstat(target);
      if (stat.isDirectory() && !recursive) throw toolError("Copying a directory requires recursive=true", "INVALID_ARGUMENT");
      if (force) await fsp.rm(dest, { recursive: true, force: true });
      await fsp.mkdir(path.dirname(dest), { recursive: true });
      await fsp.cp(target, dest, { recursive: recursive, force: force, errorOnExist: !force, preserveTimestamps: true, verbatimSymlinks: true }); break;
    }
    case "chmod":
      if (args.mode === undefined) throw toolError("mode is required for chmod", "INVALID_ARGUMENT");
      note = await setMode(target, args.mode); break;
    case "symlink": {
      if (!dest) throw toolError("destination (link target) is required for symlink", "INVALID_ARGUMENT");
      if (force) await fsp.rm(target, { recursive: false, force: true }).catch(async () => { await fsp.rmdir(target).catch(() => {}); });
      await fsp.mkdir(path.dirname(target), { recursive: true });
      let linkType = "file";
      if (IS_WIN) { try { if ((await fsp.stat(dest)).isDirectory()) linkType = "junction"; } catch {} }
      try { await fsp.symlink(dest, target, linkType); }
      catch (error) {
        if (IS_WIN && error.code === "EPERM") throw toolError("Creating file symlinks on Windows requires Developer Mode or administrator rights (directory links use junctions and work without them).", "EPERM");
        throw error;
      }
      note = linkType === "junction" ? "Directory link created as a junction" : null; break;
    }
    default: throw toolError("Unsupported operation: " + args.operation, "INVALID_ARGUMENT");
  }
  return { operation: args.operation, path: target, destination: dest || null, recursive: recursive, force: force, mode: args.mode === undefined ? null : args.mode, ...(note ? { note: note } : {}) };
}
function runGit(args, cwd, input) {
  return new Promise((resolve, reject) => {
    const child = spawn(which(IS_WIN ? "git.exe" : "git") || "git", args, { cwd: cwd, windowsHide: true, stdio: ["pipe", "pipe", "pipe"] });
    let stdout = "", stderr = "";
    child.stdout.on("data", chunk => stdout += chunk); child.stderr.on("data", chunk => stderr += chunk);
    child.stdin.on("error", () => {});
    child.once("error", error => reject(error.code === "ENOENT" ? toolError("git was not found on PATH. Install Git for Windows, or send the patch in '*** Begin Patch' format, which needs no git.", "GIT_NOT_FOUND") : error));
    child.once("close", code => resolve({ exitCode: code, stdout: stdout, stderr: stderr }));
    child.stdin.end(input);
  });
}
async function applyPatch(args) {
  const cwd = await existingDir(args.cwd);
  if (isCodexPatch(args.patch)) {
    if (args.reverse || args.three_way) throw toolError("reverse and three_way only apply to unified diffs", "INVALID_ARGUMENT");
    return applyCodexPatch(args.patch, { cwd: cwd, checkOnly: args.check_only === true });
  }
  const flags = ["apply", "--recount", "--whitespace=nowarn", "--verbose"];
  if (args.check_only) flags.push("--check"); if (args.reverse) flags.push("--reverse"); if (args.three_way) flags.push("--3way");
  const patch = args.patch.endsWith("\n") ? args.patch : args.patch + "\n";
  const result = await runGit(flags.concat(["-"]), cwd, patch);
  if (result.exitCode !== 0) throw toolError("git apply failed (exit " + result.exitCode + "): " + (result.stderr || result.stdout).trim(), "PATCH_FAILED");
  return { format: "unified", cwd: cwd, checkOnly: args.check_only === true, applied: args.check_only !== true, reverse: args.reverse === true, threeWay: args.three_way === true, exitCode: result.exitCode, stdout: result.stdout, stderr: result.stderr };
}

async function callCodexAppServer(method, params, timeoutMs) {
  const timeout = boundedInt(timeoutMs, 30000, 1000, 120000, "timeout_ms");
  const bin = path.isAbsolute(CODEX_BIN) ? CODEX_BIN : (which(CODEX_BIN) || CODEX_BIN);
  // npm installs codex as a .cmd shim, which Windows can only start through cmd.exe.
  const useShell = IS_WIN && !/\.exe$/i.test(bin);
  return await new Promise((resolve, reject) => {
    const child = spawn(useShell ? "\"" + bin + "\"" : bin, ["app-server"], { stdio: ["pipe", "pipe", "pipe"], env: process.env, windowsHide: true, shell: useShell });
    activeChildren.add(child);
    const lines = readline.createInterface({ input: child.stdout, crlfDelay: Infinity });
    let stderr = "", done = false, timer;
    child.stderr.on("data", chunk => { stderr = (stderr + chunk.toString("utf8")).slice(-200000); });
    child.stdin.on("error", () => {});
    const finish = (error, value) => {
      if (done) return;
      done = true;
      if (timer) clearTimeout(timer);
      lines.close();
      activeChildren.delete(child);
      try { child.stdin.end(); } catch {}
      if (IS_WIN && child.pid) killTree(child.pid).then(result => { if (result.code !== 0) try { child.kill(); } catch {} });
      else { try { child.kill(); } catch {} }
      if (error) reject(error); else resolve(value);
    };
    child.once("error", error => { activeChildren.delete(child); finish(error.code === "ENOENT" ? toolError("Codex CLI not found (" + CODEX_BIN + "). Install it with `npm i -g @openai/codex` or set CODEX_BIN.", "CODEX_NOT_FOUND") : error); });
    child.once("exit", (code, signal) => {
      activeChildren.delete(child);
      if (!done) finish(toolError("Codex app-server exited before responding (code=" + code + ", signal=" + signal + "): " + stderr.trim(), "CODEX_FAILED"));
    });
    lines.on("line", line => {
      let message;
      try { message = JSON.parse(line); } catch { return; }
      if (!message || typeof message !== "object" || message.method !== undefined) return; // server notifications/requests
      if (message.id === 0) {
        if (message.error) { finish(toolError("Codex app-server initialize failed: " + message.error.message, "CODEX_FAILED")); return; }
        child.stdin.write(JSON.stringify({ method: "initialized", params: {} }) + "\n");
        child.stdin.write(JSON.stringify({ id: 1, method: method, params: params }) + "\n");
      } else if (message.id === 1) {
        if (message.error) finish(toolError("Codex app-server error " + message.error.code + ": " + message.error.message, "CODEX_FAILED"));
        else finish(null, message.result);
      }
    });
    timer = setTimeout(() => finish(toolError("Timed out waiting for Codex app-server after " + timeout + "ms: " + stderr.trim(), "CODEX_TIMEOUT")), timeout);
    child.stdin.write(JSON.stringify({ id: 0, method: "initialize", params: { clientInfo: { name: "windows-developer-bridge", title: "Windows Developer Bridge", version: VERSION }, capabilities: { experimentalApi: true } } }) + "\n");
  });
}
function optionalStringArray(args, name) {
  const value = args[name];
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || value.some(item => typeof item !== "string")) throw toolError(name + " must be an array of strings", "INVALID_ARGUMENT");
  return value;
}
function utf8Boundary(buffer) {
  let index = buffer.length - 1, continuation = 0;
  while (index >= 0 && continuation < 3 && (buffer[index] & 0xc0) === 0x80) { index--; continuation++; }
  if (index < 0) return buffer.length;
  const lead = buffer[index], needed = lead >= 0xf0 ? 4 : lead >= 0xe0 ? 3 : lead >= 0xc0 ? 2 : 1;
  const keep = buffer.length - index < needed ? index : buffer.length;
  return keep > 0 ? keep : buffer.length;
}
async function readFile(args) {
  const pathname = resolvePath(args.path), encoding = args.encoding || "utf8", offset = boundedInt(args.offset, 0, 0, Number.MAX_SAFE_INTEGER, "offset"), max = boundedInt(args.max_bytes, 1000000, 1, 64000000, "max_bytes");
  const stat = await fsp.stat(pathname);
  if (stat.isDirectory()) throw toolError("Is a directory: " + pathname + " (use fs_list)", "IS_A_DIRECTORY");
  if (!stat.isFile()) throw toolError("Not a regular file: " + pathname, "NOT_A_FILE");
  const length = Math.max(0, Math.min(max, stat.size - offset)), handle = await fsp.open(pathname, "r");
  try {
    const buffer = Buffer.alloc(length), read = await handle.read(buffer, 0, length, offset);
    let data = buffer.subarray(0, read.bytesRead);
    if (encoding === "utf8" && offset + data.length < stat.size) data = data.subarray(0, utf8Boundary(data));
    const next = offset + data.length;
    return { path: pathname, size: stat.size, offset: offset, bytesRead: data.length, nextOffset: next < stat.size ? next : null, truncated: next < stat.size, encoding: encoding, modifiedAt: stat.mtime.toISOString(), content: encoding === "base64" ? data.toString("base64") : data.toString("utf8") };
  } finally { await handle.close(); }
}
async function writeFile(args) {
  const pathname = resolvePath(args.path), content = args.encoding === "base64" ? Buffer.from(args.content, "base64") : Buffer.from(args.content, "utf8");
  if (args.create_parents !== false) await fsp.mkdir(path.dirname(pathname), { recursive: true });
  if (args.append === true) await fsp.appendFile(pathname, content);
  else if (args.atomic !== false) {
    const tmp = path.join(path.dirname(pathname), "." + path.basename(pathname) + "." + crypto.randomBytes(6).toString("hex") + ".tmp");
    try { await fsp.writeFile(tmp, content); await renameWithRetry(tmp, pathname); } catch (error) { await fsp.rm(tmp, { force: true }).catch(() => {}); throw error; }
  } else await fsp.writeFile(pathname, content);
  const note = args.mode !== undefined ? await setMode(pathname, args.mode) : null;
  const stat = await fsp.stat(pathname);
  return { path: pathname, bytesWritten: content.length, size: stat.size, append: args.append === true, atomic: args.append === true ? false : args.atomic !== false, ...(note ? { note: note } : {}) };
}
async function statPath(args) {
  const pathname = resolvePath(args.path);
  let s;
  try { s = await fsp.lstat(pathname); }
  catch (error) { if (error.code === "ENOENT" || error.code === "ENOTDIR") return { path: pathname, exists: false }; throw error; }
  return { path: pathname, exists: true, type: s.isSymbolicLink() ? "symlink" : s.isDirectory() ? "directory" : s.isFile() ? "file" : "other", size: s.size, mode: s.mode & 0o7777, readOnly: IS_WIN ? (s.mode & 0o200) === 0 : undefined, createdAt: s.birthtime.toISOString(), modifiedAt: s.mtime.toISOString(), changedAt: s.ctime.toISOString(), accessedAt: s.atime.toISOString(), symlinkTarget: s.isSymbolicLink() ? await fsp.readlink(pathname) : null };
}
async function bridgeStatus() {
  let shell = null;
  try { shell = resolvePowerShell(); } catch (error) { shell = { file: null, error: error.message }; }
  const pty = IS_WIN ? await ptyManager().then(manager => ({ ...manager.available(), sessions: manager.list().count }), error => ({ available: false, reason: error.message })) : { available: false, reason: "requires Windows" };
  const jobSummary = await listJobs({ include_finished: true, limit: 1000 }).catch(() => ({ total: 0, running: 0 }));
  const codex = path.isAbsolute(CODEX_BIN) ? (isFile(CODEX_BIN) ? CODEX_BIN : null) : which(CODEX_BIN);
  return {
    bridgeVersion: VERSION, pid: process.pid, hostname: os.hostname(), username: os.userInfo().username, platform: process.platform, osRelease: os.release(), architecture: process.arch, node: process.version,
    home: HOME, dataDir: DATA_DIR, jobDir: JOB_DIR, auditLog: AUDIT_LOG, unlockFile: UNLOCK_FILE, fullAccessUnlocked: await fullAccessUnlocked(),
    shell: shell.file, shellKind: shell.kind || null, powershellAvailable: Boolean(shell.file), ...(shell.error ? { shellError: shell.error } : {}),
    git: which(IS_WIN ? "git.exe" : "git"), codexBin: CODEX_BIN, codexPath: codex,
    pty: pty, jobCount: jobSummary.total, runningJobs: jobSummary.running, toolCount: TOOLS.length,
    accessModel: "No filesystem sandbox or command allowlist; operations use the logged-in OS user's permissions.",
  };
}
async function withPty(fn) { requireWindows("pty tools"); return fn(await ptyManager()); }

async function execute(name, args) {
  switch (name) {
    case "bridge_status": return bridgeStatus();
    case "shell_exec": return runPowerShell(args);
    case "shell_start": return startJob(args);
    case "shell_job_status": return jobStatus(args);
    case "shell_job_list": return listJobs(args);
    case "shell_job_kill": return killJob(args);
    case "fs_read": return readFile(args);
    case "fs_write": return writeFile(args);
    case "fs_list": return fileList(args);
    case "fs_stat": return statPath(args);
    case "fs_manage": return manageFs(args);
    case "apply_patch": return applyPatch(args);
    case "pty_start":
      if (args.cwd !== undefined) await existingDir(args.cwd);
      return withPty(manager => manager.start(args));
    case "pty_read": return withPty(manager => manager.read(args));
    case "pty_write": return withPty(manager => manager.write(args));
    case "pty_resize": return withPty(manager => manager.resize(args));
    case "pty_signal": return withPty(manager => manager.signal(Object.assign({ signal: "SIGINT" }, args)));
    case "pty_close": return withPty(manager => manager.close(args));
    case "pty_list": return withPty(manager => manager.list());
    case "codex_thread_read":
      return callCodexAppServer("thread/read", { threadId: args.thread_id, includeTurns: args.include_turns !== false }, args.timeout_ms);
    case "codex_thread_list": {
      const params = {
        limit: boundedInt(args.limit, 50, 1, 200, "limit"),
        sortKey: args.sort_key || "recency_at",
        sortDirection: args.sort_direction || "desc"
      };
      if (args.cursor !== undefined) params.cursor = args.cursor;
      if (args.search_term !== undefined) params.searchTerm = args.search_term;
      if (args.cwd !== undefined) params.cwd = resolvePath(args.cwd);
      if (args.archived !== undefined) params.archived = args.archived;
      if (args.is_pinned !== undefined) params.isPinned = args.is_pinned;
      if (args.use_state_db_only !== undefined) params.useStateDbOnly = args.use_state_db_only;
      if (args.model_providers !== undefined) params.modelProviders = optionalStringArray(args, "model_providers");
      if (args.source_kinds !== undefined) params.sourceKinds = optionalStringArray(args, "source_kinds");
      return callCodexAppServer("thread/list", params, args.timeout_ms);
    }
    case "codex_thread_turns_list": {
      const params = {
        threadId: args.thread_id,
        limit: boundedInt(args.limit, 50, 1, 200, "limit"),
        sortDirection: args.sort_direction || "asc",
        itemsView: args.items_view || "full"
      };
      if (args.cursor !== undefined) params.cursor = args.cursor;
      return callCodexAppServer("thread/turns/list", params, args.timeout_ms);
    }
    case "audit_tail": {
      const max = boundedInt(args.max_bytes, 200000, 1024, 8000000, "max_bytes");
      return { path: AUDIT_LOG, ...(await tailFile(AUDIT_LOG, max)) };
    }
    default: throw toolError("Unknown tool: " + name, "UNKNOWN_TOOL");
  }
}
const INSTRUCTIONS = [
  "Windows Developer Bridge: tools act on the user's Windows PC with their own permissions (no sandbox).",
  "Call bridge_status first to learn the host, shell and whether full access is unlocked.",
  "shell_exec runs PowerShell (7 if installed, else 5.1): use PowerShell syntax (`;` not `&&` on 5.1, `$env:VAR`, Get-ChildItem, Select-String). Use shell_start for servers/watchers and pty_start for interactive programs.",
  "Prefer fs_read/fs_write/fs_list over shell commands for files, and apply_patch with the '*** Begin Patch' format for code edits.",
  "Paths are Windows paths (C:\\\\Users\\\\...); ~ means the user's home directory.",
].join("\n");
async function handle(message) {
  if (!message || typeof message !== "object" || Array.isArray(message)) { fail(null, -32600, "Invalid Request"); return; }
  const id = message.id, method = message.method;
  if (typeof method !== "string") { if (id !== undefined) fail(id, -32600, "Invalid Request"); return; }
  if (method.startsWith("notifications/")) return;
  const params = message.params && typeof message.params === "object" ? message.params : {};
  if (method === "initialize") {
    const requested = params.protocolVersion;
    ok(id, { protocolVersion: SUPPORTED_PROTOCOLS.includes(requested) ? requested : SUPPORTED_PROTOCOLS[0], capabilities: { tools: { listChanged: false } }, serverInfo: { name: "windows-developer-bridge", title: "Windows Developer Bridge", version: VERSION }, instructions: INSTRUCTIONS });
    return;
  }
  if (method === "ping") { ok(id, {}); return; }
  if (method === "tools/list") { ok(id, { tools: TOOLS }); return; }
  if (method === "tools/call") {
    const name = params.name, rawArgs = params.arguments === undefined || params.arguments === null ? {} : params.arguments;
    if (typeof name !== "string" || !rawArgs || typeof rawArgs !== "object" || Array.isArray(rawArgs)) { fail(id, -32602, "Invalid params: tool name and object arguments are required"); return; }
    const definition = TOOL_MAP.get(name);
    if (!definition) { fail(id, -32602, "Unknown tool: " + name); return; }
    const started = Date.now();
    try {
      const args = validateArgs(definition, rawArgs);
      if (name !== "bridge_status") await requireFullAccess();
      const result = await execute(name, args);
      const argsHash = crypto.createHash("sha256").update(JSON.stringify(rawArgs)).digest("hex").slice(0, 16);
      await audit("tool_call", { tool: name, argumentKeys: Object.keys(rawArgs), argsHash: argsHash, durationMs: Date.now() - started }).catch(() => {});
      ok(id, textResult(result));
    }
    catch (error) {
      const messageText = error && error.message ? error.message : String(error);
      await audit("tool_error", { tool: name, code: error && error.code ? error.code : "TOOL_ERROR", message: messageText }).catch(() => {});
      ok(id, Object.assign(textResult({ error: messageText, code: error && error.code ? String(error.code) : "TOOL_ERROR" }), { isError: true }));
    }
    return;
  }
  if (method === "resources/list") { ok(id, { resources: [] }); return; }
  if (method === "resources/templates/list") { ok(id, { resourceTemplates: [] }); return; }
  if (method === "prompts/list") { ok(id, { prompts: [] }); return; }
  if (method === "logging/setLevel") { ok(id, {}); return; }
  if (id !== undefined) fail(id, -32601, "Method not found: " + method);
}
async function main() {
  await fsp.mkdir(DATA_DIR, { recursive: true }).catch(() => {});
  await ensureJobs().catch(() => {});
  pruneJobs().catch(() => {});
  const revocationPoll = setInterval(async () => { if (!(await fullAccessUnlocked().catch(() => false))) await revokeKnownJobs().catch(() => {}); }, 3000);
  revocationPoll.unref();
  const rl = readline.createInterface({ input: process.stdin, crlfDelay: Infinity, terminal: false });
  // Requests run concurrently (JSON-RPC responses are correlated by id), so a long shell_exec or a
  // pty_read long-poll never blocks other calls.
  rl.on("line", line => {
    if (!line.trim()) return;
    let message;
    try { message = JSON.parse(line); } catch { fail(null, -32700, "Parse error"); return; }
    const batch = Array.isArray(message) ? message : [message];
    for (const item of batch) handle(item).catch(error => { process.stderr.write("request error: " + (error && error.stack ? error.stack : error) + "\n"); if (item && item.id !== undefined) fail(item.id, -32603, "Internal error"); });
  });
  rl.on("close", () => {
    process.exitCode = 0;
    if (ptyManagerPromise) ptyManagerPromise.then(manager => manager.closeAll()).catch(() => {});
  });
}
main().catch(error => { process.stderr.write((error && error.stack ? error.stack : error) + "\n"); process.exitCode = 1; });
