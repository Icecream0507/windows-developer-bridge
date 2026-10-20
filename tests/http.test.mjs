import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
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

async function startHttp(t, env = {}) {
  const port = await freePort();
  const token = randomBytes(32).toString("hex");
  const dataDir = await mkdtemp(path.join(os.tmpdir(), "wdb-http-test-"));
  await writeFile(path.join(dataDir, "FULL_ACCESS_ENABLED"), "test");
  const child = spawn(process.execPath, [path.join(ROOT, "mcp-http.mjs")], {
    cwd: ROOT,
    env: { ...process.env, WDB_HTTP_TOKEN: token, WDB_HTTP_PORT: String(port), WDB_DATA_DIR: dataDir, WDB_HTTP_PUBLIC_URL: "", ...env },
    stdio: ["ignore", "ignore", "pipe"],
  });
  let stderr = "";
  child.stderr.on("data", chunk => { stderr += chunk.toString(); });
  t.after(async () => {
    if (child.exitCode === null) {
      child.kill("SIGTERM");
      await Promise.race([new Promise(resolve => child.once("exit", resolve)), new Promise(resolve => setTimeout(resolve, 1500))]);
    }
    await rm(dataDir, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
  });
  const base = `http://127.0.0.1:${port}`;
  for (let i = 0; i < 200; i++) {
    if (child.exitCode !== null) assert.fail(`HTTP server exited early: ${stderr}`);
    try { if ((await fetch(`${base}/healthz`)).ok) return { base, token, stderr: () => stderr }; } catch {}
    await new Promise(resolve => setTimeout(resolve, 30));
  }
  assert.fail(`HTTP server did not become ready: ${stderr}`);
}

function parseSse(text) {
  return text.split(/\n\n/).map(block => block.split("\n").filter(line => line.startsWith("data: ")).map(line => line.slice(6)).join("\n")).filter(Boolean).map(data => JSON.parse(data));
}

test("HTTP adapter health, bearer auth, initialize, and tools/list", async t => {
  const { base, token } = await startHttp(t);
  assert.equal((await fetch(`${base}/healthz`).then(r => r.json())).ok, true);
  const unauthenticated = await fetch(`${base}/mcp`, {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "ping" }),
  });
  assert.equal(unauthenticated.status, 401);
  const wrong = await fetch(`${base}/mcp`, {
    method: "POST", headers: { "content-type": "application/json", authorization: "Bearer " + "x".repeat(64) },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "ping" }),
  });
  assert.equal(wrong.status, 401);

  const headers = { "content-type": "application/json", authorization: `Bearer ${token}` };
  const initialized = await fetch(`${base}/mcp`, {
    method: "POST", headers,
    body: JSON.stringify({ jsonrpc: "2.0", id: 2, method: "initialize", params: { protocolVersion: "2025-11-25" } }),
  });
  assert.equal(initialized.status, 200);
  assert.equal((await initialized.json()).result.serverInfo.name, "windows-developer-bridge");
  const note = await fetch(`${base}/mcp`, { method: "POST", headers, body: JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) });
  assert.equal(note.status, 202);

  const listed = await fetch(`${base}/mcp`, { method: "POST", headers, body: JSON.stringify({ jsonrpc: "2.0", id: 3, method: "tools/list" }) });
  const payload = await listed.json();
  assert.equal(listed.status, 200);
  assert.ok(payload.result.tools.some(item => item.name === "bridge_status"));
  assert.ok(payload.result.tools.some(item => item.name === "pty_start"));

  const root = await fetch(`${base}/`).then(r => r.json());
  assert.equal(root.mcp, `${base}/mcp`);
});

test("tools/call streams SSE with keepalives and progress when the client accepts it", async t => {
  const { base, token } = await startHttp(t, { WDB_HTTP_KEEPALIVE_MS: "200" });
  const headers = { "content-type": "application/json", accept: "application/json, text/event-stream", authorization: `Bearer ${token}` };
  const call = process.platform === "win32"
    ? { name: "shell_exec", arguments: { command: "Start-Sleep -Milliseconds 1200; Write-Output sse-done" } }
    : { name: "bridge_status", arguments: {} };
  const response = await fetch(`${base}/mcp`, {
    method: "POST", headers,
    body: JSON.stringify({ jsonrpc: "2.0", id: 9, method: "tools/call", params: { ...call, _meta: { progressToken: "tok-1" } } }),
  });
  assert.equal(response.status, 200);
  assert.match(response.headers.get("content-type"), /text\/event-stream/);
  const messages = parseSse(await response.text());
  const final = messages.find(message => message.id === 9);
  assert.ok(final && final.result, "final JSON-RPC response must be sent as an SSE event");
  if (process.platform === "win32") {
    assert.match(final.result.structuredContent.stdout, /sse-done/);
    assert.ok(messages.some(message => message.method === "notifications/progress" && message.params.progressToken === "tok-1"), "progress notifications expected during a long call");
  }
  // JSON-only clients still get a plain JSON body.
  const plain = await fetch(`${base}/mcp`, {
    method: "POST", headers: { ...headers, accept: "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 10, method: "tools/call", params: { name: "bridge_status", arguments: {} } }),
  });
  assert.match(plain.headers.get("content-type"), /application\/json/);
  assert.equal((await plain.json()).id, 10);
});

test("OAuth metadata follows the tunnel hostname when no public URL is configured", async t => {
  const { base } = await startHttp(t);
  const viaTunnel = await fetch(`${base}/.well-known/oauth-authorization-server`, { headers: { "x-forwarded-host": "demo-words.trycloudflare.com", "x-forwarded-proto": "https" } }).then(r => r.json());
  assert.equal(viaTunnel.issuer, "https://demo-words.trycloudflare.com");
  assert.equal(viaTunnel.revocation_endpoint, "https://demo-words.trycloudflare.com/revoke");
  const local = await fetch(`${base}/.well-known/oauth-protected-resource`).then(r => r.json());
  assert.equal(local.resource, base);
  const unauth = await fetch(`${base}/mcp`, { method: "POST", headers: { "content-type": "application/json", "x-forwarded-host": "demo-words.trycloudflare.com", "x-forwarded-proto": "https" }, body: "{}" });
  assert.match(unauth.headers.get("www-authenticate"), /https:\/\/demo-words\.trycloudflare\.com\/\.well-known\/oauth-protected-resource/);
});
