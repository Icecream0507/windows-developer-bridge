// 端到端 OAuth 流程验证（手动运行，不进 node --test 套件）：
// node tests/oauth-e2e-check.mjs https://<host>.trycloudflare.com
import crypto from "node:crypto";
import fsp from "node:fs/promises";
import path from "node:path";
import os from "node:os";

const BASE = process.argv[2].replace(/\/+$/, "");
const REDIRECT = "http://127.0.0.1:9999/callback";
const pinFile = path.join(process.env.LOCALAPPDATA || path.join(os.homedir(), "AppData", "Local"),
  "WindowsDeveloperBridge", "oauth", "consent.pin");
const assert = (cond, msg) => { if (!cond) { console.error("FAIL:", msg); process.exit(1); } console.log("PASS:", msg); };

console.log("目标:", BASE, "\n");

// 1. 资源元数据
let r = await fetch(BASE + "/.well-known/oauth-protected-resource");
assert(r.status === 200, `资源元数据 200 (实际 ${r.status})`);
const protectedMeta = await r.json();
assert(protectedMeta.resource === BASE, "resource 与公网地址一致");
assert(protectedMeta.authorization_servers?.[0] === BASE, "authorization_servers 指向自身");

// 2. AS 元数据
r = await fetch(BASE + "/.well-known/oauth-authorization-server");
assert(r.status === 200, `AS 元数据 200 (实际 ${r.status})`);
const asMeta = await r.json();
assert(asMeta.code_challenge_methods_supported?.includes("S256"), "声明支持 PKCE S256");
assert(asMeta.token_endpoint_auth_methods_supported?.includes("none"), "公开客户端 token_endpoint_auth_method=none");
console.log("  issuer:", asMeta.issuer);

// 3. 动态客户端注册
r = await fetch(BASE + "/register", {
  method: "POST", headers: { "content-type": "application/json" },
  body: JSON.stringify({ client_name: "e2e-test-client", redirect_uris: [REDIRECT], grant_types: ["authorization_code", "refresh_token"] }),
});
assert(r.status === 201, `动态注册 201 (实际 ${r.status})`);
const reg = await r.json();
assert(reg.client_id && reg.token_endpoint_auth_method === "none", "拿到 client_id 且为公开客户端");
console.log("  client_id:", reg.client_id);

// 拒绝非法回调
r = await fetch(BASE + "/register", {
  method: "POST", headers: { "content-type": "application/json" },
  body: JSON.stringify({ redirect_uris: ["http://evil.example.com/cb"] }),
});
assert(r.status === 400, `非 https/非环回回调被拒 (实际 ${r.status})`);

// 4. PKCE 授权请求
const verifier = crypto.randomBytes(32).toString("base64url");
const challenge = crypto.createHash("sha256").update(verifier, "ascii").digest("base64url");
const authUrl = new URL(asMeta.authorization_endpoint);
authUrl.search = new URLSearchParams({
  client_id: reg.client_id, redirect_uri: REDIRECT, response_type: "code",
  state: "state-xyz", code_challenge: challenge, code_challenge_method: "S256",
  scope: "mcp", resource: BASE,
});
r = await fetch(authUrl, { redirect: "manual" });
assert(r.status === 200, `授权页 200 (实际 ${r.status})`);
const consentHtml = await r.text();
const reqId = consentHtml.match(/name="auth_request_id"\s+value="([^"]+)"/)?.[1];
assert(reqId, "同意页包含 auth_request_id");

// 错误 PIN 应被拒
r = await fetch(BASE + "/authorize/approve", {
  method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" },
  body: new URLSearchParams({ auth_request_id: reqId, pin: "000000000", decision: "approve" }),
});
assert(r.status === 200 && (await r.text()).includes("PIN 错误"), "错误 PIN 被拒绝并留在同意页");

// 5. 操作员用正确 PIN 批准
const pin = (await fsp.readFile(pinFile, "utf8")).trim();
r = await fetch(BASE + "/authorize/approve", {
  method: "POST", redirect: "manual",
  headers: { "content-type": "application/x-www-form-urlencoded" },
  body: new URLSearchParams({ auth_request_id: reqId, pin, decision: "approve" }),
});
assert(r.status === 302, `批准后 302 (实际 ${r.status})`);
const location = r.headers.get("location");
const code = new URL(location, BASE).searchParams.get("code");
assert(code, "回调 Location 携带授权码");
assert(new URL(location, BASE).searchParams.get("state") === "state-xyz", "state 原样回传");

// 6. 换 token
r = await fetch(BASE + "/token", {
  method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" },
  body: new URLSearchParams({
    grant_type: "authorization_code", code, redirect_uri: REDIRECT,
    client_id: reg.client_id, code_verifier: verifier,
  }),
});
assert(r.status === 200, `换 token 200 (实际 ${r.status})`);
const tokens = await r.json();
assert(tokens.access_token && tokens.refresh_token && tokens.token_type === "Bearer", "拿到 access_token + refresh_token");
assert(tokens.expires_in > 0, "声明 expires_in");
console.log("  access_token:", tokens.access_token.slice(0, 12) + "...");

// 授权码一次性
r = await fetch(BASE + "/token", {
  method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" },
  body: new URLSearchParams({ grant_type: "authorization_code", code, redirect_uri: REDIRECT, code_verifier: verifier }),
});
assert(r.status === 400, `授权码重放被拒 (实际 ${r.status})`);

// PKCE 错误 verifier
const badVerifier = crypto.randomBytes(32).toString("base64url");
const authUrl2 = new URL(asMeta.authorization_endpoint);
authUrl2.search = new URLSearchParams({ client_id: reg.client_id, redirect_uri: REDIRECT, response_type: "code", state: "s", code_challenge: challenge, code_challenge_method: "S256" });
let rr = await fetch(authUrl2, { redirect: "manual" });
const id2 = (await rr.text()).match(/name="auth_request_id"\s+value="([^"]+)"/)?.[1];
rr = await fetch(BASE + "/authorize/approve", { method: "POST", redirect: "manual", headers: { "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ auth_request_id: id2, pin, decision: "approve" }) });
const code2 = new URL(rr.headers.get("location"), BASE).searchParams.get("code");
rr = await fetch(BASE + "/token", { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ grant_type: "authorization_code", code: code2, redirect_uri: REDIRECT, code_verifier: badVerifier }) });
assert(rr.status === 400, `PKCE verifier 不匹配被拒 (实际 ${rr.status})`);

// 7. access_token 调 MCP
r = await fetch(BASE + "/mcp", {
  method: "POST", headers: { "content-type": "application/json", authorization: "Bearer " + tokens.access_token },
  body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-11-25" } }),
});
assert(r.status === 200, `OAuth 令牌调 MCP initialize 200 (实际 ${r.status})`);
const initResult = await r.json();
assert(initResult.result?.serverInfo?.name === "windows-developer-bridge", "MCP 握手成功");

r = await fetch(BASE + "/mcp", {
  method: "POST", headers: { "content-type": "application/json", authorization: "Bearer " + tokens.access_token },
  body: JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list" }),
});
assert((await r.json()).result?.tools?.length > 0, "tools/list 成功");

// 8. 无凭证仍然 401 且带 resource_metadata
r = await fetch(BASE + "/mcp", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 3, method: "ping" }) });
assert(r.status === 401, `无凭证 401 (实际 ${r.status})`);
assert((r.headers.get("www-authenticate") || "").includes("resource_metadata="), "WWW-Authenticate 指向资源元数据");

// 9. 刷新令牌轮换
r = await fetch(BASE + "/token", {
  method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" },
  body: new URLSearchParams({ grant_type: "refresh_token", refresh_token: tokens.refresh_token, client_id: reg.client_id }),
});
assert(r.status === 200, `刷新 200 (实际 ${r.status})`);
const refreshed = await r.json();
assert(refreshed.access_token !== tokens.access_token, "颁发了新 access_token");

// 旧 refresh_token 立即失效
r = await fetch(BASE + "/token", {
  method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" },
  body: new URLSearchParams({ grant_type: "refresh_token", refresh_token: tokens.refresh_token }),
});
assert(r.status === 400, `旧 refresh_token 重放被拒 (实际 ${r.status})`);

// 新 access_token 可用
r = await fetch(BASE + "/mcp", {
  method: "POST", headers: { "content-type": "application/json", authorization: "Bearer " + refreshed.access_token },
  body: JSON.stringify({ jsonrpc: "2.0", id: 4, method: "ping" }),
});
assert(r.status === 200, `新 access_token 可调 MCP (实际 ${r.status})`);

console.log("\n全部 OAuth 端到端检查通过 ✅");
console.log("client_id（注册一次即可复用，持久化在服务端）:", reg.client_id);
