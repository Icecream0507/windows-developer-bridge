import test, { before, after } from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import { spawnSync } from "node:child_process";
import { createPtyManager, stripAnsi } from "../lib/pty.mjs";

const IS_WIN = process.platform === "win32";
const skip = IS_WIN ? false : "ConPTY tests require Windows";
const SYSTEM_ROOT = process.env.SystemRoot || process.env.WINDIR || "C:\\Windows";
const POWERSHELL = path.join(SYSTEM_ROOT, "System32", "WindowsPowerShell", "v1.0", "powershell.exe");

let dataDir;
let workDir;
let manager;
const extraManagers = [];

function makeManager() {
  return createPtyManager({
    dataDir: dataDir,
    resolveShell: () => ({ file: POWERSHELL }),
    buildEnv: overrides => {
      const env = Object.assign({}, process.env);
      for (const [key, value] of Object.entries(overrides || {})) {
        if (value === null) delete env[key]; else env[key] = String(value);
      }
      return env;
    },
    resolvePath: p => path.resolve(p),
    homeDir: workDir
  });
}

before(() => {
  if (!IS_WIN) return;
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "wdb-pty-data-"));
  workDir = fs.mkdtempSync(path.join(os.tmpdir(), "wdb-pty-work-"));
  manager = makeManager();
});

after(async () => {
  if (!IS_WIN) return;
  for (const item of [manager, ...extraManagers]) {
    if (item) await item.closeAll().catch(() => {});
  }
  for (const dir of [dataDir, workDir]) {
    if (dir) fs.rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  }
});

function sleep(ms) { return new Promise(resolve => setTimeout(resolve, ms)); }

// Read (continuing from the manager's cursor) until predicate(rawText) holds, the session
// exits and is fully drained, or the timeout elapses.
async function collect(mgr, sessionId, predicate, timeoutMs = 30000) {
  let text = "";
  let last = null;
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    last = await mgr.read({ session_id: sessionId, wait_ms: Math.max(1, Math.min(500, deadline - Date.now())) });
    text += last.data;
    if (predicate(text, last)) return { text: text, last: last, matched: true };
    if (last.exited && last.next_cursor >= last.total_bytes) break;
  }
  return { text: text, last: last, matched: false };
}
async function collectUntilExit(mgr, sessionId, timeoutMs = 30000) {
  return collect(mgr, sessionId, (text, last) => last.exited && last.next_cursor >= last.total_bytes, timeoutMs);
}
function plain(text) { return stripAnsi(text); }

function processAlive(pid) {
  const result = spawnSync("tasklist.exe", ["/FI", "PID eq " + pid, "/FO", "CSV", "/NH"], { encoding: "utf8", windowsHide: true });
  return String(result.stdout || "").includes("\"" + pid + "\"");
}
function childPids(pid) {
  const script = "Get-CimInstance Win32_Process -Filter \"ParentProcessId=" + pid + "\" | ForEach-Object { $_.ProcessId }";
  const result = spawnSync(POWERSHELL, ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", script], { encoding: "utf8", windowsHide: true });
  return String(result.stdout || "").split(/\s+/).filter(Boolean).map(Number).filter(Number.isSafeInteger);
}
function livePids() {
  const result = spawnSync("tasklist.exe", ["/FO", "CSV", "/NH"], { encoding: "utf8", windowsHide: true, maxBuffer: 16 * 1024 * 1024 });
  const pids = new Set();
  for (const line of String(result.stdout || "").split(/\r?\n/)) {
    const match = /^"[^"]*","(\d+)"/.exec(line);
    if (match) pids.add(Number(match[1]));
  }
  return pids;
}
async function waitGone(pids, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const live = livePids();
    if (pids.every(pid => !live.has(pid))) return true;
    await sleep(250);
  }
  return pids.every(pid => !processAlive(pid));
}

test("available() reports ConPTY support", { skip }, () => {
  const status = manager.available();
  assert.equal(status.available, true, status.reason);
});

test("interactive shell: write, poll, monotonic cursors, re-read from 0", { skip }, async t => {
  const session = await manager.start({ label: "interactive" });
  t.after(() => manager.close({ session_id: session.session_id }).catch(() => {}));
  assert.match(session.session_id, /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
  assert.ok(Number.isInteger(session.pid) && session.pid > 0);
  assert.ok(Number.isInteger(session.helper_pid) && session.helper_pid > 0);
  assert.equal(session.cols, 120);
  assert.equal(session.rows, 30);
  assert.equal(session.cwd, workDir);
  assert.equal(session.label, "interactive");
  assert.ok(session.command_line.includes("-NoProfile"));

  const written = await manager.write({ session_id: session.session_id, data: "Write-Output ('hello-' + (40+2))\r" });
  assert.equal(written.bytes_written, Buffer.byteLength("Write-Output ('hello-' + (40+2))\r"));

  const chunks = [];
  let cursor = 0;
  const deadline = Date.now() + 30000;
  while (Date.now() < deadline) {
    const result = await manager.read({ session_id: session.session_id, wait_ms: 500, encoding: "base64" });
    assert.equal(result.cursor, cursor, "reads continue from the previous next_cursor");
    assert.equal(result.dropped_bytes, 0);
    assert.equal(result.oldest_cursor, 0);
    assert.equal(result.next_cursor, result.cursor + result.bytes);
    assert.ok(result.next_cursor >= cursor);
    assert.ok(result.total_bytes >= result.next_cursor);
    assert.equal(result.exited, false);
    cursor = result.next_cursor;
    chunks.push(Buffer.from(result.data, "base64"));
    if (Buffer.concat(chunks).toString("utf8").includes("hello-42")) break;
  }
  const all = Buffer.concat(chunks);
  assert.ok(all.toString("utf8").includes("hello-42"), "output should contain hello-42:\n" + JSON.stringify(all.toString("utf8")));

  const again = await manager.read({ session_id: session.session_id, cursor: 0, max_bytes: all.length, encoding: "base64" });
  assert.equal(again.cursor, 0);
  assert.deepEqual(Buffer.from(again.data, "base64"), all);
  const text = await manager.read({ session_id: session.session_id, cursor: 0, max_bytes: all.length });
  assert.ok(text.data.includes("hello-42"));
  assert.equal(text.encoding, "utf8");

  await assert.rejects(manager.read({ session_id: session.session_id, cursor: text.total_bytes + 1000000 }), error => error.code === "PTY_INVALID_ARGUMENT");
  const listed = manager.list().sessions.find(item => item.session_id === session.session_id);
  assert.ok(listed);
  assert.equal(listed.exited, false);
  assert.equal(listed.pid, session.pid);
});

test("command mode reports the exit code and stays readable after exit", { skip }, async t => {
  const session = await manager.start({ command: "Write-Output done; exit 7" });
  t.after(() => manager.close({ session_id: session.session_id }).catch(() => {}));
  const { text, last } = await collectUntilExit(manager, session.session_id);
  assert.equal(last.exited, true);
  assert.equal(last.exit_code, 7);
  assert.ok(plain(text).includes("done"), JSON.stringify(text));
  await assert.rejects(manager.write({ session_id: session.session_id, data: "x" }), error => error.code === "PTY_EXITED");
  const listed = manager.list().sessions.find(item => item.session_id === session.session_id);
  assert.equal(listed.exited, true);
  assert.equal(listed.exit_code, 7);
  const replay = await manager.read({ session_id: session.session_id, cursor: 0, strip_ansi: true, max_bytes: 4194304 });
  assert.ok(replay.data.includes("done"));
  const closed = await manager.close({ session_id: session.session_id });
  assert.deepEqual(closed, { session_id: session.session_id, closed: true, exit_code: 7, exited: true, total_bytes: replay.total_bytes });
});

test("unicode output is decoded and utf8 reads never split characters", { skip }, async t => {
  const expected = "中文-ünïcode";
  const session = await manager.start({ command: "Write-Output '" + expected + "'" });
  t.after(() => manager.close({ session_id: session.session_id }).catch(() => {}));
  const { text, last } = await collectUntilExit(manager, session.session_id);
  assert.equal(last.exit_code, 0);
  assert.ok(plain(text).includes(expected), JSON.stringify(text));

  const raw = Buffer.from((await manager.read({ session_id: session.session_id, cursor: 0, max_bytes: 4194304, encoding: "base64" })).data, "base64");
  const offset = raw.indexOf(Buffer.from("中", "utf8"));
  assert.ok(offset > 0);
  const partial = await manager.read({ session_id: session.session_id, cursor: offset - 1, max_bytes: 3 });
  assert.equal(partial.bytes, 1, "a 3-byte character must not be split");
  assert.equal(partial.next_cursor, offset);
  const whole = await manager.read({ session_id: session.session_id, cursor: offset, max_bytes: 3 });
  assert.equal(whole.data, "中");
});

test("resize is acknowledged and visible to the shell", { skip }, async t => {
  const session = await manager.start({ cols: 80, rows: 24 });
  t.after(() => manager.close({ session_id: session.session_id }).catch(() => {}));
  const result = await manager.resize({ session_id: session.session_id, cols: 100, rows: 40 });
  assert.deepEqual(result, { session_id: session.session_id, cols: 100, rows: 40, applied: true });
  const listed = manager.list().sessions.find(item => item.session_id === session.session_id);
  assert.equal(listed.cols, 100);
  assert.equal(listed.rows, 40);
  await manager.write({ session_id: session.session_id, data: "Write-Output ('size=' + $Host.UI.RawUI.WindowSize.Width + 'x' + $Host.UI.RawUI.WindowSize.Height)\r" });
  const { matched, text } = await collect(manager, session.session_id, value => plain(value).includes("size=100x40"));
  assert.ok(matched, JSON.stringify(plain(text)));
  await assert.rejects(manager.resize({ session_id: session.session_id, cols: 10, rows: 40 }), error => error.code === "PTY_INVALID_ARGUMENT");
});

test("SIGINT interrupts a running command and the shell keeps working", { skip }, async t => {
  const session = await manager.start({});
  t.after(() => manager.close({ session_id: session.session_id }).catch(() => {}));
  await collect(manager, session.session_id, value => /PS [^\r\n]*>/.test(plain(value)), 20000);
  await manager.write({ session_id: session.session_id, data: "Start-Sleep -Seconds 60\r" });
  await collect(manager, session.session_id, value => plain(value).includes("Start-Sleep"), 5000);
  await sleep(1500);
  const began = Date.now();
  const delivered = await manager.signal({ session_id: session.session_id, signal: "SIGINT" });
  assert.deepEqual(delivered, { session_id: session.session_id, signal: "SIGINT", delivered: true, method: "ctrl_c" });
  await manager.write({ session_id: session.session_id, data: "Write-Output ('after-' + (1+1))\r" });
  const { matched, text, last } = await collect(manager, session.session_id, value => plain(value).includes("after-2"), 25000);
  assert.ok(matched, "shell did not respond after Ctrl+C: " + JSON.stringify(plain(text)));
  assert.ok(Date.now() - began < 30000);
  assert.equal(last.exited, false);
});

test("close() kills the whole process tree", { skip }, async t => {
  const session = await manager.start({ command: "ping -n 100 127.0.0.1" });
  t.after(() => manager.close({ session_id: session.session_id }).catch(() => {}));
  const { matched, text } = await collect(manager, session.session_id, value => plain(value).includes("127.0.0.1"), 20000);
  assert.ok(matched, JSON.stringify(text));
  const children = childPids(session.pid);
  assert.ok(children.length >= 1, "expected ping.exe below PowerShell");
  const pids = [session.pid, session.helper_pid, ...children];
  assert.ok(processAlive(session.pid));
  const closed = await manager.close({ session_id: session.session_id });
  assert.equal(closed.closed, true);
  assert.equal(closed.exited, true);
  assert.ok(await waitGone(pids, 8000), "processes still alive: " + pids.filter(processAlive).join(", "));
  await assert.rejects(manager.read({ session_id: session.session_id }), error => error.code === "PTY_NOT_FOUND");
});

test("SIGTERM terminates the job but keeps the session readable", { skip }, async t => {
  const session = await manager.start({ argv: ["ping.exe", "-n", "100", "127.0.0.1"] });
  t.after(() => manager.close({ session_id: session.session_id }).catch(() => {}));
  const delivered = await manager.signal({ session_id: session.session_id, signal: "SIGTERM" });
  assert.equal(delivered.method, "terminate");
  const { last } = await collectUntilExit(manager, session.session_id, 15000);
  assert.equal(last.exited, true);
  assert.equal(last.exit_code, 1);
  assert.ok(await waitGone([session.pid], 5000));
});

test("argv mode quotes arguments correctly", { skip }, async t => {
  const cmd = await manager.start({ argv: ["cmd.exe", "/c", "echo argv-ok"] });
  t.after(() => manager.close({ session_id: cmd.session_id }).catch(() => {}));
  assert.equal(cmd.command_line, "cmd.exe /c \"echo argv-ok\"");
  const first = await collectUntilExit(manager, cmd.session_id);
  assert.equal(first.last.exit_code, 0);
  assert.ok(plain(first.text).includes("argv-ok"), JSON.stringify(first.text));

  const tricky = ["a b", "c\"d", "e\\", "", "f\\\\\"g", "tab\there"];
  const node = await manager.start({ argv: [process.execPath, "-e", "process.stdout.write('ARGS=' + JSON.stringify(process.argv.slice(1)) + '\\n')", ...tricky] });
  t.after(() => manager.close({ session_id: node.session_id }).catch(() => {}));
  const second = await collectUntilExit(manager, node.session_id);
  assert.equal(second.last.exit_code, 0);
  const flat = plain(second.text).replace(/\r?\n/g, "");
  assert.ok(flat.includes("ARGS=" + JSON.stringify(tricky)), flat);
});

test("closed sessions are gone; strip_ansi removes escape sequences", { skip }, async t => {
  const session = await manager.start({ command: "Write-Output ansi-check" });
  t.after(() => manager.close({ session_id: session.session_id }).catch(() => {}));
  await collectUntilExit(manager, session.session_id);
  const raw = await manager.read({ session_id: session.session_id, cursor: 0, max_bytes: 4194304 });
  assert.ok(raw.data.includes("\x1b"), "ConPTY output is expected to contain VT sequences");
  const stripped = await manager.read({ session_id: session.session_id, cursor: 0, max_bytes: 4194304, strip_ansi: true });
  assert.ok(!stripped.data.includes("\x1b"), JSON.stringify(stripped.data));
  assert.ok(stripped.data.includes("ansi-check"));
  assert.equal(stripped.next_cursor, raw.next_cursor, "cursors stay byte-based");
  assert.equal(stripAnsi("a\x1b[31mb\x1b]0;title\x07c\x1b]8;;http://x\x1b\\d\x1b(Be\x1b[?25lf\x1b"), "abcdef");

  await manager.close({ session_id: session.session_id });
  for (const call of [
    () => manager.read({ session_id: session.session_id }),
    () => manager.write({ session_id: session.session_id, data: "x" }),
    () => manager.resize({ session_id: session.session_id, cols: 80, rows: 24 }),
    () => manager.signal({ session_id: session.session_id, signal: "SIGINT" }),
    () => manager.close({ session_id: session.session_id })
  ]) {
    await assert.rejects(call(), error => error.code === "PTY_NOT_FOUND");
  }
  assert.ok(!manager.list().sessions.some(item => item.session_id === session.session_id));
});

test("ring buffer evicts old output and reports dropped bytes", { skip }, async t => {
  const previous = process.env.WDB_PTY_BUFFER_BYTES;
  process.env.WDB_PTY_BUFFER_BYTES = "4096";
  let session;
  try {
    session = await manager.start({ command: "1..1500 | ForEach-Object { 'line-' + $_ }" });
  } finally {
    if (previous === undefined) delete process.env.WDB_PTY_BUFFER_BYTES; else process.env.WDB_PTY_BUFFER_BYTES = previous;
  }
  t.after(() => manager.close({ session_id: session.session_id }).catch(() => {}));
  let last;
  const deadline = Date.now() + 30000;
  while (Date.now() < deadline) {
    last = await manager.read({ session_id: session.session_id, cursor: 0, max_bytes: 1, wait_ms: 0 });
    if (last.exited) break;
    await sleep(200);
  }
  assert.equal(last.exited, true);
  const result = await manager.read({ session_id: session.session_id, cursor: 0, max_bytes: 4194304, strip_ansi: true });
  assert.ok(result.total_bytes > 4096);
  assert.ok(result.oldest_cursor >= result.total_bytes - 4096);
  assert.ok(result.dropped_bytes > 0);
  assert.equal(result.cursor, 0 + result.dropped_bytes);
  assert.equal(result.next_cursor, result.total_bytes);
  assert.ok(result.data.includes("line-1500"), JSON.stringify(result.data.slice(-200)));
  assert.ok(!result.data.includes("line-1\r"));
});

test("argument validation and error codes", { skip }, async () => {
  await assert.rejects(manager.start({ command: "x", argv: ["cmd.exe"] }), error => error.code === "PTY_INVALID_ARGUMENT");
  await assert.rejects(manager.start({ cols: 10 }), error => error.code === "PTY_INVALID_ARGUMENT");
  await assert.rejects(manager.start({ label: "x".repeat(101) }), error => error.code === "PTY_INVALID_ARGUMENT");
  await assert.rejects(manager.start({ argv: [] }), error => error.code === "PTY_INVALID_ARGUMENT");
  await assert.rejects(manager.start({ cwd: path.join(workDir, "does-not-exist") }), error => error.code === "PTY_INVALID_ARGUMENT");
  await assert.rejects(manager.start({ argv: ["wdb-definitely-missing-program.exe"] }), error => error.code === "PTY_START_FAILED" && /CreateProcess/.test(error.message));
  await assert.rejects(manager.read({ session_id: "00000000-0000-0000-0000-000000000000" }), error => error.code === "PTY_NOT_FOUND");
  const session = await manager.start({ argv: ["cmd.exe", "/d", "/k"] });
  try {
    await assert.rejects(manager.signal({ session_id: session.session_id, signal: "SIGUSR1" }), error => error.code === "PTY_INVALID_ARGUMENT");
    await assert.rejects(manager.write({ session_id: session.session_id, data: "x".repeat(1024 * 1024 + 1) }), error => error.code === "PTY_INVALID_ARGUMENT");
    await assert.rejects(manager.read({ session_id: session.session_id, max_bytes: 0 }), error => error.code === "PTY_INVALID_ARGUMENT");
  } finally {
    await manager.close({ session_id: session.session_id });
  }
});

test("session limit and closeAll", { skip }, async () => {
  const limited = makeManager();
  extraManagers.push(limited);
  const started = [];
  for (let i = 0; i < 16; i++) started.push(limited.start({ argv: ["cmd.exe", "/d", "/k"], label: "limit-" + i }));
  const sessions = await Promise.all(started);
  assert.equal(sessions.length, 16);
  assert.equal(limited.list().count, 16);
  await assert.rejects(limited.start({ argv: ["cmd.exe", "/d", "/k"] }), error => error.code === "PTY_LIMIT");
  const helperPids = sessions.map(item => item.helper_pid).concat(sessions.map(item => item.pid));
  assert.equal(await limited.closeAll(), 16);
  assert.equal(limited.list().count, 0);
  assert.ok(await waitGone(helperPids, 10000));
});
