import test from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const bridge = path.join(root, "bridge.mjs");
function request(method, id, params) {
  return { jsonrpc: "2.0", id: id, method: method, ...(params === undefined ? {} : { params: params }) };
}
function runMessages(messages, envOverrides = {}) {
  const ownsDataDir = !envOverrides.WDB_DATA_DIR;
  const dataDir = ownsDataDir ? fs.mkdtempSync(path.join(os.tmpdir(), "wdb-test-data-")) : envOverrides.WDB_DATA_DIR;
  if (ownsDataDir) fs.writeFileSync(path.join(dataDir, "FULL_ACCESS_ENABLED"), "explicit test-only unlock");
  const input = messages.map(item => JSON.stringify(item)).join(String.fromCharCode(10)) + String.fromCharCode(10);
  try {
    const result = spawnSync(process.execPath, [bridge], { cwd: root, env: Object.assign({}, process.env, { WDB_DATA_DIR: dataDir }, envOverrides), input: input, encoding: "utf8", timeout: 10000, maxBuffer: 4 * 1024 * 1024 });
    assert.equal(result.error, undefined, result.error && result.error.message);
    assert.equal(result.status, 0, result.stderr);
    return result.stdout.trim().split(/\r?\n/).filter(Boolean).map(line => JSON.parse(line));
  } finally {
    if (ownsDataDir) fs.rmSync(dataDir, { recursive: true, force: true });
  }
}

test("syntax and MCP initialize/tools list work", () => {
  const check = spawnSync(process.execPath, ["--check", bridge], { encoding: "utf8" });
  assert.equal(check.status, 0, check.stderr);
  const output = runMessages([
    request("initialize", 1, { protocolVersion: "2025-11-25" }),
    request("tools/list", 2),
  ]);
  assert.equal(output[0].result.serverInfo.name, "windows-developer-bridge");
  const names = output[1].result.tools.map(item => item.name);
  for (const name of ["bridge_status", "shell_exec", "shell_start", "shell_job_status", "shell_job_list", "shell_job_kill", "fs_read", "fs_write", "fs_list", "fs_stat", "fs_manage", "apply_patch", "codex_thread_read", "codex_thread_list", "codex_thread_turns_list", "audit_tail"]) {
    assert.ok(names.includes(name), "missing tool " + name);
  }
});

test("status reports host and tool call uses MCP result envelope", () => {
  const output = runMessages([
    request("initialize", 1, { protocolVersion: "2025-11-25" }),
    request("tools/call", 2, { name: "bridge_status", arguments: {} }),
  ]);
  const result = output[1].result;
  assert.equal(result.structuredContent.platform, process.platform);
  assert.equal(result.structuredContent.bridgeVersion, "0.1.0");
  assert.ok(result.content[0].text.includes("accessModel"));
});

test("filesystem write/read pagination round trip", () => {
  const dir = path.join(os.tmpdir(), "wdb-test-" + randomUUID());
  const filename = path.join(dir, "roundtrip.txt");
  try {
    const output = runMessages([
      request("initialize", 1, { protocolVersion: "2025-11-25" }),
      request("tools/call", 2, { name: "fs_write", arguments: { path: filename, content: "abcdef", atomic: true } }),
      request("tools/call", 3, { name: "fs_read", arguments: { path: filename, offset: 1, max_bytes: 3 } }),
    ]);
    assert.equal(output[1].result.structuredContent.bytesWritten, 6);
    assert.equal(output[2].result.structuredContent.content, "bcd");
    assert.equal(output[2].result.structuredContent.nextOffset, 4);
    assert.equal(output[2].result.structuredContent.truncated, true);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});


test("audit records tool metadata without storing file payloads", () => {
  const dir = path.join(os.tmpdir(), "wdb-audit-" + randomUUID());
  const filename = path.join(dir, "secret.txt");
  const marker = "secret-unique-value-for-audit-test";
  try {
    const output = runMessages([
      request("initialize", 1, { protocolVersion: "2025-11-25" }),
      request("tools/call", 2, { name: "fs_write", arguments: { path: filename, content: marker } }),
      request("tools/call", 3, { name: "audit_tail", arguments: { max_bytes: 8000 } }),
    ]);
    const log = output[2].result.structuredContent.content;
    const records = log.trim().split(/\r?\n/).filter(Boolean).map(line => JSON.parse(line));
    const details = records.map(record => JSON.parse(record.details));
    const writeRecord = details.find(item => item.tool === "fs_write");
    assert.ok(writeRecord, "fs_write audit record should exist");
    assert.match(writeRecord.argsHash, /^[a-f0-9]{16}$/);
    assert.equal(log.includes(marker), false);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});


test("full-access latch is fail-closed when unlock file is absent", () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "wdb-locked-"));
  try {
    const output = runMessages([
      request("initialize", 1, { protocolVersion: "2025-11-25" }),
      request("tools/call", 2, { name: "bridge_status", arguments: {} }),
      request("tools/call", 3, { name: "fs_read", arguments: { path: bridge } }),
    ], { WDB_DATA_DIR: dataDir });
    assert.equal(output[1].result.structuredContent.fullAccessUnlocked, false);
    assert.equal(output[2].result.isError, true);
    assert.equal(output[2].result.structuredContent.code, "FULL_ACCESS_LOCKED");
  } finally {
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});


test("full-access latch does not accept a symlink as an unlock file", { skip: process.platform === "win32" }, () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "wdb-unlock-link-"));
  const target = path.join(dataDir, "target.txt");
  try {
    fs.writeFileSync(target, "not an unlock");
    fs.symlinkSync(target, path.join(dataDir, "FULL_ACCESS_ENABLED"));
    const output = runMessages([
      request("initialize", 1, { protocolVersion: "2025-11-25" }),
      request("tools/call", 2, { name: "bridge_status", arguments: {} }),
      request("tools/call", 3, { name: "fs_read", arguments: { path: bridge } }),
    ], { WDB_DATA_DIR: dataDir });
    assert.equal(output[1].result.structuredContent.fullAccessUnlocked, false);
    assert.equal(output[2].result.structuredContent.code, "FULL_ACCESS_LOCKED");
  } finally {
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});

test("PowerShell commands fail closed when not running on Windows", { skip: process.platform === "win32" }, () => {
  const output = runMessages([
    request("initialize", 1, { protocolVersion: "2025-11-25" }),
    request("tools/call", 2, { name: "shell_exec", arguments: { command: "Write-Output test" } }),
  ]);
  assert.equal(output[1].result.isError, true);
  assert.match(output[1].result.structuredContent.error, /requires Windows/);
});



test("Codex app-server request handshake and thread-list mapping", { skip: process.platform === "win32" }, () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "wdb-codex-"));
  const fake = path.join(dir, "fake-codex");
  const script = [
    "#!/usr/bin/env node",
    "const readline = require('node:readline');",
    "const rl = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });",
    "rl.on('line', line => { let m; try { m = JSON.parse(line); } catch { return; } if (m.id === 0) process.stdout.write(JSON.stringify({ id: 0, result: {} }) + String.fromCharCode(10)); else if (m.id === 1) process.stdout.write(JSON.stringify({ id: 1, result: { method: m.method, params: m.params } }) + String.fromCharCode(10)); });"
  ].join(String.fromCharCode(10));
  try {
    fs.writeFileSync(fake, script, "utf8");
    fs.chmodSync(fake, 0o755);
    const output = runMessages([
      request("initialize", 1, { protocolVersion: "2025-11-25" }),
      request("tools/call", 2, { name: "codex_thread_list", arguments: { limit: 7, search_term: "needle" } }),
    ], { CODEX_BIN: fake });
    const result = output[1].result.structuredContent;
    assert.equal(result.method, "thread/list");
    assert.equal(result.params.limit, 7);
    assert.equal(result.params.searchTerm, "needle");
    assert.equal(result.params.sortKey, "recency_at");
    assert.equal(result.params.sortDirection, "desc");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("PowerShell executes commands and forwards stdin on Windows", { skip: process.platform !== "win32" }, () => {
  const output = runMessages([
    request("initialize", 1, { protocolVersion: "2025-11-25" }),
    request("tools/call", 2, { name: "shell_exec", arguments: { command: "$x = [Console]::In.ReadToEnd(); Write-Output ('wdb-smoke:' + $x)", stdin: "stdin-value", timeout_ms: 10000, max_output_bytes: 4096 } }),
  ]);
  const result = output[1].result.structuredContent;
  assert.equal(output[1].result.isError, undefined);
  assert.equal(result.exitCode, 0);
  assert.match(result.stdout, /wdb-smoke:stdin-value/);
});

test("PowerShell timeout is reported on Windows", { skip: process.platform !== "win32" }, () => {
  const output = runMessages([
    request("initialize", 1, { protocolVersion: "2025-11-25" }),
    request("tools/call", 2, { name: "shell_exec", arguments: { command: "Start-Sleep -Seconds 10", timeout_ms: 500, max_output_bytes: 4096 } }),
  ]);
  const result = output[1].result.structuredContent;
  assert.equal(result.timedOut, true);
});
