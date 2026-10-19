#!/usr/bin/env node
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import fsp from "node:fs/promises";
import crypto from "node:crypto";
import readline from "node:readline";
import { spawn } from "node:child_process";

const VERSION = "0.1.0";
const IS_WIN = process.platform === "win32";
const HOME = os.homedir();
const DATA_DIR = process.env.WDB_DATA_DIR || (process.env.LOCALAPPDATA ? path.join(process.env.LOCALAPPDATA, "WindowsDeveloperBridge") : path.join(HOME, ".windows-developer-bridge"));
const JOB_DIR = path.join(DATA_DIR, "jobs");
const UNLOCK_FILE = path.join(DATA_DIR, "FULL_ACCESS_ENABLED");
const AUDIT_LOG = path.join(DATA_DIR, "audit.jsonl");
const DEFAULT_TIMEOUT = 600000;
const CODEX_BIN = process.env.CODEX_BIN || "codex";
const jobs = new Map();
const activeChildren = new Set();
const revokedChildren = new WeakSet();
let requestChain = Promise.resolve();

function send(message) { process.stdout.write(JSON.stringify(message) + "\n"); }
function ok(id, result) { if (id !== undefined) send({ jsonrpc: "2.0", id: id, result: result }); }
function fail(id, code, message) { if (id !== undefined) send({ jsonrpc: "2.0", id: id, error: { code: code, message: message } }); }
function textResult(value) {
  const content = typeof value === "string" ? value : JSON.stringify(value, null, 2);
  const result = { content: [{ type: "text", text: content }] };
  if (value && typeof value === "object" && !Array.isArray(value)) result.structuredContent = value;
  return result;
}
function tool(name, description, properties, required, annotations) {
  return { name: name, description: description, inputSchema: { type: "object", properties: properties || {}, required: required || [], additionalProperties: false }, annotations: Object.assign({ readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false }, annotations || {}) };
}
const str = (description) => Object.assign({ type: "string" }, description ? { description: description } : {});
const int = (minimum, maximum) => ({ type: "integer", minimum: minimum, maximum: maximum });
const bool = () => ({ type: "boolean" });
const TOOLS = [
  tool("bridge_status", "Read runtime platform, paths, shell availability, job count, and audit location.", {}, [], { readOnlyHint: true, idempotentHint: true }),
  tool("shell_exec", "Run a PowerShell command as the logged-in Windows user. Commands can read or modify files, invoke programs, and access the network.", { command: str("PowerShell source to execute."), cwd: str(), env: { type: "object", additionalProperties: { type: ["string", "number", "boolean", "null"] } }, stdin: str(), timeout_ms: int(0, 1800000), max_output_bytes: int(1024, 64000000) }, ["command"], { destructiveHint: true, openWorldHint: true }),
  tool("shell_start", "Start a detached PowerShell background job with persistent output logs.", { command: str(), cwd: str(), env: { type: "object", additionalProperties: { type: ["string", "number", "boolean", "null"] } }, label: { type: "string", maxLength: 100 } }, ["command"], { destructiveHint: true, openWorldHint: true }),
  tool("shell_job_status", "Inspect a background job and return bounded stdout/stderr log tails.", { job_id: str(), max_log_bytes: int(1024, 8000000) }, ["job_id"], { readOnlyHint: true, idempotentHint: true }),
  tool("shell_job_list", "List known background jobs and their current state.", {}, [], { readOnlyHint: true, idempotentHint: true }),
  tool("shell_job_kill", "Terminate a background job and its descendant process tree on Windows.", { job_id: str(), signal: { type: "string", enum: ["SIGTERM", "SIGKILL", "SIGINT", "SIGHUP"] } }, ["job_id"], { destructiveHint: true }),
  tool("fs_read", "Read a file with byte-offset pagination; supports UTF-8 and base64.", { path: str(), encoding: { type: "string", enum: ["utf8", "base64"] }, offset: int(0, Number.MAX_SAFE_INTEGER), max_bytes: int(1, 64000000) }, ["path"], { readOnlyHint: true, idempotentHint: true }),
  tool("fs_write", "Create or replace a file atomically, or append to it.", { path: str(), content: str(), encoding: { type: "string", enum: ["utf8", "base64"] }, append: bool(), atomic: bool(), create_parents: bool(), mode: int(0, 4095) }, ["path", "content"], { destructiveHint: true }),
  tool("fs_list", "List a directory with bounded optional recursion. Directory symlinks are not traversed.", { path: str(), recursive: bool(), include_hidden: bool(), max_entries: int(1, 100000), max_depth: int(0, 100) }, ["path"], { readOnlyHint: true, idempotentHint: true }),
  tool("fs_stat", "Return metadata about a filesystem path without following the final symlink.", { path: str() }, ["path"], { readOnlyHint: true, idempotentHint: true }),
  tool("fs_manage", "Create, remove, move, copy, chmod, or create a symlink.", { operation: { type: "string", enum: ["mkdir", "remove", "move", "copy", "chmod", "symlink"] }, path: str(), destination: str(), recursive: bool(), force: bool(), mode: int(0, 4095) }, ["operation", "path"], { destructiveHint: true }),
  tool("apply_patch", "Apply a unified diff using git apply in the selected working directory.", { patch: str(), cwd: str(), check_only: bool(), reverse: bool(), three_way: bool() }, ["patch"], { destructiveHint: true }),

  tool("codex_thread_read", "Read a stored Codex thread through the Codex app-server without resuming it or starting a model turn.", { thread_id: str(), include_turns: bool(), timeout_ms: int(1000, 120000) }, ["thread_id"], { readOnlyHint: true, idempotentHint: true }),
  tool("codex_thread_list", "Page through stored Codex threads without resuming them or starting model turns.", {
    limit: int(1, 200), cursor: str(), search_term: str(), cwd: str(), archived: bool(), is_pinned: bool(),
    use_state_db_only: bool(), model_providers: { type: "array", items: { type: "string" } },
    source_kinds: { type: "array", items: { type: "string", enum: ["cli", "vscode", "exec", "appServer", "subAgent", "subAgentReview", "subAgentCompact", "subAgentThreadSpawn", "subAgentOther", "unknown"] } },
    sort_key: { type: "string", enum: ["created_at", "updated_at", "recency_at"] }, sort_direction: { type: "string", enum: ["asc", "desc"] }, timeout_ms: int(1000, 120000)
  }, [], { readOnlyHint: true, idempotentHint: true }),
  tool("codex_thread_turns_list", "Page persisted turns of a stored Codex thread without resuming it or starting a model turn.", {
    thread_id: str(), limit: int(1, 200), cursor: str(), sort_direction: { type: "string", enum: ["asc", "desc"] },
    items_view: { type: "string", enum: ["notLoaded", "summary", "full"] }, timeout_ms: int(1000, 120000)
  }, ["thread_id"], { readOnlyHint: true, idempotentHint: true }),
  tool("audit_tail", "Read the bounded tail of the append-only local JSONL audit log.", { max_bytes: int(1024, 8000000) }, [], { readOnlyHint: true, idempotentHint: true })
];

function resolvePath(input) {
  if (typeof input !== "string" || !input.trim()) throw new Error("path must be a non-empty string");
  let value = input;
  if (value === "~") value = HOME;
  else if (value.startsWith("~/") || value.startsWith("~\\")) value = path.join(HOME, value.slice(2));
  return path.resolve(value);
}
function boundedInt(value, fallback, min, max, name) {
  if (value === undefined) return fallback;
  if (!Number.isSafeInteger(value) || value < min || value > max) throw new Error(name + " must be an integer between " + min + " and " + max);
  return value;
}
function redact(value) {
  return String(value).replace(/(token|secret|password|api[_-]?key)(\s*[:=]\s*)[^\s,;]+/gi, "$1$2[REDACTED]");
}
async function audit(event, details) {
  await fsp.mkdir(DATA_DIR, { recursive: true });
  const record = { at: new Date().toISOString(), event: event, pid: process.pid, details: redact(JSON.stringify(details || {})).slice(0, 4000) };
  await fsp.appendFile(AUDIT_LOG, JSON.stringify(record) + "\n", { encoding: "utf8", mode: 0o600 });
}
function envFor(overrides) {
  const env = Object.assign({}, process.env);
  for (const [key, value] of Object.entries(overrides || {})) {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) throw new Error("Invalid environment variable name: " + key);
    if (value === null) delete env[key]; else env[key] = String(value);
  }
  return env;
}
function psArgs() { return { file: process.env.WDB_POWERSHELL || "pwsh.exe", args: ["-NoLogo", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", "-"] }; }
function appendBounded(current, chunk, maxBytes) {
  const combined = Buffer.concat([current, Buffer.from(chunk)]);
  return combined.length > maxBytes ? combined.subarray(combined.length - maxBytes) : combined;
}
async function runPowerShell(args) {
  if (!IS_WIN) throw new Error("shell_exec requires Windows; current platform is " + process.platform + ". Windows integration tests must run on Windows.");
  const cwd = resolvePath(args.cwd || HOME), timeout = boundedInt(args.timeout_ms, DEFAULT_TIMEOUT, 0, 1800000, "timeout_ms");
  const max = boundedInt(args.max_output_bytes, 1048576, 1024, 64000000, "max_output_bytes");
  const tempDir = await fsp.mkdtemp(path.join(os.tmpdir(), "wdb-powershell-"));
  const scriptPath = path.join(tempDir, "command.ps1");
  await fsp.writeFile(scriptPath, args.command, "utf8");
  let child;
  let stdout = Buffer.alloc(0), stderr = Buffer.alloc(0), timedOut = false, settled = false;
  const started = Date.now();
  try {
    child = spawn(psArgs().file, ["-NoLogo", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", scriptPath], { cwd: cwd, env: envFor(args.env), windowsHide: true, stdio: ["pipe", "pipe", "pipe"] });
    activeChildren.add(child);
    child.stdout.on("data", chunk => { stdout = appendBounded(stdout, chunk, max); });
    child.stderr.on("data", chunk => { stderr = appendBounded(stderr, chunk, max); });
    child.stdin.on("error", () => {});
    const finished = new Promise((resolve, reject) => {
      child.once("error", error => { activeChildren.delete(child); reject(error); });
      child.once("close", (code, signal) => { settled = true; activeChildren.delete(child); resolve({ exitCode: code, signal: signal }); });
    });
    child.stdin.end(args.stdin === undefined ? "" : args.stdin, "utf8");
    let timer;
    if (timeout > 0) timer = setTimeout(() => {
      if (settled) return;
      timedOut = true;
      const pid = child.pid;
      try { child.kill(); } catch {}
      if (pid) spawn("taskkill.exe", ["/PID", String(pid), "/T", "/F"], { windowsHide: true, stdio: "ignore" }).on("error", () => {});
    }, timeout);
    try {
      const exit = await finished;
      const out = stdout.toString("utf8"), err = stderr.toString("utf8");
      return { command: args.command, cwd: cwd, exitCode: exit.exitCode, signal: exit.signal, timedOut: timedOut, revoked: revokedChildren.has(child), durationMs: Date.now() - started, stdout: out, stderr: err, outputTruncated: stdout.length >= max || stderr.length >= max };
    } finally { if (timer) clearTimeout(timer); }
  } finally {
    await fsp.rm(tempDir, { recursive: true, force: true }).catch(() => {});
  }
}
async function ensureJobs() { await fsp.mkdir(JOB_DIR, { recursive: true }); }
async function fullAccessUnlocked() {
  try { const stat = await fsp.lstat(UNLOCK_FILE); return stat.isFile() && !stat.isSymbolicLink(); }
  catch (error) { if (error && error.code === "ENOENT") return false; throw error; }
}
async function revokeKnownJobs() {
  if (!IS_WIN) return;
  for (const child of activeChildren) {
    if (!child.pid) continue;
    revokedChildren.add(child);
    await new Promise(resolve => {
      const killer = spawn("taskkill.exe", ["/PID", String(child.pid), "/T", "/F"], { windowsHide: true, stdio: "ignore" });
      killer.once("error", resolve); killer.once("close", resolve);
    });
  }
  await ensureJobs().catch(() => {});
  const names = await fsp.readdir(JOB_DIR).catch(() => []);
  for (const name of names.filter(item => item.endsWith(".json"))) {
    let meta;
    try { meta = JSON.parse(await fsp.readFile(path.join(JOB_DIR, name), "utf8")); } catch { continue; }
    if (meta.state !== "running" || !Number.isInteger(meta.pid) || meta.pid <= 0) continue;
    await new Promise(resolve => {
      const child = spawn("taskkill.exe", ["/PID", String(meta.pid), "/T", "/F"], { windowsHide: true, stdio: "ignore" });
      child.once("error", resolve); child.once("close", resolve);
    });
    meta.state = "revoked";
    meta.finishedAt = new Date().toISOString();
    await writeJob(meta).catch(() => {});
  }
}
async function requireFullAccess() {
  if (await fullAccessUnlocked()) return;
  await revokeKnownJobs();
  const error = new Error("Full access is locked. Explicitly create " + UNLOCK_FILE + " on this Windows user profile to enable local command and filesystem tools.");
  error.code = "FULL_ACCESS_LOCKED";
  throw error;
}
function jobFile(id) { if (!/^[a-f0-9-]{8,80}$/i.test(id)) throw new Error("Invalid job_id"); return path.join(JOB_DIR, id + ".json"); }
async function writeJob(meta) {
  await ensureJobs();
  const target = jobFile(meta.jobId), tmp = target + "." + crypto.randomBytes(4).toString("hex") + ".tmp";
  await fsp.writeFile(tmp, JSON.stringify(meta, null, 2), { mode: 0o600 });
  await fsp.rename(tmp, target); jobs.set(meta.jobId, meta);
}
async function loadJob(id) {
  if (jobs.has(id)) return jobs.get(id);
  const meta = JSON.parse(await fsp.readFile(jobFile(id), "utf8")); jobs.set(id, meta); return meta;
}
async function tailFile(filename, maxBytes) {
  const stat = await fsp.stat(filename), start = Math.max(0, stat.size - maxBytes), handle = await fsp.open(filename, "r");
  try { const buffer = Buffer.alloc(stat.size - start); const result = await handle.read(buffer, 0, buffer.length, start); return { content: buffer.subarray(0, result.bytesRead).toString("utf8"), returnedBytes: result.bytesRead, truncated: start > 0 }; }
  finally { await handle.close(); }
}
async function startJob(args) {
  if (!IS_WIN) throw new Error("shell_start requires Windows; current platform is " + process.platform);
  await ensureJobs();
  const id = crypto.randomUUID(), stdoutPath = path.join(JOB_DIR, id + ".stdout.log"), stderrPath = path.join(JOB_DIR, id + ".stderr.log");
  const out = fs.openSync(stdoutPath, "a"), err = fs.openSync(stderrPath, "a"), ps = psArgs();
  const child = spawn(ps.file, ps.args, { cwd: resolvePath(args.cwd || HOME), env: envFor(args.env), windowsHide: true, detached: true, stdio: ["pipe", out, err] });
  fs.closeSync(out); fs.closeSync(err);
  const meta = { jobId: id, pid: child.pid || null, label: String(args.label || args.command.slice(0, 80)).slice(0, 100), command: redact(args.command).slice(0, 2000), cwd: resolvePath(args.cwd || HOME), stdoutPath: stdoutPath, stderrPath: stderrPath, startedAt: new Date().toISOString(), state: "running", exitCode: null };
  child.stdin.on("error", () => {});
  child.once("error", async error => { meta.state = "failed"; meta.error = error.message; await writeJob(meta).catch(() => {}); });
  child.once("exit", async code => { meta.state = "exited"; meta.exitCode = code; meta.finishedAt = new Date().toISOString(); await writeJob(meta).catch(() => {}); });
  await writeJob(meta);
  child.stdin.end(args.command + "\n");
  return { jobId: id, pid: meta.pid, label: meta.label, state: meta.state, stdoutPath: stdoutPath, stderrPath: stderrPath };
}
async function jobStatus(args) {
  const meta = await loadJob(args.job_id), max = boundedInt(args.max_log_bytes, 100000, 1024, 8000000, "max_log_bytes");
  const stdout = await tailFile(meta.stdoutPath, max).catch(() => ({ content: "", truncated: false }));
  const stderr = await tailFile(meta.stderrPath, max).catch(() => ({ content: "", truncated: false }));
  if (meta.state === "running" && IS_WIN && meta.pid) {
    const proc = spawn("tasklist.exe", ["/FI", "PID eq " + meta.pid, "/FO", "CSV", "/NH"], { windowsHide: true, stdio: ["ignore", "pipe", "ignore"] });
    let output = ""; proc.stdout.on("data", chunk => output += chunk);
    await new Promise(resolve => proc.on("close", resolve));
    if (!output.includes(String(meta.pid))) { meta.state = "exited_or_reparented"; meta.finishedAt = meta.finishedAt || new Date().toISOString(); await writeJob(meta); }
  }
  return Object.assign({}, meta, { stdout: stdout.content, stderr: stderr.content, stdoutTruncated: stdout.truncated, stderrTruncated: stderr.truncated });
}
async function listJobs() {
  await ensureJobs();
  const names = (await fsp.readdir(JOB_DIR)).filter(name => name.endsWith(".json")), result = [];
  for (const name of names) { try { const m = JSON.parse(await fsp.readFile(path.join(JOB_DIR, name), "utf8")); result.push({ jobId: m.jobId, pid: m.pid, label: m.label, state: m.state, startedAt: m.startedAt, finishedAt: m.finishedAt || null, exitCode: m.exitCode }); } catch {} }
  result.sort((a, b) => String(b.startedAt).localeCompare(String(a.startedAt)));
  return { jobs: result, count: result.length };
}
async function killJob(args) {
  const meta = await loadJob(args.job_id);
  if (!IS_WIN) throw new Error("shell_job_kill requires Windows");
  if (!meta.pid) return { jobId: meta.jobId, killed: false, reason: "No recorded PID" };
  const result = await new Promise(resolve => {
    const child = spawn("taskkill.exe", ["/PID", String(meta.pid), "/T", "/F"], { windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "", stderr = "";
    child.stdout.on("data", chunk => stdout += chunk); child.stderr.on("data", chunk => stderr += chunk);
    child.once("error", error => resolve({ code: null, stdout: stdout, stderr: error.message }));
    child.once("close", code => resolve({ code: code, stdout: stdout, stderr: stderr }));
  });
  const killed = result.code === 0;
  if (killed) { meta.state = "terminated"; meta.finishedAt = new Date().toISOString(); await writeJob(meta); }
  return { jobId: meta.jobId, pid: meta.pid, killed: killed, taskkill: result };
}
async function fileList(args) {
  const root = resolvePath(args.path), recursive = args.recursive === true, includeHidden = args.include_hidden !== false;
  const maxEntries = boundedInt(args.max_entries, 5000, 1, 100000, "max_entries"), maxDepth = boundedInt(args.max_depth, 10, 0, 100, "max_depth");
  const entries = []; let truncated = false;
  async function walk(dir, depth) {
    if (entries.length >= maxEntries) { truncated = true; return; }
    const names = await fsp.readdir(dir, { withFileTypes: true }); names.sort((a, b) => a.name.localeCompare(b.name));
    for (const item of names) {
      if (!includeHidden && item.name.startsWith(".")) continue;
      if (entries.length >= maxEntries) { truncated = true; return; }
      const fullPath = path.join(dir, item.name), stat = await fsp.lstat(fullPath);
      const type = stat.isDirectory() ? "directory" : stat.isFile() ? "file" : stat.isSymbolicLink() ? "symlink" : "other";
      const entry = { name: item.name, path: fullPath, relativePath: path.relative(root, fullPath) || ".", type: type, size: stat.size, modifiedAt: stat.mtime.toISOString() };
      if (stat.isSymbolicLink()) entry.symlinkTarget = await fsp.readlink(fullPath).catch(() => null);
      entries.push(entry);
      if (recursive && stat.isDirectory() && !stat.isSymbolicLink() && depth < maxDepth) await walk(fullPath, depth + 1);
    }
  }
  await walk(root, 0); return { root: root, entries: entries, count: entries.length, truncated: truncated };
}
async function manageFs(args) {
  const target = resolvePath(args.path), dest = args.destination === undefined ? undefined : resolvePath(args.destination), recursive = args.recursive === true, force = args.force === true;
  switch (args.operation) {
    case "mkdir": await fsp.mkdir(target, { recursive: recursive, ...(args.mode === undefined ? {} : { mode: args.mode }) }); break;
    case "remove": await fsp.rm(target, { recursive: recursive, force: force }); break;
    case "move":
      if (!dest) throw new Error("destination is required for move");
      if (force) await fsp.rm(dest, { recursive: true, force: true });
      await fsp.mkdir(path.dirname(dest), { recursive: true });
      try { await fsp.rename(target, dest); }
      catch (error) {
        if (!error || error.code !== "EXDEV") throw error;
        const stat = await fsp.lstat(target);
        await fsp.cp(target, dest, { recursive: stat.isDirectory(), force: force, errorOnExist: !force, preserveTimestamps: true, verbatimSymlinks: true });
        await fsp.rm(target, { recursive: stat.isDirectory(), force: true });
      }
      break;
    case "copy":
      if (!dest) throw new Error("destination is required for copy");
      if (force) await fsp.rm(dest, { recursive: true, force: true });
      await fsp.cp(target, dest, { recursive: recursive, force: force, errorOnExist: !force, preserveTimestamps: true, verbatimSymlinks: true }); break;
    case "chmod":
      if (args.mode === undefined) throw new Error("mode is required for chmod");
      if (IS_WIN) throw new Error("chmod is not supported on Windows; use Windows ACL tools explicitly");
      await fsp.chmod(target, args.mode); break;
    case "symlink":
      if (!dest) throw new Error("destination (link target) is required for symlink");
      if (force) await fsp.rm(target, { recursive: true, force: true });
      await fsp.mkdir(path.dirname(target), { recursive: true });
      let linkType = "file";
      if (IS_WIN) { try { if ((await fsp.stat(dest)).isDirectory()) linkType = "junction"; } catch {} }
      await fsp.symlink(dest, target, linkType); break;
    default: throw new Error("Unsupported operation: " + args.operation);
  }
  return { operation: args.operation, path: target, destination: dest || null, recursive: recursive, force: force, mode: args.mode === undefined ? null : args.mode };
}
async function applyPatch(args) {
  const cwd = resolvePath(args.cwd || HOME), flags = ["apply", "--recount", "--whitespace=nowarn"];
  if (args.check_only) flags.push("--check"); if (args.reverse) flags.push("--reverse"); if (args.three_way) flags.push("--3way");
  const child = spawn("git", flags.concat(["-"]), { cwd: cwd, windowsHide: true, stdio: ["pipe", "pipe", "pipe"] });
  let stdout = "", stderr = "";
  child.stdout.on("data", chunk => stdout += chunk); child.stderr.on("data", chunk => stderr += chunk);
  child.stdin.end(args.patch);
  const result = await new Promise((resolve, reject) => { child.once("error", reject); child.once("close", code => resolve({ exitCode: code, stdout: stdout, stderr: stderr })); });
  return Object.assign({ cwd: cwd, checkOnly: args.check_only === true, reverse: args.reverse === true, threeWay: args.three_way === true }, result);
}

async function callCodexAppServer(method, params, timeoutMs) {
  const timeout = boundedInt(timeoutMs, 30000, 1000, 120000, "timeout_ms");
  return await new Promise((resolve, reject) => {
    const child = spawn(CODEX_BIN, ["app-server"], { stdio: ["pipe", "pipe", "pipe"], env: process.env, windowsHide: true, shell: IS_WIN });
    activeChildren.add(child);
    const lines = readline.createInterface({ input: child.stdout, crlfDelay: Infinity });
    let stderr = "", done = false, timer;
    child.stderr.on("data", chunk => { stderr = appendBounded(Buffer.from(stderr), chunk, 200000).toString("utf8"); });
    const finish = (error, value) => {
      if (done) return;
      done = true;
      if (timer) clearTimeout(timer);
      lines.close();
      activeChildren.delete(child);
      try { child.stdin.end(); } catch {}
      if (IS_WIN && child.pid) {
        const killer = spawn("taskkill.exe", ["/PID", String(child.pid), "/T", "/F"], { windowsHide: true, stdio: "ignore" });
        killer.on("error", () => { try { child.kill(); } catch {} });
      } else { try { child.kill(); } catch {} }
      if (error) reject(error); else resolve(value);
    };
    child.once("error", error => { activeChildren.delete(child); finish(error); });
    child.once("exit", (code, signal) => {
      activeChildren.delete(child);
      if (!done) finish(new Error("Codex app-server exited before responding (code=" + code + ", signal=" + signal + "): " + stderr));
    });
    lines.on("line", line => {
      let message;
      try { message = JSON.parse(line); } catch { return; }
      if (message.id === 0) {
        child.stdin.write(JSON.stringify({ method: "initialized", params: {} }) + String.fromCharCode(10));
        child.stdin.write(JSON.stringify({ id: 1, method: method, params: params }) + String.fromCharCode(10));
      } else if (message.id === 1) {
        if (message.error) finish(new Error("Codex app-server error " + message.error.code + ": " + message.error.message));
        else finish(null, message.result);
      }
    });
    timer = setTimeout(() => finish(new Error("Timed out waiting for Codex app-server after " + timeout + "ms: " + stderr)), timeout);
    child.stdin.write(JSON.stringify({ id: 0, method: "initialize", params: { clientInfo: { name: "windows-developer-bridge", title: "Windows Developer Bridge", version: VERSION }, capabilities: { experimentalApi: true } } }) + String.fromCharCode(10));
  });
}
function optionalStringArray(args, name) {
  const value = args[name];
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || value.some(item => typeof item !== "string")) throw new Error(name + " must be an array of strings");
  return value;
}

async function execute(name, args) {
  switch (name) {
    case "bridge_status": return { bridgeVersion: VERSION, pid: process.pid, hostname: os.hostname(), username: os.userInfo().username, platform: process.platform, architecture: process.arch, node: process.version, shell: IS_WIN ? (process.env.WDB_POWERSHELL || "pwsh.exe") : null, home: HOME, dataDir: DATA_DIR, jobDir: JOB_DIR, auditLog: AUDIT_LOG, unlockFile: UNLOCK_FILE, fullAccessUnlocked: await fullAccessUnlocked(), codexBin: CODEX_BIN, jobCount: jobs.size, powershellAvailable: IS_WIN, accessModel: "No filesystem sandbox or command allowlist; operations use the logged-in OS user's permissions." };
    case "shell_exec": return runPowerShell(args);
    case "shell_start": return startJob(args);
    case "shell_job_status": return jobStatus(args);
    case "shell_job_list": return listJobs();
    case "shell_job_kill": return killJob(args);
    case "fs_read": {
      const pathname = resolvePath(args.path), encoding = args.encoding || "utf8", offset = boundedInt(args.offset, 0, 0, Number.MAX_SAFE_INTEGER, "offset"), max = boundedInt(args.max_bytes, 1000000, 1, 64000000, "max_bytes");
      const stat = await fsp.stat(pathname); if (!stat.isFile()) throw new Error("Not a regular file: " + pathname);
      const length = Math.max(0, Math.min(max, stat.size - offset)), handle = await fsp.open(pathname, "r");
      try { const buffer = Buffer.alloc(length), read = await handle.read(buffer, 0, length, offset), data = buffer.subarray(0, read.bytesRead); return { path: pathname, size: stat.size, offset: offset, bytesRead: read.bytesRead, nextOffset: offset + read.bytesRead < stat.size ? offset + read.bytesRead : null, truncated: offset + read.bytesRead < stat.size, encoding: encoding, content: encoding === "base64" ? data.toString("base64") : data.toString("utf8") }; }
      finally { await handle.close(); }
    }
    case "fs_write": {
      const pathname = resolvePath(args.path), content = args.encoding === "base64" ? Buffer.from(args.content, "base64") : Buffer.from(args.content, "utf8");
      if (args.create_parents !== false) await fsp.mkdir(path.dirname(pathname), { recursive: true });
      if (args.append === true) await fsp.appendFile(pathname, content);
      else if (args.atomic !== false) {
        const tmp = path.join(path.dirname(pathname), "." + path.basename(pathname) + "." + crypto.randomBytes(6).toString("hex") + ".tmp");
        try { await fsp.writeFile(tmp, content); await fsp.rename(tmp, pathname); } catch (error) { await fsp.rm(tmp, { force: true }).catch(() => {}); throw error; }
      } else await fsp.writeFile(pathname, content);
      if (args.mode !== undefined && !IS_WIN) await fsp.chmod(pathname, args.mode);
      const stat = await fsp.stat(pathname);
      return { path: pathname, bytesWritten: content.length, size: stat.size, append: args.append === true, atomic: args.append === true ? false : args.atomic !== false };
    }
    case "fs_list": return fileList(args);
    case "fs_stat": {
      const pathname = resolvePath(args.path), s = await fsp.lstat(pathname);
      return { path: pathname, type: s.isDirectory() ? "directory" : s.isFile() ? "file" : s.isSymbolicLink() ? "symlink" : "other", size: s.size, mode: s.mode & 0o7777, createdAt: s.birthtime.toISOString(), modifiedAt: s.mtime.toISOString(), changedAt: s.ctime.toISOString(), accessedAt: s.atime.toISOString(), symlinkTarget: s.isSymbolicLink() ? await fsp.readlink(pathname) : null };
    }
    case "fs_manage": return manageFs(args);
    case "apply_patch": return applyPatch(args);
    case "codex_thread_read": {
      if (typeof args.thread_id !== "string" || !args.thread_id) throw new Error("thread_id is required");
      return callCodexAppServer("thread/read", { threadId: args.thread_id, includeTurns: args.include_turns !== false }, args.timeout_ms);
    }
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
      if (typeof args.thread_id !== "string" || !args.thread_id) throw new Error("thread_id is required");
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
      return { path: AUDIT_LOG, ...(await tailFile(AUDIT_LOG, max).catch(error => error && error.code === "ENOENT" ? { content: "", returnedBytes: 0, truncated: false } : Promise.reject(error))) };
    }
    default: throw Object.assign(new Error("Unknown tool: " + name), { code: -32601 });
  }
}
async function handle(message) {
  if (!message || typeof message !== "object" || Array.isArray(message)) return;
  const id = message.id, method = message.method;
  if (typeof method !== "string") { fail(id, -32600, "Invalid Request"); return; }
  if (method.startsWith("notifications/")) return;
  if (method === "initialize") {
    ok(id, { protocolVersion: message.params && message.params.protocolVersion ? message.params.protocolVersion : "2025-11-25", capabilities: { tools: { listChanged: false } }, serverInfo: { name: "windows-developer-bridge", version: VERSION }, instructions: "Windows-first local MCP bridge. This scaffold is not a complete MDB mirror. Commands and file operations use the logged-in OS user's permissions; no filesystem sandbox is provided." });
    return;
  }
  if (method === "ping") { ok(id, {}); return; }
  if (method === "tools/list") { ok(id, { tools: TOOLS }); return; }
  if (method === "tools/call") {
    const name = message.params && message.params.name, args = message.params && message.params.arguments ? message.params.arguments : {};
    if (typeof name !== "string" || !args || typeof args !== "object" || Array.isArray(args)) { fail(id, -32602, "Invalid params: tool name and object arguments are required"); return; }
    try {
      if (name !== "bridge_status") await requireFullAccess();
      const result = await execute(name, args);
      const argsHash = crypto.createHash("sha256").update(JSON.stringify(args)).digest("hex").slice(0, 16);
      await audit("tool_call", { tool: name, argumentKeys: Object.keys(args), argsHash: argsHash }).catch(() => {});
      ok(id, textResult(result));
    }
    catch (error) {
      await audit("tool_error", { tool: name, message: error && error.message ? error.message : String(error) }).catch(() => {});
      ok(id, Object.assign(textResult({ error: error && error.message ? error.message : String(error), code: error && error.code ? error.code : "TOOL_ERROR" }), { isError: true }));
    }
    return;
  }
  if (method === "resources/list") { ok(id, { resources: [] }); return; }
  if (method === "prompts/list") { ok(id, { prompts: [] }); return; }
  if (id !== undefined) fail(id, -32601, "Method not found: " + method);
}
async function main() {
  await fsp.mkdir(DATA_DIR, { recursive: true }).catch(() => {});
  const revocationPoll = setInterval(async () => { if (!(await fullAccessUnlocked().catch(() => false))) await revokeKnownJobs().catch(() => {}); }, 3000);
  revocationPoll.unref();
  const rl = readline.createInterface({ input: process.stdin, crlfDelay: Infinity, terminal: false });
  rl.on("line", line => {
    if (!line.trim()) return;
    requestChain = requestChain.then(async () => {
      let message;
      try { message = JSON.parse(line); } catch { fail(null, -32700, "Parse error"); return; }
      await handle(message);
    }).catch(error => { process.stderr.write("request error: " + (error && error.stack ? error.stack : error) + "\n"); });
  });
  rl.on("close", () => { process.exitCode = 0; });
}
main().catch(error => { process.stderr.write((error && error.stack ? error.stack : error) + "\n"); process.exitCode = 1; });
