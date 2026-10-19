#!/usr/bin/env node
import http from "node:http";
import crypto from "node:crypto";
import readline from "node:readline";
import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const BRIDGE = process.env.WDB_BRIDGE_ENTRY || path.join(ROOT, "bridge.mjs");
const HOST = process.env.WDB_HTTP_HOST || "127.0.0.1";
const PORT = Number(process.env.WDB_HTTP_PORT || 8787);
const TOKEN = process.env.WDB_HTTP_TOKEN || "";
const MAX_BODY = 8 * 1024 * 1024;
if (!Number.isInteger(PORT) || PORT < 1 || PORT > 65535) throw new Error("WDB_HTTP_PORT must be 1..65535");
if (Buffer.byteLength(TOKEN, "utf8") < 32 || !/^[\x21-\x7e]+$/.test(TOKEN)) {
  process.stderr.write("WDB_HTTP_TOKEN must be at least 32 printable ASCII characters. Generate one with: node -e \"console.log(require('crypto').randomBytes(32).toString('hex'))\"\n");
  process.exit(78);
}
const tokenDigest = crypto.createHash("sha256").update(TOKEN, "ascii").digest();
delete process.env.WDB_HTTP_TOKEN;

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
    const timer = setTimeout(() => { pending.delete(id); reject(new Error("MCP request timed out")); }, 600000);
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
  const digest = crypto.createHash("sha256").update(supplied, "ascii").digest();
  return crypto.timingSafeEqual(tokenDigest, digest);
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
const server = http.createServer(async (req, res) => {
  const url = new URL(req.url || "/", "http://localhost");
  if (req.method === "GET" && url.pathname === "/healthz") {
    return sendJson(res, 200, { ok: true, service: "windows-developer-bridge-http", bridgeRunning: Boolean(child && child.exitCode === null) });
  }
  if (url.pathname !== "/mcp") return sendJson(res, 404, { error: "Not found" });
  if (!authorized(req)) return sendJson(res, 401, { error: "Unauthorized" }, { "www-authenticate": "Bearer" });
  if (req.method === "GET") return sendJson(res, 405, { error: "MCP GET/SSE is not implemented; send JSON-RPC POST requests." }, { allow: "POST, OPTIONS" });
  if (req.method === "DELETE") { res.writeHead(204); return res.end(); }
  if (req.method === "OPTIONS") { res.writeHead(204, { allow: "POST, OPTIONS" }); return res.end(); }
  if (req.method !== "POST") return sendJson(res, 405, { error: "Method not allowed" }, { allow: "POST, OPTIONS" });
  if (!(req.headers["content-type"] || "").toLowerCase().includes("application/json")) return sendJson(res, 415, { error: "Content-Type must be application/json" });
  try {
    const body = await readBody(req);
    const batch = Array.isArray(body) ? body : [body];
    if (!batch.length) return sendJson(res, 400, { error: "Empty JSON-RPC batch" });
    const results = (await Promise.all(batch.map(rpc))).filter(x => x !== null);
    if (!results.length) { res.writeHead(202); return res.end(); }
    return sendJson(res, 200, Array.isArray(body) ? results : results[0]);
  } catch (error) {
    return sendJson(res, error.status || 502, { error: error.message || "Bridge request failed" });
  }
});
server.on("error", error => { process.stderr.write("HTTP server error: " + error.message + "\n"); process.exitCode = 1; });
server.listen(PORT, HOST, () => process.stderr.write("Windows Developer Bridge HTTP listening at http://" + HOST + ":" + PORT + "/mcp\n"));
function shutdown() {
  server.close();
  if (child && child.exitCode === null) child.kill();
  for (const waiter of pending.values()) { clearTimeout(waiter.timer); waiter.reject(new Error("HTTP server shutting down")); }
  pending.clear();
}
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
