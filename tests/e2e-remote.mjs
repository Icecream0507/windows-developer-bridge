// 端到端验证一个正在运行的 WDB（手动运行，不在 node --test 套件里）：
//   node tests/e2e-remote.mjs https://<host>.trycloudflare.com [--long]
// 走完整 OAuth 流程（动态注册 → PKCE → 本机 PIN 同意 → 换 token → 刷新），再通过 MCP 调用真实工具
// （JSON 与 SSE 两种响应），最后撤销本次签发的令牌。--long 额外跑一个 110 秒的命令，
// 验证 SSE 心跳能越过 Cloudflare 的 100 秒超时。
import crypto from "node:crypto";
import fsp from "node:fs/promises";
import path from "node:path";
import os from "node:os";

const BASE = (process.argv[2] || "http://127.0.0.1:8787").replace(/\/+$/, "");
const LONG = process.argv.includes("--long");
const REDIRECT = "http://127.0.0.1:9999/callback";
const dataDir = process.env.WDB_DATA_DIR || path.join(process.env.LOCALAPPDATA || path.join(os.homedir(), "AppData", "Local"), "WindowsDeveloperBridge");
const pin = process.env.WDB_OAUTH_CONSENT_PIN || (await fsp.readFile(path.join(dataDir, "oauth", "consent.pin"), "utf8")).trim();
let failures = 0;
const check = (cond, msg) => { console.log((cond ? "PASS: " : "FAIL: ") + msg); if (!cond) failures++; return cond; };
const form = body => ({ method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams(body) });

console.log("目标:", BASE);
const meta = await fetch(BASE + "/.well-known/oauth-authorization-server").then(r => r.json());
check(meta.issuer === BASE, `issuer 与访问地址一致 (${meta.issuer})`);
const reg = await fetch(meta.registration_endpoint, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ client_name: "wdb-e2e-check", redirect_uris: [REDIRECT] }) }).then(r => r.json());
check(Boolean(reg.client_id), "动态注册拿到 client_id");

const verifier = crypto.randomBytes(32).toString("base64url");
const challenge = crypto.createHash("sha256").update(verifier).digest("base64url");
const authUrl = new URL(meta.authorization_endpoint);
authUrl.search = new URLSearchParams({ client_id: reg.client_id, redirect_uri: REDIRECT, response_type: "code", state: "s1", code_challenge: challenge, code_challenge_method: "S256", scope: "mcp", resource: BASE + "/mcp" });
const consent = await fetch(authUrl, { redirect: "manual" }).then(r => r.text());
const requestId = consent.match(/name="auth_request_id"\s+value="([^"]+)"/)?.[1];
check(Boolean(requestId), "同意页正常渲染");
const approved = await fetch(BASE + "/authorize/approve", { ...form({ auth_request_id: requestId, pin, decision: "approve" }), redirect: "manual" });
const code = new URL(approved.headers.get("location") || "http://x/", BASE).searchParams.get("code");
check(Boolean(code), "PIN 批准后拿到授权码");
const tokens = await fetch(meta.token_endpoint, form({ grant_type: "authorization_code", code, redirect_uri: REDIRECT, client_id: reg.client_id, code_verifier: verifier })).then(r => r.json());
check(Boolean(tokens.access_token && tokens.refresh_token), "换到 access_token + refresh_token");

const auth = { "content-type": "application/json", authorization: "Bearer " + tokens.access_token };
let nextId = 1;
async function mcp(method, params, accept = "application/json") {
  const response = await fetch(BASE + "/mcp", { method: "POST", headers: { ...auth, accept }, body: JSON.stringify({ jsonrpc: "2.0", id: nextId++, method, params }) });
  const type = response.headers.get("content-type") || "";
  if (type.includes("text/event-stream")) {
    const events = (await response.text()).split(/\n\n/).map(b => b.split("\n").filter(l => l.startsWith("data: ")).map(l => l.slice(6)).join("")).filter(Boolean).map(d => JSON.parse(d));
    return { sse: true, events, message: events.find(e => e.id !== undefined) };
  }
  return { sse: false, message: await response.json(), status: response.status };
}
const init = await mcp("initialize", { protocolVersion: "2025-11-25", capabilities: {}, clientInfo: { name: "e2e", version: "1" } });
check(init.message?.result?.serverInfo?.name === "windows-developer-bridge", "MCP initialize");
const tools = await mcp("tools/list", {});
check(tools.message?.result?.tools?.length >= 23, `tools/list 返回 ${tools.message?.result?.tools?.length} 个工具`);
const status = await mcp("tools/call", { name: "bridge_status", arguments: {} });
const st = status.message?.result?.structuredContent;
check(st && st.platform === "win32", `bridge_status: ${st?.hostname} shell=${st?.shellKind} unlocked=${st?.fullAccessUnlocked} pty=${st?.pty?.available}`);
const shell = await mcp("tools/call", { name: "shell_exec", arguments: { command: "Start-Sleep -Seconds 2; Write-Output ('远程执行-' + $PSVersionTable.PSVersion.Major)" }, _meta: { progressToken: "e2e" } }, "application/json, text/event-stream");
check(shell.sse && /远程执行-\d/.test(shell.message?.result?.structuredContent?.stdout || ""), "shell_exec 经 SSE 返回 UTF-8 输出");
const fsRes = await mcp("tools/call", { name: "fs_list", arguments: { path: "~", max_entries: 5 } });
check(Array.isArray(fsRes.message?.result?.structuredContent?.entries), "fs_list 读取用户目录");
if (LONG) {
  const started = Date.now();
  const long = await mcp("tools/call", { name: "shell_exec", arguments: { command: "Start-Sleep -Seconds 110; Write-Output long-ok", timeout_ms: 200000 } }, "application/json, text/event-stream");
  check(/long-ok/.test(long.message?.result?.structuredContent?.stdout || ""), `110 秒长命令穿过 Cloudflare 完成 (${Math.round((Date.now() - started) / 1000)}s)`);
}
const refreshed = await fetch(meta.token_endpoint, form({ grant_type: "refresh_token", refresh_token: tokens.refresh_token, client_id: reg.client_id })).then(r => r.json());
check(Boolean(refreshed.access_token), "refresh_token 轮换");
for (const token of [refreshed.access_token, refreshed.refresh_token]) await fetch(meta.revocation_endpoint, form({ token }));
const afterRevoke = await fetch(BASE + "/mcp", { method: "POST", headers: { "content-type": "application/json", authorization: "Bearer " + refreshed.access_token }, body: JSON.stringify({ jsonrpc: "2.0", id: 99, method: "ping" }) });
check(afterRevoke.status === 401, "撤销后令牌失效（已清理本次测试令牌）");
console.log(failures ? `\n${failures} 项失败` : "\n全部通过 ✅");
process.exitCode = failures ? 1 : 0;
