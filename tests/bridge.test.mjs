import test from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import { spawnSync } from "node:child_process";
import { BRIDGE, IS_WIN, startBridge, tempDir, waitFor } from "./helpers.mjs";

const ALL_TOOLS = ["bridge_status", "shell_exec", "shell_start", "shell_job_status", "shell_job_list", "shell_job_kill", "fs_read", "fs_write", "fs_list", "fs_stat", "fs_manage", "apply_patch", "pty_start", "pty_read", "pty_write", "pty_resize", "pty_signal", "pty_close", "pty_list", "codex_thread_read", "codex_thread_list", "codex_thread_turns_list", "audit_tail"];
const hasGit = spawnSync("git", ["--version"]).status === 0;

test("syntax, initialize negotiation and tools/list", async t => {
  assert.equal(spawnSync(process.execPath, ["--check", BRIDGE], { encoding: "utf8" }).status, 0);
  const bridge = await startBridge();
  t.after(() => bridge.close());
  const init = await bridge.request("initialize", { protocolVersion: "2025-06-18" });
  assert.equal(init.result.protocolVersion, "2025-06-18");
  assert.equal(init.result.serverInfo.name, "windows-developer-bridge");
  const future = await bridge.request("initialize", { protocolVersion: "2099-01-01" });
  assert.equal(future.result.protocolVersion, "2025-11-25");
  const listed = await bridge.request("tools/list");
  const names = listed.result.tools.map(item => item.name);
  for (const name of ALL_TOOLS) assert.ok(names.includes(name), "missing tool " + name);
  for (const item of listed.result.tools) assert.equal(item.inputSchema.additionalProperties, false, item.name);
});

test("bridge_status reports host, shell and lock state", async t => {
  const bridge = await startBridge();
  t.after(() => bridge.close());
  const status = await bridge.tool("bridge_status");
  assert.equal(status.platform, process.platform);
  assert.equal(status.bridgeVersion, "0.2.0");
  assert.equal(status.fullAccessUnlocked, true);
  assert.ok(status.accessModel);
  if (IS_WIN) {
    assert.ok(status.shell && fs.existsSync(status.shell), "resolved PowerShell must exist: " + status.shell);
    assert.equal(status.powershellAvailable, true);
  }
});

test("argument validation, null optionals and unknown tools", async t => {
  const bridge = await startBridge();
  t.after(() => bridge.close());
  const unknownArg = await bridge.call("fs_stat", { path: os.tmpdir(), bogus: 1 });
  assert.equal(unknownArg.isError, true);
  assert.equal(unknownArg.structuredContent.code, "INVALID_ARGUMENT");
  const missing = await bridge.call("fs_read", {});
  assert.equal(missing.structuredContent.code, "INVALID_ARGUMENT");
  const wrongType = await bridge.call("fs_read", { path: os.tmpdir(), max_bytes: "10" });
  assert.equal(wrongType.structuredContent.code, "INVALID_ARGUMENT");
  const nullOptional = await bridge.tool("fs_list", { path: os.tmpdir(), recursive: null, max_entries: null });
  assert.ok(Array.isArray(nullOptional.entries));
  const unknownTool = await bridge.request("tools/call", { name: "nope", arguments: {} });
  assert.equal(unknownTool.error.code, -32602);
});

test("filesystem write/read pagination and UTF-8 boundaries", async t => {
  const bridge = await startBridge();
  const dir = tempDir();
  t.after(async () => { await bridge.close(); fs.rmSync(dir, { recursive: true, force: true }); });
  const filename = path.join(dir, "nested", "roundtrip.txt");
  assert.equal((await bridge.tool("fs_write", { path: filename, content: "abcdef" })).bytesWritten, 6);
  const page = await bridge.tool("fs_read", { path: filename, offset: 1, max_bytes: 3 });
  assert.equal(page.content, "bcd");
  assert.equal(page.nextOffset, 4);
  assert.equal(page.truncated, true);
  await bridge.tool("fs_write", { path: filename, content: "a中b" });
  const first = await bridge.tool("fs_read", { path: filename, max_bytes: 2 });
  assert.equal(first.content, "a");
  assert.equal(first.nextOffset, 1);
  const rest = await bridge.tool("fs_read", { path: filename, offset: first.nextOffset });
  assert.equal(rest.content, "中b");
  await bridge.tool("fs_write", { path: filename, content: "+tail", append: true });
  assert.equal((await bridge.tool("fs_read", { path: filename })).content, "a中b+tail");
  const missing = await bridge.tool("fs_stat", { path: path.join(dir, "missing.txt") });
  assert.equal(missing.exists, false);
  const listing = await bridge.tool("fs_list", { path: dir, recursive: true });
  assert.ok(listing.entries.some(entry => entry.relativePath === path.join("nested", "roundtrip.txt")));
  const notDir = await bridge.call("fs_list", { path: filename });
  assert.equal(notDir.structuredContent.code, "NOT_A_DIRECTORY");
});

test("fs_manage copy/move create parents and refuse silent overwrite", async t => {
  const bridge = await startBridge();
  const dir = tempDir();
  t.after(async () => { await bridge.close(); fs.rmSync(dir, { recursive: true, force: true }); });
  const src = path.join(dir, "src.txt");
  fs.writeFileSync(src, "payload");
  const copy = path.join(dir, "a", "b", "copy.txt");
  await bridge.tool("fs_manage", { operation: "copy", path: src, destination: copy });
  assert.equal(fs.readFileSync(copy, "utf8"), "payload");
  const moved = path.join(dir, "c", "moved.txt");
  await bridge.tool("fs_manage", { operation: "move", path: copy, destination: moved });
  assert.equal(fs.existsSync(copy), false);
  const clash = await bridge.call("fs_manage", { operation: "move", path: src, destination: moved });
  assert.equal(clash.isError, true);
  await bridge.tool("fs_manage", { operation: "move", path: src, destination: moved, force: true });
  await bridge.tool("fs_manage", { operation: "chmod", path: moved, mode: 0o444 });
  assert.equal((await bridge.tool("fs_stat", { path: moved })).mode & 0o200, 0);
  await bridge.tool("fs_manage", { operation: "chmod", path: moved, mode: 0o644 });
  fs.mkdirSync(path.join(dir, "tree", "x"), { recursive: true });
  const dirCopy = await bridge.call("fs_manage", { operation: "copy", path: path.join(dir, "tree"), destination: path.join(dir, "tree2") });
  assert.equal(dirCopy.isError, true, "directory copy without recursive must fail clearly");
  await bridge.tool("fs_manage", { operation: "copy", path: path.join(dir, "tree"), destination: path.join(dir, "tree2"), recursive: true });
  assert.ok(fs.existsSync(path.join(dir, "tree2", "x")));
  await bridge.tool("fs_manage", { operation: "symlink", path: path.join(dir, "link"), destination: path.join(dir, "tree") });
  assert.equal((await bridge.tool("fs_stat", { path: path.join(dir, "link") })).type, "symlink");
  await bridge.tool("fs_manage", { operation: "remove", path: path.join(dir, "tree2"), recursive: true });
  assert.equal(fs.existsSync(path.join(dir, "tree2")), false);
});

test("apply_patch applies the Codex '*** Begin Patch' format natively", async t => {
  const bridge = await startBridge();
  const dir = tempDir();
  t.after(async () => { await bridge.close(); fs.rmSync(dir, { recursive: true, force: true }); });
  fs.writeFileSync(path.join(dir, "app.py"), "def greet():\r\n    return 'hi'\r\n\r\nprint(greet())\r\n");
  fs.writeFileSync(path.join(dir, "old.txt"), "bye\n");
  fs.writeFileSync(path.join(dir, "rename.txt"), "one\ntwo\n");
  const patch = [
    "*** Begin Patch",
    "*** Add File: docs/new.md",
    "+# Title",
    "+中文内容",
    "*** Update File: app.py",
    "@@ def greet():",
    "-    return 'hi'",
    "+    return 'hello'",
    "*** Delete File: old.txt",
    "*** Update File: rename.txt",
    "*** Move to: moved/renamed.txt",
    "@@",
    " one",
    "-two",
    "+three",
    "*** End Patch",
  ].join("\n");
  const checked = await bridge.tool("apply_patch", { patch, cwd: dir, check_only: true });
  assert.equal(checked.applied, false);
  assert.equal(fs.existsSync(path.join(dir, "docs", "new.md")), false);
  const applied = await bridge.tool("apply_patch", { patch, cwd: dir });
  assert.deepEqual(applied.files.map(file => file.action), ["add", "update", "delete", "move"]);
  assert.equal(fs.readFileSync(path.join(dir, "docs", "new.md"), "utf8"), "# Title\n中文内容\n");
  assert.equal(fs.readFileSync(path.join(dir, "app.py"), "utf8"), "def greet():\r\n    return 'hello'\r\n\r\nprint(greet())\r\n", "CRLF must be preserved");
  assert.equal(fs.existsSync(path.join(dir, "old.txt")), false);
  assert.equal(fs.readFileSync(path.join(dir, "moved", "renamed.txt"), "utf8"), "one\nthree\n");
  const bad = await bridge.call("apply_patch", { cwd: dir, patch: "*** Begin Patch\n*** Add File: z.txt\n+z\n*** Update File: app.py\n-not there\n+x\n*** End Patch" });
  assert.equal(bad.isError, true);
  assert.equal(bad.structuredContent.code, "PATCH_FAILED");
  assert.equal(fs.existsSync(path.join(dir, "z.txt")), false, "failed patch must not write anything");
});

test("apply_patch applies unified diffs with git relative to cwd", { skip: !hasGit }, async t => {
  const bridge = await startBridge();
  const dir = tempDir();
  t.after(async () => { await bridge.close(); fs.rmSync(dir, { recursive: true, force: true }); });
  spawnSync("git", ["init", "-q"], { cwd: dir });
  fs.mkdirSync(path.join(dir, "pkg"));
  fs.writeFileSync(path.join(dir, "pkg", "a.txt"), "one\ntwo\n");
  const diff = "--- a/a.txt\n+++ b/a.txt\n@@ -1,2 +1,2 @@\n one\n-two\n+2\n";
  const result = await bridge.tool("apply_patch", { patch: diff, cwd: path.join(dir, "pkg") });
  assert.equal(result.format, "unified");
  assert.equal(fs.readFileSync(path.join(dir, "pkg", "a.txt"), "utf8"), "one\n2\n");
  const failed = await bridge.call("apply_patch", { patch: diff, cwd: path.join(dir, "pkg") });
  assert.equal(failed.structuredContent.code, "PATCH_FAILED");
});

test("audit records tool metadata without storing file payloads", async t => {
  const bridge = await startBridge();
  const dir = tempDir();
  t.after(async () => { await bridge.close(); fs.rmSync(dir, { recursive: true, force: true }); });
  const marker = "secret-unique-value-for-audit-test";
  await bridge.tool("fs_write", { path: path.join(dir, "secret.txt"), content: marker });
  const log = (await bridge.tool("audit_tail", { max_bytes: 8000 })).content;
  const details = log.trim().split(/\r?\n/).filter(Boolean).map(line => JSON.parse(JSON.parse(line).details));
  const writeRecord = details.find(item => item.tool === "fs_write");
  assert.ok(writeRecord, "fs_write audit record should exist");
  assert.match(writeRecord.argsHash, /^[a-f0-9]{16}$/);
  assert.equal(log.includes(marker), false);
});

test("full-access latch is fail-closed when unlock file is absent", async t => {
  const bridge = await startBridge({ unlocked: false });
  t.after(() => bridge.close());
  assert.equal((await bridge.tool("bridge_status")).fullAccessUnlocked, false);
  const locked = await bridge.call("fs_read", { path: BRIDGE });
  assert.equal(locked.isError, true);
  assert.equal(locked.structuredContent.code, "FULL_ACCESS_LOCKED");
});

test("full-access latch does not accept a symlink as an unlock file", { skip: IS_WIN }, async t => {
  const dataDir = tempDir("wdb-unlock-link-");
  const target = path.join(dataDir, "target.txt");
  fs.writeFileSync(target, "not an unlock");
  fs.symlinkSync(target, path.join(dataDir, "FULL_ACCESS_ENABLED"));
  const bridge = await startBridge({ dataDir });
  t.after(async () => { await bridge.close(); fs.rmSync(dataDir, { recursive: true, force: true }); });
  assert.equal((await bridge.tool("bridge_status")).fullAccessUnlocked, false);
  assert.equal((await bridge.call("fs_read", { path: BRIDGE })).structuredContent.code, "FULL_ACCESS_LOCKED");
});

test("PowerShell commands fail closed when not running on Windows", { skip: IS_WIN }, async t => {
  const bridge = await startBridge();
  t.after(() => bridge.close());
  const result = await bridge.call("shell_exec", { command: "Write-Output test" });
  assert.equal(result.isError, true);
  assert.match(result.structuredContent.error, /requires Windows/);
});

test("Codex app-server request handshake and thread-list mapping", async t => {
  const dir = tempDir("wdb-codex-");
  const script = path.join(dir, "fake-codex.js");
  fs.writeFileSync(script, [
    "const readline = require('node:readline');",
    "const rl = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });",
    "process.stdout.write(JSON.stringify({ method: 'remoteControl/status/changed', params: {} }) + '\\n');",
    "rl.on('line', line => { let m; try { m = JSON.parse(line); } catch { return; } if (m.id === 0) process.stdout.write(JSON.stringify({ id: 0, result: {} }) + '\\n'); else if (m.id === 1) process.stdout.write(JSON.stringify({ id: 1, result: { method: m.method, params: m.params } }) + '\\n'); });",
  ].join("\n"));
  let fake;
  if (IS_WIN) { fake = path.join(dir, "fake codex.cmd"); fs.writeFileSync(fake, "@\"" + process.execPath + "\" \"%~dp0fake-codex.js\" %*\r\n"); }
  else { fake = path.join(dir, "fake-codex"); fs.writeFileSync(fake, "#!/bin/sh\nexec \"" + process.execPath + "\" \"" + script + "\" \"$@\"\n"); fs.chmodSync(fake, 0o755); }
  const bridge = await startBridge({ env: { CODEX_BIN: fake } });
  t.after(async () => { await bridge.close(); fs.rmSync(dir, { recursive: true, force: true }); });
  const result = await bridge.tool("codex_thread_list", { limit: 7, search_term: "needle" });
  assert.equal(result.method, "thread/list");
  assert.equal(result.params.limit, 7);
  assert.equal(result.params.searchTerm, "needle");
  assert.equal(result.params.sortKey, "recency_at");
  assert.equal(result.params.sortDirection, "desc");
});

test("PowerShell: UTF-8 output, stdin and exit codes", { skip: !IS_WIN }, async t => {
  const bridge = await startBridge();
  t.after(() => bridge.close());
  const echo = await bridge.tool("shell_exec", { command: "$x = [Console]::In.ReadToEnd(); Write-Output ('wdb-smoke:' + $x); Write-Output '中文输出'; cmd /c echo 汉字", stdin: "标准输入", timeout_ms: 30000 });
  assert.equal(echo.exitCode, 0);
  assert.match(echo.stdout, /wdb-smoke:标准输入/);
  assert.match(echo.stdout, /中文输出/);
  assert.match(echo.stdout, /汉字/);
  assert.equal((await bridge.tool("shell_exec", { command: "Write-Output a\nexit 7\nWrite-Output b" })).exitCode, 7);
  assert.equal((await bridge.tool("shell_exec", { command: "cmd /c exit 3" })).exitCode, 3);
  const thrown = await bridge.tool("shell_exec", { command: "throw 'boom'" });
  assert.equal(thrown.exitCode, 1);
  assert.match(thrown.stderr, /boom/);
  const cwd = await bridge.tool("shell_exec", { command: "(Get-Location).Path", cwd: os.tmpdir() });
  assert.equal(cwd.stdout.trim().toLowerCase(), path.resolve(os.tmpdir()).toLowerCase());
  const env = await bridge.tool("shell_exec", { command: "Write-Output $env:WDB_TEST_VAR", env: { WDB_TEST_VAR: "env-ok" } });
  assert.equal(env.stdout.trim(), "env-ok");
  const badCwd = await bridge.call("shell_exec", { command: "Write-Output x", cwd: path.join(os.tmpdir(), "definitely-missing-" + Date.now()) });
  assert.equal(badCwd.structuredContent.code, "INVALID_CWD");
});

test("PowerShell: timeout, output caps and concurrent requests", { skip: !IS_WIN }, async t => {
  const bridge = await startBridge();
  t.after(() => bridge.close());
  const slow = bridge.tool("shell_exec", { command: "Start-Sleep -Seconds 4; Write-Output slow-done", timeout_ms: 20000 });
  const startedAt = Date.now();
  const status = await bridge.tool("bridge_status");
  assert.ok(Date.now() - startedAt < 3500, "bridge_status must not wait for the running shell_exec");
  assert.equal(status.platform, "win32");
  assert.match((await slow).stdout, /slow-done/);
  const timedOut = await bridge.tool("shell_exec", { command: "Start-Sleep -Seconds 20", timeout_ms: 800 });
  assert.equal(timedOut.timedOut, true);
  assert.ok(timedOut.durationMs < 15000);
  const big = await bridge.tool("shell_exec", { command: "1..5000 | ForEach-Object { 'line-' + $_ }", max_output_bytes: 2048 });
  assert.equal(big.outputTruncated, true);
  assert.match(big.stdout, /line-1\r?\n/);
  assert.match(big.stdout, /line-5000/);
  assert.match(big.stdout, /bytes omitted/);
});

test("Background jobs record exit codes, page logs and can be killed", { skip: !IS_WIN }, async t => {
  const bridge = await startBridge();
  t.after(() => bridge.close());
  const job = await bridge.tool("shell_start", { command: "Write-Output '任务输出'\nWrite-Output second\nexit 3", label: "exit-three" });
  const done = await bridge.tool("shell_job_status", { job_id: job.jobId, wait_ms: 30000 });
  assert.equal(done.state, "exited");
  assert.equal(done.exitCode, 3);
  assert.match(done.stdout, /任务输出/);
  const firstPage = await bridge.tool("shell_job_status", { job_id: job.jobId, stdout_offset: 0, max_log_bytes: 1024 });
  assert.equal(firstPage.stdoutNextOffset, firstPage.stdoutSize);
  const listed = await bridge.tool("shell_job_list");
  assert.ok(listed.jobs.some(item => item.jobId === job.jobId && item.exitCode === 3));
  const longJob = await bridge.tool("shell_start", { command: "ping -n 60 127.0.0.1" });
  assert.equal((await bridge.tool("shell_job_status", { job_id: longJob.jobId })).state, "running");
  const killed = await bridge.tool("shell_job_kill", { job_id: longJob.jobId });
  assert.equal(killed.killed, true);
  assert.equal((await bridge.tool("shell_job_status", { job_id: longJob.jobId })).state, "terminated");
  const unknown = await bridge.call("shell_job_status", { job_id: "00000000-0000-0000-0000-000000000000" });
  assert.equal(unknown.structuredContent.code, "JOB_NOT_FOUND");
});

test("ConPTY terminal tools work through the bridge", { skip: !IS_WIN }, async t => {
  const bridge = await startBridge();
  t.after(() => bridge.close());
  const session = await bridge.tool("pty_start", { cols: 100, rows: 30 });
  t.after(() => bridge.call("pty_close", { session_id: session.session_id }).catch(() => {}));
  await bridge.tool("pty_write", { session_id: session.session_id, data: "Write-Output ('pty-' + (6*7))\r" });
  let text = "";
  await waitFor(async () => {
    const chunk = await bridge.tool("pty_read", { session_id: session.session_id, wait_ms: 2000, strip_ansi: true });
    text += chunk.data;
    return text.includes("pty-42");
  }, { timeout: 30000 });
  assert.equal((await bridge.tool("pty_resize", { session_id: session.session_id, cols: 90, rows: 20 })).applied, true);
  assert.equal((await bridge.tool("pty_list")).count, 1);
  const closed = await bridge.tool("pty_close", { session_id: session.session_id });
  assert.equal(closed.closed, true);
  assert.equal((await bridge.call("pty_read", { session_id: session.session_id })).structuredContent.code, "PTY_NOT_FOUND");
});
