import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { randomBytes, createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const PIN = "246813579";

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

async function startServer() {
  const port = await freePort();
  const dataDir = await mkdtemp(path.join(os.tmpdir(), "wdb-oauth-test-"));
  const child = spawn(process.execPath, [path.join(ROOT, "mcp-http.mjs")], {
    cwd: ROOT,
    env: {
      ...process.env,
      WDB_HTTP_PORT: String(port),
      WDB_DATA_DIR: dataDir,
      WDB_HTTP_PUBLIC_URL: `http://127.0.0.1:${port}`,
      WDB_OAUTH_CONSENT_PIN: PIN,
      // 故意不设 WDB_HTTP_TOKEN，验证纯 OAuth 模式
    },
    stdio: ["ignore", "ignore", "pipe"],
  });
  let stderr = "";
  child.stderr.on("data", chunk => { stderr += chunk.toString(); });
  const base = `http://127.0.0.1:${port}`;
  for (let i = 0; i < 100; i++) {
    if (child.exitCode !== null) assert.fail(`OAuth server exited early: ${stderr}`);
    try {
      const response = await fetch(`${base}/healthz`);
      if (response.ok) break;
    } catch {}
    await new Promise(resolve => setTimeout(resolve, 30));
  }
  return {
    base, child,
    async stop() {
      if (child.exitCode === null) {
        child.kill("SIGTERM");
        await Promise.race([
          new Promise(resolve => child.once("exit", resolve)),
          new Promise(resolve => setTimeout(resolve, 1500)),
        ]);
      }
      await rm(dataDir, { recursive: true, force: true });
    },
  };
}

async function register(base, redirectUris) {
  const response = await fetch(`${base}/register`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ client_name: "test-client", redirect_uris: redirectUris }),
  });
  assert.equal(response.status, 201);
  return response.json();
}

test("OAuth 2.1 dynamic registration, PKCE code flow, consent PIN, refresh rotation, and MCP access", async t => {
  const { base, stop } = await startServer();
  t.after(stop);
  const redirectUri = "http://127.0.0.1:9999/callback";

  // 元数据
  const protectedMeta = await fetch(`${base}/.well-known/oauth-protected-resource`).then(r => r.json());
  assert.equal(protectedMeta.resource, base);
  assert.deepEqual(protectedMeta.authorization_servers, [base]);
  const asMeta = await fetch(`${base}/.well-known/oauth-authorization-server`).then(r => r.json());
  assert.ok(asMeta.code_challenge_methods_supported.includes("S256"));
  assert.ok(asMeta.grant_types_supported.includes("refresh_token"));

  // 非环回/非 https 回调拒绝
  const bad = await fetch(`${base}/register`, {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ redirect_uris: ["http://evil.example.com/cb"] }),
  });
  assert.equal(bad.status, 400);

  const client = await register(base, [redirectUri]);
  assert.ok(client.client_id);
  assert.equal(client.token_endpoint_auth_method, "none");

  // PKCE 授权请求 → 同意页
  const verifier = randomBytes(32).toString("base64url");
  const challenge = createHash("sha256").update(verifier, "ascii").digest("base64url");
  const authUrl = new URL(`${base}/authorize`);
  authUrl.search = new URLSearchParams({
    client_id: client.client_id, redirect_uri: redirectUri, response_type: "code",
    state: "abc", code_challenge: challenge, code_challenge_method: "S256", scope: "mcp",
  });
  let response = await fetch(authUrl, { redirect: "manual" });
  assert.equal(response.status, 200);
  const html = await response.text();
  const requestId = html.match(/name="auth_request_id"\s+value="([^"]+)"/)[1];

  // 缺少 code_challenge 被拒（回调带 error）
  const noPkce = await fetch(`${base}/authorize?client_id=${client.client_id}&redirect_uri=${encodeURIComponent(redirectUri)}&response_type=code&state=x`, { redirect: "manual" });
  assert.equal(noPkce.status, 302);
  assert.ok(noPkce.headers.get("location").includes("error=invalid_request"));

  // 错误 PIN
  response = await fetch(`${base}/authorize/approve`, {
    method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ auth_request_id: requestId, pin: "000000000", decision: "approve" }),
  });
  assert.equal(response.status, 200);
  assert.ok((await response.text()).includes("PIN 错误"));

  // 拒绝授权
  const denyId = (await (await fetch(authUrl, { redirect: "manual" })).text()).match(/name="auth_request_id"\s+value="([^"]+)"/)[1];
  const denied = await fetch(`${base}/authorize/approve`, {
    method: "POST", redirect: "manual", headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ auth_request_id: denyId, pin: PIN, decision: "deny" }),
  });
  assert.equal(denied.status, 302);
  assert.ok(denied.headers.get("location").includes("error=access_denied"));

  // 正确 PIN 批准 → 授权码
  response = await fetch(`${base}/authorize/approve`, {
    method: "POST", redirect: "manual", headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ auth_request_id: requestId, pin: PIN, decision: "approve" }),
  });
  assert.equal(response.status, 302);
  const callback = new URL(response.headers.get("location"), base);
  const code = callback.searchParams.get("code");
  assert.ok(code);
  assert.equal(callback.searchParams.get("state"), "abc");

  // 换 token
  response = await fetch(`${base}/token`, {
    method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ grant_type: "authorization_code", code, redirect_uri: redirectUri, code_verifier: verifier }),
  });
  assert.equal(response.status, 200);
  const tokens = await response.json();
  assert.equal(tokens.token_type, "Bearer");
  assert.ok(tokens.access_token && tokens.refresh_token);

  // 授权码一次性
  const replay = await fetch(`${base}/token`, {
    method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ grant_type: "authorization_code", code, redirect_uri: redirectUri, code_verifier: verifier }),
  });
  assert.equal(replay.status, 400);

  // access_token 可访问 MCP
  const mcp = await fetch(`${base}/mcp`, {
    method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${tokens.access_token}` },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
  });
  assert.equal(mcp.status, 200);
  const listed = await mcp.json();
  assert.ok(listed.result.tools.some(tool => tool.name === "bridge_status"));

  // 无凭证 401 且 WWW-Authenticate 指向资源元数据
  const unauth = await fetch(`${base}/mcp`, {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 2, method: "ping" }),
  });
  assert.equal(unauth.status, 401);
  assert.match(unauth.headers.get("www-authenticate"), /resource_metadata=/);

  // 刷新令牌轮换
  response = await fetch(`${base}/token`, {
    method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ grant_type: "refresh_token", refresh_token: tokens.refresh_token }),
  });
  assert.equal(response.status, 200);
  const refreshed = await response.json();
  assert.notEqual(refreshed.access_token, tokens.access_token);

  const oldRefresh = await fetch(`${base}/token`, {
    method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ grant_type: "refresh_token", refresh_token: tokens.refresh_token }),
  });
  assert.equal(oldRefresh.status, 400);
});
