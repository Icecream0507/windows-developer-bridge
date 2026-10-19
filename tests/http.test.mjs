import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
function freePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const port = server.address().port;
      server.close(error => error ? reject(error) : resolve(port));
    });
  });
}

test("HTTP adapter health, bearer auth, initialize, and tools/list", async t => {
  const port = await freePort();
  const token = randomBytes(32).toString("hex");
  const dataDir = await mkdtemp(path.join(os.tmpdir(), "wdb-http-test-"));
  const child = spawn(process.execPath, [path.join(ROOT, "mcp-http.mjs")], {
    cwd: ROOT,
    env: { ...process.env, WDB_HTTP_TOKEN: token, WDB_HTTP_PORT: String(port), WDB_DATA_DIR: dataDir },
    stdio: ["ignore", "ignore", "pipe"],
  });
  let stderr = "";
  child.stderr.on("data", chunk => { stderr += chunk.toString(); });
  t.after(async () => {
    if (child.exitCode === null) {
      child.kill("SIGTERM");
      await Promise.race([
        new Promise(resolve => child.once("exit", resolve)),
        new Promise(resolve => setTimeout(resolve, 1500)),
      ]);
    }
    await rm(dataDir, { recursive: true, force: true });
  });

  const base = `http://127.0.0.1:${port}`;
  let ready = false;
  for (let i = 0; i < 100; i++) {
    if (child.exitCode !== null) assert.fail(`HTTP server exited early: ${stderr}`);
    try {
      const response = await fetch(`${base}/healthz`);
      if (response.ok) { ready = true; break; }
    } catch {}
    await new Promise(resolve => setTimeout(resolve, 30));
  }
  assert.equal(ready, true, `HTTP server did not become ready: ${stderr}`);
  assert.equal((await fetch(`${base}/healthz`).then(r => r.json())).ok, true);

  const unauthenticated = await fetch(`${base}/mcp`, {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "ping" }),
  });
  assert.equal(unauthenticated.status, 401);

  const headers = { "content-type": "application/json", authorization: `Bearer ${token}` };
  const initialized = await fetch(`${base}/mcp`, {
    method: "POST", headers,
    body: JSON.stringify({ jsonrpc: "2.0", id: 2, method: "initialize", params: { protocolVersion: "2025-11-25" } }),
  });
  assert.equal(initialized.status, 200);
  assert.equal((await initialized.json()).result.serverInfo.name, "windows-developer-bridge");

  const listed = await fetch(`${base}/mcp`, {
    method: "POST", headers,
    body: JSON.stringify({ jsonrpc: "2.0", id: 3, method: "tools/list" }),
  });
  const payload = await listed.json();
  assert.equal(listed.status, 200);
  assert.ok(payload.result.tools.some(item => item.name === "bridge_status"));
});
