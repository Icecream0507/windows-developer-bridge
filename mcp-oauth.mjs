// OAuth 2.1 authorization server for the WDB HTTP adapter.
// Implements the MCP authorization requirements: RFC 9728 protected-resource metadata,
// RFC 8414 authorization-server metadata, RFC 7591 dynamic client registration,
// authorization-code grant with mandatory PKCE (S256), refresh-token rotation, and a
// PIN-gated local-operator consent page (an open tunnel must not let remote callers
// self-authorize).
import crypto from "node:crypto";
import path from "node:path";
import os from "node:os";
import fsp from "node:fs/promises";

const DATA_DIR = process.env.WDB_DATA_DIR || (process.env.LOCALAPPDATA
  ? path.join(process.env.LOCALAPPDATA, "WindowsDeveloperBridge")
  : path.join(os.homedir(), ".windows-developer-bridge"));
const OAUTH_DIR = path.join(DATA_DIR, "oauth");
const CLIENTS_FILE = path.join(OAUTH_DIR, "clients.json");
const TOKENS_FILE = path.join(OAUTH_DIR, "tokens.json");
const PIN_FILE = path.join(OAUTH_DIR, "consent.pin");
const PIN_LOCKOUT_FILE = path.join(OAUTH_DIR, "pin-lockout.json");

const ACCESS_TTL_MS = 12 * 60 * 60 * 1000;      // 12 hours
const REFRESH_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30 days
const CODE_TTL_MS = 5 * 60 * 1000;
const AUTHREQ_TTL_MS = 10 * 60 * 1000;
const SCOPE = "mcp";
const MAX_PIN_ATTEMPTS = 10;
const MAX_GLOBAL_PIN_FAILURES = 10; // lock after 10 failures in the rolling window
const PIN_FAILURE_WINDOW = 10 * 60 * 1000;
const PIN_LOCKOUT_MS = 15 * 60 * 1000;
const MAX_BODY = 65536;

const randomToken = bytes => crypto.randomBytes(bytes).toString("hex");
const sha256 = value => crypto.createHash("sha256").update(String(value), "utf8").digest("hex");
function timingSafeEqual(a, b) {
  const ba = Buffer.from(String(a)), bb = Buffer.from(String(b));
  if (ba.length !== bb.length) return false;
  return crypto.timingSafeEqual(ba, bb);
}
function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, ch => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[ch]));
}
async function readSmallBody(req) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > MAX_BODY) throw Object.assign(new Error("Payload too large"), { status: 413 });
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString("utf8");
}
function isLoopback(uri) {
  try {
    const u = new URL(uri);
    if (u.protocol !== "http:") return false;
    return ["127.0.0.1", "localhost", "[::1]", "::1"].includes(u.hostname);
  } catch { return false; }
}
function acceptableRedirect(uri) {
  if (typeof uri !== "string" || uri.length > 2048) return false;
  if (isLoopback(uri)) return true; // RFC 8252 native-app loopback redirect
  // RFC 7591 wildcard: https URI whose last path segment is "*" (prefix match).
  if (uri.endsWith("*")) {
    try {
      const u = new URL(uri);
      return u.protocol === "https:" && u.pathname.endsWith("*") && !u.username && !u.password;
    } catch { return false; }
  }
  try { return new URL(uri).protocol === "https:"; } catch { return false; }
}
function redirectMatches(registered, actual) {
  if (registered === actual) return true;
  // RFC 7591 wildcard prefix match (e.g. https://chatgpt.com/connector/oauth/*).
  if (registered.endsWith("*")) {
    const prefix = registered.slice(0, -1);
    if (actual.startsWith(prefix)) {
      // Wildcard must not swallow a different host scheme or jump above its directory.
      try {
        const u = new URL(actual), w = new URL(prefix + "x");
        return u.protocol === w.protocol && u.host === w.host;
      } catch { return false; }
    }
  }
  // RFC 8252 7.3: loopback redirect ports are not fixed; ignore port differences.
  try {
    const a = new URL(registered), b = new URL(actual);
    const loop = u => ["127.0.0.1", "localhost", "[::1]", "::1"].includes(u.hostname);
    return a.protocol === "http:" && b.protocol === "http:" && loop(a) && loop(b)
      && a.pathname === b.pathname && a.search === b.search;
  } catch { return false; }
}

const page = (title, body, status = 200) => `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${escapeHtml(title)}</title>
<style>body{font-family:Segoe UI,Microsoft YaHei,sans-serif;max-width:560px;margin:64px auto;padding:0 20px;color:#1f2937}
.card{border:1px solid #e5e7eb;border-radius:10px;padding:24px}
h1{font-size:20px}input,button{font-size:15px;padding:8px 12px;border-radius:6px;border:1px solid #d1d5db}
button{cursor:pointer;border:none;padding:10px 18px;margin-right:10px}
.ok{background:#2563eb;color:#fff}.deny{background:#e5e7eb;color:#1f2937}
.err{background:#fef2f2;border:1px solid #fecaca;color:#991b1b;padding:10px;border-radius:6px;margin:12px 0}
.muted{color:#6b7280;font-size:13px}code{background:#f3f4f6;padding:2px 5px;border-radius:4px}</style></head>
<body><div class="card"><h1>${escapeHtml(title)}</h1>${body}</div></body></html>`;

const errorPage = message => page("WDB 授权错误", `<p class="err">${escapeHtml(message)}</p>
<p class="muted">Windows Developer Bridge OAuth 授权服务器。请回到发起授权的应用重试。</p>`, 400);

export function createOAuthStore() {
  const clients = new Map(); // clientId -> {clientId, clientName, redirectUris, createdAt}
  const accessTokens = new Map(); // sha256(token) -> {clientId, scope, exp, refreshHash}
  const refreshTokens = new Map(); // sha256(token) -> {clientId, scope, exp}
  const pending = new Map(); // authRequestId -> {clientId, redirectUri, state, scope, challenge, exp, attempts}
  const authCodes = new Map(); // sha256(code) -> {clientId, redirectUri, challenge, scope, exp}
  const pinFailures = []; // timestamps of global PIN failures
  let pinLockedUntil = 0;
  let pin = null;
  let clientsLoaded = false;

  async function atomicWrite(file, value) {
    await fsp.mkdir(path.dirname(file), { recursive: true });
    const tmp = file + "." + crypto.randomBytes(4).toString("hex") + ".tmp";
    await fsp.writeFile(tmp, value, { encoding: "utf8", mode: 0o600 });
    await fsp.rename(tmp, file);
  }
  const saveClients = () => atomicWrite(CLIENTS_FILE, JSON.stringify(Object.fromEntries(clients), null, 2)).catch(() => {});
  const saveTokens = () => atomicWrite(TOKENS_FILE, JSON.stringify({
    access: Object.fromEntries(accessTokens), refresh: Object.fromEntries(refreshTokens),
  }, null, 2)).catch(() => {});

  async function init() {
    await fsp.mkdir(OAUTH_DIR, { recursive: true });
    try {
      const raw = JSON.parse(await fsp.readFile(CLIENTS_FILE, "utf8"));
      for (const c of Object.values(raw)) {
        if (c && typeof c.clientId === "string" && Array.isArray(c.redirectUris)) clients.set(c.clientId, c);
      }
    } catch (error) { if (error.code !== "ENOENT") throw error; }
    try {
      const raw = JSON.parse(await fsp.readFile(TOKENS_FILE, "utf8"));
      for (const [h, r] of Object.entries(raw.access || {})) if (r && r.exp > Date.now()) accessTokens.set(h, r);
      for (const [h, r] of Object.entries(raw.refresh || {})) if (r && r.exp > Date.now()) refreshTokens.set(h, r);
    } catch (error) { if (error.code !== "ENOENT") throw error; }
    try {
      const lockout = JSON.parse(await fsp.readFile(PIN_LOCKOUT_FILE, "utf8"));
      if (Array.isArray(lockout.failures)) pinFailures.push(...lockout.failures.filter(n => Number.isFinite(n) && n > Date.now() - PIN_FAILURE_WINDOW));
      if (Number.isFinite(lockout.lockedUntil) && lockout.lockedUntil > Date.now()) pinLockedUntil = lockout.lockedUntil;
    } catch (error) { if (error.code !== "ENOENT" && !(error instanceof SyntaxError)) throw error; }
    if (process.env.WDB_OAUTH_CONSENT_PIN) {
      pin = String(process.env.WDB_OAUTH_CONSENT_PIN);
    } else {
      try { pin = (await fsp.readFile(PIN_FILE, "utf8")).trim(); }
      catch (error) {
        if (error.code !== "ENOENT") throw error;
        pin = crypto.randomBytes(16).toString("hex");
        await atomicWrite(PIN_FILE, pin + "\n");
      }
    }
    clientsLoaded = true;
    const sweep = setInterval(() => {
      const now = Date.now();
      for (const [id, r] of pending) if (r.exp < now) pending.delete(id);
      for (const [h, r] of authCodes) if (r.exp < now) authCodes.delete(h);
      for (const [h, r] of accessTokens) if (r.exp < now) accessTokens.delete(h);
      for (const [h, r] of refreshTokens) if (r.exp < now) refreshTokens.delete(h);
      while (pinFailures.length && pinFailures[0] < now - PIN_FAILURE_WINDOW) pinFailures.shift();
    }, 60000);
    sweep.unref();
  }

  function registerClient(body) {
    if (!body || typeof body !== "object") throw oauthError(400, "invalid_client_metadata", "请求体必须是 JSON 对象");
    const uris = body.redirect_uris;
    if (!Array.isArray(uris) || !uris.length) throw oauthError(400, "invalid_redirect_uri", "redirect_uris 必须是非空数组");
    if (uris.length > 10) throw oauthError(400, "invalid_redirect_uri", "redirect_uris 最多 10 个");
    if (!uris.every(acceptableRedirect)) {
      throw oauthError(400, "invalid_redirect_uri", "仅接受 https 或本机环回 http://127.0.0.1 / http://localhost 回调");
    }
    const name = body.client_name === undefined ? "MCP client" : String(body.client_name);
    if (name.length > 100) throw oauthError(400, "invalid_client_metadata", "client_name 过长");
    const clientId = randomToken(16);
    const record = { clientId, clientName: name, redirectUris: [...new Set(uris)], createdAt: new Date().toISOString() };
    clients.set(clientId, record);
    saveClients();
    process.stderr.write(`[oauth] register client_id=${clientId} name="${record.clientName}" redirect_uris=${JSON.stringify(record.redirectUris)}\n`);
    return {
      client_id: clientId,
      client_id_created_at: Math.floor(Date.now() / 1000),
      client_name: record.clientName,
      redirect_uris: record.redirectUris,
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      token_endpoint_auth_method: "none",
      scope: SCOPE,
    };
  }

  function startAuthorize(params, baseUrl) {
    const client = clients.get(String(params.client_id || ""));
    if (!client) return { kind: "html", status: 400, html: errorPage("未知或缺少 client_id。该应用需要先进行动态客户端注册。") };
    const redirectUri = String(params.redirect_uri || "");
    if (!redirectUri || !client.redirectUris.some(u => redirectMatches(u, redirectUri))) {
      process.stderr.write(`[oauth] authorize redirect mismatch: client_id=${client.clientId} supplied="${redirectUri}" registered=${JSON.stringify(client.redirectUris)}\n`);
      return { kind: "html", status: 400, html: errorPage("redirect_uri 与该客户端注册的回调地址不匹配。") };
    }
    const fail = (error, description) => ({ kind: "redirect", location: buildRedirect(redirectUri, { error, error_description: description, state: params.state }) });
    if (params.response_type !== "code") return fail("unsupported_response_type", "仅支持 response_type=code");
    if (!params.code_challenge || params.code_challenge_method !== "S256") {
      return fail("invalid_request", "必须提供 PKCE code_challenge（S256）");
    }
    if (!/^[A-Za-z0-9_-]{43,128}$/.test(String(params.code_challenge))) return fail("invalid_request", "code_challenge 格式无效");
    // scope 宽松处理：接受缺省或任意客户端请求值，实际只颁发 mcp
    if (params.resource) {
      const norm = value => String(value).replace(/\/+$/, "");
      const allowed = [norm(baseUrl), norm(baseUrl) + "/mcp"];
      if (!allowed.includes(norm(params.resource))) return fail("invalid_target", "resource 与本服务器地址不匹配");
    }
    const id = randomToken(16);
    pending.set(id, {
      clientId: client.clientId, redirectUri, state: params.state ? String(params.state) : "",
      scope: SCOPE, challenge: String(params.code_challenge), exp: Date.now() + AUTHREQ_TTL_MS, attempts: 0,
    });
    return { kind: "consent", html: renderConsent(id, client, redirectUri, "") };
  }

  function renderConsent(id, client, redirectUri, errorMsg) {
    const errorHtml = errorMsg ? `<p class="err">${escapeHtml(errorMsg)}</p>` : "";
    return page("授权确认 — Windows Developer Bridge", `
      ${errorHtml}
      <p>应用 <strong>${escapeHtml(client.clientName)}</strong> 请求访问本机 Windows Developer Bridge。</p>
      <p class="muted">客户端 ID：<code>${escapeHtml(client.clientId)}</code><br>回调地址：<code>${escapeHtml(redirectUri)}</code><br>请求权限：<code>${SCOPE}</code>（Shell / 文件系统等 MCP 工具，受本机 FULL_ACCESS_ENABLED 锁控制）</p>
      <form method="post" action="/authorize/approve">
        <input type="hidden" name="auth_request_id" value="${escapeHtml(id)}">
        <label for="pin">操作员授权 PIN（在运行 WDB 的本机查看）：</label><br><br>
        <input id="pin" name="pin" inputmode="text" autocomplete="off" required autofocus
          placeholder="32 位十六进制授权密钥" pattern="[a-fA-F0-9]{32}" maxlength="32" style="width:180px;letter-spacing:2px"><br><br>
        <button class="ok" type="submit" name="decision" value="approve">批准授权</button>
        <button class="deny" type="submit" name="decision" value="deny">拒绝</button>
      </form>
      <p class="muted">PIN 由 WDB 首次启动时生成，保存在本机数据目录 <code>oauth\\consent.pin</code>，
      并打印在 HTTP 服务终端中。不要把 PIN 交给任何远程方。</p>`);
  }

  function approve(form) {
    const id = String(form.auth_request_id || "");
    const record = pending.get(id);
    if (!record || record.exp < Date.now()) {
      pending.delete(id);
      return { kind: "html", status: 400, html: errorPage("授权请求不存在或已过期，请回到应用重新发起授权。") };
    }
    if (form.decision === "deny") {
      pending.delete(id);
      return { kind: "redirect", location: buildRedirect(record.redirectUri, { error: "access_denied", error_description: "操作员拒绝授权", state: record.state }) };
    }
    const now = Date.now();
    while (pinFailures.length && pinFailures[0] < now - PIN_FAILURE_WINDOW) pinFailures.shift();
    if (pinLockedUntil > now) {
      return { kind: "html", status: 429, html: errorPage(`PIN 已锁定，请约 ${Math.ceil((pinLockedUntil - now) / 60000)} 分钟后再试。`) };
    }
    if (pinLockedUntil && pinLockedUntil <= now) pinLockedUntil = 0;
    if (pinFailures.length >= MAX_GLOBAL_PIN_FAILURES) {
      pinLockedUntil = now + PIN_LOCKOUT_MS;
      void atomicWrite(PIN_LOCKOUT_FILE, JSON.stringify({ failures: pinFailures, lockedUntil: pinLockedUntil }, null, 2));
      return { kind: "html", status: 429, html: errorPage("PIN 错误次数过多，已锁定 15 分钟。") };
    }
    const supplied = String(form.pin || "").replace(/\s+/g, "");
    if (!timingSafeEqual(supplied, pin)) {
      pinFailures.push(now);
      if (pinFailures.length >= MAX_GLOBAL_PIN_FAILURES) pinLockedUntil = now + PIN_LOCKOUT_MS;
      void atomicWrite(PIN_LOCKOUT_FILE, JSON.stringify({ failures: pinFailures, lockedUntil: pinLockedUntil }, null, 2));
      record.attempts += 1;
      if (record.attempts >= MAX_PIN_ATTEMPTS) {
        pending.delete(id);
        return { kind: "html", status: 400, html: errorPage("PIN 连续错误，该授权请求已作废。请重新发起授权。") };
      }
      const client = clients.get(record.clientId);
      return { kind: "consent", status: 200, html: renderConsent(id, client, record.redirectUri, `PIN 错误（还可尝试 ${MAX_PIN_ATTEMPTS - record.attempts} 次）`) };
    }
    const code = randomToken(24);
    authCodes.set(sha256(code), {
      clientId: record.clientId, redirectUri: record.redirectUri, challenge: record.challenge,
      scope: record.scope, exp: Date.now() + CODE_TTL_MS,
    });
    pending.delete(id);
    return { kind: "redirect", location: buildRedirect(record.redirectUri, { code, state: record.state }) };
  }

  function exchangeToken(form) {
    const grant = String(form.grant_type || "");
    if (grant === "authorization_code") return exchangeCode(form);
    if (grant === "refresh_token") return exchangeRefresh(form);
    throw oauthError(400, "unsupported_grant_type", "支持 authorization_code 与 refresh_token");
  }

  function exchangeCode(form) {
    const record = authCodes.get(sha256(String(form.code || "")));
    authCodes.delete(sha256(String(form.code || ""))); // 一次性使用，失败也作废
    if (!record || record.exp < Date.now()) throw oauthError(400, "invalid_grant", "授权码无效或已过期");
    if (form.client_id && String(form.client_id) !== record.clientId) throw oauthError(400, "invalid_grant", "client_id 不匹配");
    if (!form.redirect_uri || String(form.redirect_uri) !== record.redirectUri) {
      throw oauthError(400, "invalid_grant", "redirect_uri 与授权时不一致");
    }
    const verifier = String(form.code_verifier || "");
    if (!/^[A-Za-z0-9_-]{43,128}$/.test(verifier)) throw oauthError(400, "invalid_grant", "code_verifier 无效");
    const challenge = crypto.createHash("sha256").update(verifier, "ascii").digest("base64url");
    if (!timingSafeEqual(challenge, record.challenge)) throw oauthError(400, "invalid_grant", "PKCE 校验失败");
    return issueTokens(record.clientId, record.scope);
  }

  function exchangeRefresh(form) {
    const hash = sha256(String(form.refresh_token || ""));
    const record = refreshTokens.get(hash);
    refreshTokens.delete(hash); // 刷新令牌轮换：旧令牌立即失效
    if (!record || record.exp < Date.now()) throw oauthError(400, "invalid_grant", "refresh_token 无效或已过期");
    saveTokens();
    return issueTokens(record.clientId, record.scope);
  }

  function issueTokens(clientId, scope) {
    const access = randomToken(32), refresh = randomToken(32);
    const accessHash = sha256(access), refreshHash = sha256(refresh);
    accessTokens.set(accessHash, { clientId, scope, exp: Date.now() + ACCESS_TTL_MS, refreshHash });
    refreshTokens.set(refreshHash, { clientId, scope, exp: Date.now() + REFRESH_TTL_MS });
    saveTokens();
    return { access_token: access, refresh_token: refresh, token_type: "Bearer", expires_in: Math.floor(ACCESS_TTL_MS / 1000), scope };
  }

  function verifyAccess(raw) {
    const record = accessTokens.get(sha256(raw));
    if (!record) return null;
    if (record.exp < Date.now()) { accessTokens.delete(sha256(raw)); saveTokens(); return null; }
    return record;
  }

  function revoke(raw) {
    if (!raw) return;
    const hash = sha256(raw);
    const access = accessTokens.get(hash);
    if (access) { accessTokens.delete(hash); if (access.refreshHash) refreshTokens.delete(access.refreshHash); }
    if (refreshTokens.has(hash)) {
      refreshTokens.delete(hash);
      for (const [h, r] of accessTokens) if (r.refreshHash === hash) accessTokens.delete(h);
    }
    saveTokens();
  }

  function metadata(baseUrl) {
    return {
      protectedResource: {
        resource: baseUrl,
        authorization_servers: [baseUrl],
        bearer_methods_supported: ["header"],
        scopes_supported: [SCOPE],
      },
      authorizationServer: {
        issuer: baseUrl,
        authorization_endpoint: baseUrl + "/authorize",
        token_endpoint: baseUrl + "/token",
        registration_endpoint: baseUrl + "/register",
        revocation_endpoint: baseUrl + "/revoke",
        revocation_endpoint_auth_methods_supported: ["none"],
        code_challenge_methods_supported: ["S256"],
        response_types_supported: ["code"],
        grant_types_supported: ["authorization_code", "refresh_token"],
        token_endpoint_auth_methods_supported: ["none"],
        scopes_supported: [SCOPE],
      },
    };
  }

  async function handle(req, res, baseUrl) {
    const url = new URL(req.url || "/", baseUrl);
    const p = url.pathname.replace(/\/+$/, "") || "/";
    const corsHeaders = {
      "access-control-allow-origin": "*",
      "access-control-allow-headers": "authorization,content-type",
      "access-control-allow-methods": "GET,POST,OPTIONS",
    };
    const json = (status, value, extra = {}) => {
      const body = JSON.stringify(value);
      res.writeHead(status, {
        "content-type": "application/json; charset=utf-8", "content-length": Buffer.byteLength(body),
        "cache-control": "no-store", "x-content-type-options": "nosniff", ...corsHeaders, ...extra,
      });
      res.end(body);
      return true;
    };
    const html = (status, content) => {
      res.writeHead(status, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
      res.end(content);
      return true;
    };
    const redirect = location => {
      res.writeHead(302, { location, "cache-control": "no-store" });
      res.end();
      return true;
    };

    const routes = [
      "/.well-known/oauth-protected-resource",
      "/.well-known/oauth-authorization-server",
      "/register", "/authorize", "/authorize/approve", "/token", "/revoke",
    ];
    if (!routes.includes(p)) return false;
    if (req.method === "OPTIONS") { res.writeHead(204, corsHeaders); res.end(); return true; }

    try {
      if (p === "/.well-known/oauth-protected-resource") {
        if (req.method !== "GET") return json(405, { error: "method_not_allowed" });
        return json(200, metadata(baseUrl).protectedResource);
      }
      if (p === "/.well-known/oauth-authorization-server") {
        if (req.method !== "GET") return json(405, { error: "method_not_allowed" });
        return json(200, metadata(baseUrl).authorizationServer);
      }
      if (p === "/register") {
        if (req.method !== "POST") return json(405, { error: "method_not_allowed" });
        let body;
        try { body = JSON.parse(await readSmallBody(req) || "{}"); }
        catch (error) { return json(error.status || 400, { error: "invalid_client_metadata", error_description: error.message }); }
        return json(201, registerClient(body));
      }
      if (p === "/authorize") {
        if (req.method !== "GET") return html(405, errorPage("仅支持 GET"));
        const outcome = startAuthorize(Object.fromEntries(url.searchParams), baseUrl);
        if (outcome.kind === "redirect") return redirect(outcome.location);
        return html(outcome.status || 200, outcome.html);
      }
      if (p === "/authorize/approve") {
        if (req.method !== "POST") return html(405, errorPage("仅支持 POST"));
        const form = new URLSearchParams(await readSmallBody(req));
        const outcome = approve(Object.fromEntries(form));
        if (outcome.kind === "redirect") {
          res.writeHead(302, { location: outcome.location, "cache-control": "no-store" });
          return res.end();
        }
        return html(outcome.status || 200, outcome.html);
      }
      if (p === "/revoke") {
        // RFC 7009：撤销 access 或 refresh token；未知 token 也返回 200
        if (req.method !== "POST") return json(405, { error: "method_not_allowed" });
        const form = Object.fromEntries(new URLSearchParams(await readSmallBody(req)));
        revoke(String(form.token || ""));
        return json(200, {});
      }
      if (p === "/token") {
        if (req.method !== "POST") return json(405, { error: "method_not_allowed" });
        const form = new URLSearchParams(await readSmallBody(req));
        return json(200, exchangeToken(Object.fromEntries(form)));
      }
    } catch (error) {
      if (error && error.oauth) return json(error.status, { error: error.code, error_description: error.description });
      process.stderr.write("oauth error: " + (error && error.stack ? error.stack : error) + "\n");
      return json(500, { error: "server_error" });
    }
    return true;
  }

  return { init, handle, verifyAccess, getPin: () => pin, clientsLoaded: () => clientsLoaded };
}

function oauthError(status, code, description) {
  return Object.assign(new Error(description), { oauth: true, status, code, description });
}
function buildRedirect(uri, params) {
  const url = new URL(uri);
  for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== null && v !== "") url.searchParams.set(k, v);
  return url.href;
}
