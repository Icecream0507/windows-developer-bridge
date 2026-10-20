#!/usr/bin/env node
import http from "node:http";
import crypto from "node:crypto";
import readline from "node:readline";
import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createOAuthStore } from "./mcp-oauth.mjs";
import { loadConfigEnv } from "./lib/config.mjs";

const ROOT = path.dirname(fileURLToPath(import.meta.url));
loadConfigEnv();
const BRIDGE = process.env.WDB_BRIDGE_ENTRY || path.join(ROOT, "bridge.mjs");
const HOST = process.env.WDB_HTTP_HOST || "127.0.0.1";
const PORT = Number(process.env.WDB_HTTP_PORT || 8787);
// 对外可达地址（OAuth issuer）。未设置时按请求的 Host / X-Forwarded-Proto 自动推导，
// 这样 Cloudflare Quick Tunnel 换了随机域名也无需重启服务。
const PUBLIC_URL = (process.env.WDB_HTTP_PUBLIC_URL || "").trim().replace(/\/+$/, "");
const LOCAL_URL = `http://${HOST.includes(":") ? `[${HOST}]` : HOST}:${PORT}`;
const TOKEN = process.env.WDB_HTTP_TOKEN || "";
const MAX_BODY = 8 * 1024 * 1024;
// 工具调用最长 30 分钟（shell_exec 上限），留出余量
const RPC_TIMEOUT_MS = 31 * 60 * 1000;
// SSE 心跳：Cloudflare 在 100 秒无响应字节时返回 524，长任务必须持续写字节
const KEEPALIVE_MS = Number(process.env.WDB_HTTP_KEEPALIVE_MS || 15000);
const SSE_ENABLED = process.env.WDB_HTTP_SSE !== "0";
if (!Number.isInteger(PORT) || PORT < 1 || PORT > 65535) throw new Error("WDB_HTTP_PORT must be 1..65535");
// 静态 Bearer Token 为可选的管理通道；不设置时仅使用 OAuth 动态颁发的令牌
let tokenDigest = null;
if (TOKEN) {
  if (Buffer.byteLength(TOKEN, "utf8") < 32 || !/^[\x21-\x7e]+$/.test(TOKEN)) {
    process.stderr.write("WDB_HTTP_TOKEN must be at least 32 printable ASCII characters. Generate one with: node -e \"console.log(require('crypto').randomBytes(32).toString('hex'))\"\n");
    process.exit(78);
  }
  tokenDigest = crypto.createHash("sha256").update(TOKEN, "ascii").digest();
}
delete process.env.WDB_HTTP_TOKEN;

const oauth = createOAuthStore();

let child = null, nextId = 1;
const pending = new Map();
function startBridge() {
  if (child && child.exitCode === null && !child.stdin.destroyed) return child;
  const proc = spawn(process.execPath, [BRIDGE], { cwd: ROOT, env: process.env, stdio: ["pipe", "pipe", "pipe"], windowsHide: true });
  child = proc;
  readline.createInterface({ input: proc.stdout, crlfDelay: Infinity }).on("line", line => {
    let msg;
    try { msg = JSON.parse(line); } catch { process.stderr.write("Ignoring invalid JSON from bridge stdout\n"); return; }
    if (msg.id === undefined) return;
    const waiter = pending.get(String(msg.id));
    if (!waiter) return;
    pending.delete(String(msg.id)); clearTimeout(waiter.timer); waiter.resolve(msg);
  });
  proc.stderr.on("data", chunk => process.stderr.write("[bridge] " + chunk.toString()));
  const fail = error => {
    for (const [id, waiter] of pending) { clearTimeout(waiter.timer); waiter.reject(error); pending.delete(id); }
    if (child === proc) child = null;
  };
  proc.on("error", error => fail(new Error("Could not start bridge: " + error.message)));
  proc.on("exit", (code, signal) => fail(new Error("Bridge process exited (code=" + code + ", signal=" + signal + ")")));
  return proc;
}
function rpc(message) {
  if (!message || typeof message !== "object" || Array.isArray(message) || typeof message.method !== "string") {
    return Promise.resolve({ jsonrpc: "2.0", id: message?.id ?? null, error: { code: -32600, message: "Invalid Request" } });
  }
  if (message.method.startsWith("notifications/")) return Promise.resolve(null);
  const proc = startBridge();
  if (message.id === undefined) {
    proc.stdin.write(JSON.stringify(message) + "\n");
    return Promise.resolve(null);
  }
  const id = String(nextId++);
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { pending.delete(id); reject(new Error("MCP request timed out")); }, RPC_TIMEOUT_MS);
    pending.set(id, { resolve: result => resolve({ ...result, id: message.id }), reject, timer });
    try { proc.stdin.write(JSON.stringify({ ...message, id }) + "\n"); }
    catch (error) { clearTimeout(timer); pending.delete(id); reject(error); }
  });
}
function authorized(req) {
  const header = req.headers.authorization || "";
  if (!header.startsWith("Bearer ")) return false;
  const supplied = header.slice(7);
  if (!/^[\x21-\x7e]+$/.test(supplied)) return false;
  if (tokenDigest) {
    const digest = crypto.createHash("sha256").update(supplied, "ascii").digest();
    if (digest.length === tokenDigest.length && crypto.timingSafeEqual(digest, tokenDigest)) return true;
  }
  return Boolean(oauth.verifyAccess(supplied));
}
async function readBody(req) {
  const chunks = []; let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > MAX_BODY) throw Object.assign(new Error("Request body too large"), { status: 413 });
    chunks.push(chunk);
  }
  try { return JSON.parse(Buffer.concat(chunks).toString("utf8")); }
  catch { throw Object.assign(new Error("Invalid JSON body"), { status: 400 }); }
}
function sendJson(res, status, value, extra = {}) {
  const body = JSON.stringify(value);
  res.writeHead(status, { "content-type": "application/json; charset=utf-8", "content-length": Buffer.byteLength(body), "cache-control": "no-store", "x-content-type-options": "nosniff", ...extra });
  res.end(body);
}
function publicBase(req) {
  if (PUBLIC_URL) return PUBLIC_URL;
  const host = String(req.headers["x-forwarded-host"] || req.headers.host || "").split(",")[0].trim();
  if (!/^([A-Za-z0-9.-]+|\[[0-9A-Fa-f:.]+\])(:\d{1,5})?$/.test(host)) return LOCAL_URL;
  const forwarded = String(req.headers["x-forwarded-proto"] || "").split(",")[0].trim().toLowerCase();
  const proto = forwarded === "https" || forwarded === "http" ? forwarded : String(req.headers["cf-visitor"] || "").includes("https") ? "https" : "http";
  return `${proto}://${host}`;
}
function toolName(message) {
  return message && message.method === "tools/call" && message.params && typeof message.params.name === "string" ? message.params.name : null;
}
function log(line) { process.stderr.write(`[http] ${new Date().toISOString()} ${line}\n`); }
// MCP Streamable HTTP 允许以 text/event-stream 回应 POST。工具调用走 SSE，先立即写出响应头，
// 之后每 KEEPALIVE_MS 写一次注释心跳（或客户端请求了 progressToken 时写 progress 通知），
// 避免 Cloudflare 100 秒超时，也让客户端知道任务仍在运行。
async function streamResponses(req, res, batch) {
  res.writeHead(200, { "content-type": "text/event-stream; charset=utf-8", "cache-control": "no-cache, no-store, no-transform", "x-accel-buffering": "no", "x-content-type-options": "nosniff" });
  res.write(": stream open\n\n");
  const writeEvent = message => { if (!res.writableEnded) res.write(`event: message\ndata: ${JSON.stringify(message)}\n\n`); };
  const tokens = batch.map(m => m && m.params && m.params._meta ? m.params._meta.progressToken : undefined).filter(t => typeof t === "string" || typeof t === "number");
  let ticks = 0;
  const heartbeat = setInterval(() => {
    ticks += 1;
    if (tokens.length) for (const token of tokens) writeEvent({ jsonrpc: "2.0", method: "notifications/progress", params: { progressToken: token, progress: ticks, message: `still running (${Math.round(ticks * KEEPALIVE_MS / 1000)}s)` } });
    else if (!res.writableEnded) res.write(": keepalive\n\n");
  }, KEEPALIVE_MS);
  try {
    const results = await Promise.all(batch.map(message => rpc(message).catch(error => ({ jsonrpc: "2.0", id: message?.id ?? null, error: { code: -32603, message: error.message || "Bridge request failed" } }))));
    for (const result of results) if (result !== null) writeEvent(result);
  } finally {
    clearInterval(heartbeat);
    res.end();
  }
}
const server = http.createServer(async (req, res) => {
  const url = new URL(req.url || "/", "http://localhost");
  if (req.method === "GET" && url.pathname === "/healthz") {
    return sendJson(res, 200, { ok: true, service: "windows-developer-bridge-http", bridgeRunning: Boolean(child && child.exitCode === null) });
  }
  const base = publicBase(req);
  if (req.method === "GET" && url.pathname === "/") {
    return sendJson(res, 200, { service: "windows-developer-bridge", mcp: base + "/mcp", health: base + "/healthz", auth: "OAuth 2.1 (PIN consent) or static bearer token" });
  }
  if (await oauth.handle(req, res, base)) return;
  if (url.pathname !== "/mcp") return sendJson(res, 404, { error: "Not found" });
  if (!authorized(req)) {
    const meta = base + "/.well-known/oauth-protected-resource";
    return sendJson(res, 401, { error: "Unauthorized" }, { "www-authenticate": `Bearer resource_metadata="${meta}"` });
  }
  if (req.method === "GET") return sendJson(res, 405, { error: "MCP GET/SSE is not implemented; send JSON-RPC POST requests." }, { allow: "POST, OPTIONS" });
  if (req.method === "DELETE") { res.writeHead(204); return res.end(); }
  if (req.method === "OPTIONS") { res.writeHead(204, { allow: "POST, OPTIONS" }); return res.end(); }
  if (req.method !== "POST") return sendJson(res, 405, { error: "Method not allowed" }, { allow: "POST, OPTIONS" });
  if (!(req.headers["content-type"] || "").toLowerCase().includes("application/json")) return sendJson(res, 415, { error: "Content-Type must be application/json" });
  const started = Date.now();
  let label = "POST /mcp";
  try {
    const body = await readBody(req);
    const batch = Array.isArray(body) ? body : [body];
    if (!batch.length) return sendJson(res, 400, { error: "Empty JSON-RPC batch" });
    const tools = batch.map(toolName).filter(Boolean);
    label = batch.map(m => (m && m.method) || "?").join(",") + (tools.length ? ` ${tools.join(",")}` : "");
    const accept = String(req.headers.accept || "");
    if (SSE_ENABLED && tools.length && accept.includes("text/event-stream")) {
      await streamResponses(req, res, batch);
      if (tools.length) log(`${label} sse ${Date.now() - started}ms`);
      return;
    }
    const results = (await Promise.all(batch.map(rpc))).filter(x => x !== null);
    if (tools.length) log(`${label} ${Date.now() - started}ms`);
    if (!results.length) { res.writeHead(202); return res.end(); }
    return sendJson(res, 200, Array.isArray(body) ? results : results[0]);
  } catch (error) {
    log(`${label} failed: ${error.message}`);
    if (res.headersSent) { res.end(); return; }
    return sendJson(res, error.status || 502, { error: error.message || "Bridge request failed" });
  }
});
server.on("error", error => { process.stderr.write("HTTP server error: " + error.message + "\n"); process.exitCode = 1; });
await oauth.init();
delete process.env.WDB_OAUTH_CONSENT_PIN; // 仅供 oauth.init 读取生成/接受的操作员 PIN
server.listen(PORT, HOST, () => {
  process.stderr.write("Windows Developer Bridge HTTP listening at http://" + HOST + ":" + PORT + "/mcp\n");
  process.stderr.write("Public base URL: " + (PUBLIC_URL || "auto (derived from each request's Host / X-Forwarded-Proto)") + "\n");
  process.stderr.write("Static bearer token: " + (tokenDigest ? "enabled" : "disabled (OAuth only)") + "\n");
  process.stderr.write("OAuth consent PIN (local operator only): " + oauth.getPin() + "\n");
});
function shutdown() {
  server.close();
  if (child && child.exitCode === null) child.kill();
  for (const waiter of pending.values()) { clearTimeout(waiter.timer); waiter.reject(new Error("HTTP server shutting down")); }
  pending.clear();
}
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
