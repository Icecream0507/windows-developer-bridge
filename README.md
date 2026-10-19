# Windows Developer Bridge (WDB)

[![Windows CI](https://github.com/Icecream0507/windows-developer-bridge/actions/workflows/ci.yml/badge.svg)](https://github.com/Icecream0507/windows-developer-bridge/actions/workflows/ci.yml) [![MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)

Windows-first compatibility port of Mac Developer Bridge. **Early implementation; not production-ready or a complete MDB mirror.** The HTTP adapter is new and needs Windows end-to-end validation.

## Requirements

- Windows 10/11
- Node.js 20+ (LTS recommended)
- Git for Windows
- [cloudflared](https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/downloads/)
- PowerShell 7 recommended for shell tools

## 1. Clone

Open PowerShell:

```powershell
git clone https://github.com/Icecream0507/windows-developer-bridge.git
cd windows-developer-bridge
node --version
```

No `npm install` is needed for the current version; it uses Node.js built-ins.

## 2. Start the authenticated MCP HTTP service

The HTTP adapter supports two auth modes simultaneously: an optional static bearer token (admin) and a built-in OAuth 2.1 authorization server for MCP clients (dynamic registration + PKCE).

Open PowerShell **Terminal A**. If you already have a tunnel hostname, export it first so OAuth metadata advertises the correct issuer:

```powershell
$env:WDB_HTTP_PORT = "8787"
# Required for remote OAuth clients; must be the exact public base URL clients use:
$env:WDB_HTTP_PUBLIC_URL = "https://YOUR-ACTUAL-HOST.trycloudflare.com"
# Optional static admin token; omit it to run OAuth-only:
$env:WDB_HTTP_TOKEN = node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
node .\mcp-http.mjs
```

(Or use `start-tunnel.ps1` to get a hostname, put it in `.env.http` as `WDB_HTTP_PUBLIC_URL=...`, then run `start-http.ps1`.)

Keep this terminal open. The startup banner prints the **OAuth consent PIN**, a 9-digit local-operator code also stored in `<dataDir>/oauth/consent.pin`. A remote client can only complete authorization if the person at this machine enters that PIN on the consent page. Save any static token privately; do not put it in URLs, source control, or screenshots.

Default local MCP endpoint: `http://127.0.0.1:8787/mcp`. The service binds to loopback, requires credentials, and also provides `GET /healthz`. OAuth discovery endpoints:

- `GET /.well-known/oauth-protected-resource`
- `GET /.well-known/oauth-authorization-server`
- `POST /register` (RFC 7591 dynamic client registration; `https` or loopback `redirect_uris` only)
- `GET /authorize` (PKCE S256 mandatory, local-operator PIN consent page)
- `POST /token` (authorization code, refresh-token rotation)

In **Terminal B**, verify local health:

```powershell
Invoke-RestMethod http://127.0.0.1:8787/healthz
```

Expected: JSON containing `ok: true`. Verify the protected endpoint rejects unauthenticated requests (401 is expected):

```powershell
try { Invoke-WebRequest http://127.0.0.1:8787/mcp -Method Post -ContentType "application/json" -Body '{"jsonrpc":"2.0","id":1,"method":"ping"}' } catch { $_.Exception.Response.StatusCode }
```

For an authenticated MCP protocol check, in Terminal B set the same token (paste it locally, do not share it):

```powershell
$env:WDB_HTTP_TOKEN = "PASTE_YOUR_TOKEN_HERE"
$headers = @{ Authorization = "Bearer $env:WDB_HTTP_TOKEN"; Accept = "application/json, text/event-stream" }
$body = @{ jsonrpc = "2.0"; id = 1; method = "initialize"; params = @{ protocolVersion = "2025-11-25"; capabilities = @{}; clientInfo = @{ name = "manual-test"; version = "1.0.0" } } } | ConvertTo-Json -Depth 8
Invoke-RestMethod http://127.0.0.1:8787/mcp -Method Post -Headers $headers -ContentType "application/json" -Body $body
```

## 3. Start a Cloudflare Quick Tunnel

Install `cloudflared` following [Cloudflare's official instructions](https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/downloads/). On Windows, this may also work:

```powershell
winget install --id Cloudflare.cloudflared
```

Once installed, open **Terminal C** and run:

```powershell
cloudflared tunnel --url http://127.0.0.1:8787 --protocol http2
# on networks where the Quick Tunnel API is unreachable directly, set HTTPS_PROXY to a local proxy first
```

Wait for a URL like `https://some-words.trycloudflare.com` in the output. Your MCP URL is the exact URL printed by cloudflared with `/mcp` appended:

`https://YOUR-ACTUAL-HOST.trycloudflare.com/mcp`

**Ordering for OAuth:** because the OAuth issuer must match the public hostname, start the tunnel first, copy the hostname, then start the HTTP adapter with `WDB_HTTP_PUBLIC_URL=https://YOUR-ACTUAL-HOST.trycloudflare.com` (or store it in `.env.http` and use `start-http.ps1`). The hostname is temporary and may change when the tunnel restarts; update the variable and restart the adapter when it does. Keep both processes running; stop with Ctrl+C in Terminal C and then Terminal A.

## 4. Configure your MCP client

Add a **remote MCP / Streamable HTTP** server:

- **Server URL:** `https://YOUR-ACTUAL-HOST.trycloudflare.com/mcp` (replace with the hostname cloudflared printed)
- **Authentication (OAuth, preferred):** let the client discover and register itself. The flow is:
  1. client fetches the protected-resource metadata from the MCP endpoint and gets a dynamically issued **client ID** from `POST /register`;
  2. browser opens `/authorize` and shows the consent page;
  3. **you**, at this machine, enter the 9-digit consent PIN and approve;
  4. the client exchanges the PKCE authorization code for an access token (12 h) and refresh token (30 d, rotated on use).
- **Authentication (static token, optional):** clients that support a custom header can use `Authorization: Bearer YOUR_WDB_HTTP_TOKEN`.

Do not enter the placeholder URL literally, and never append a token to the URL.

**Connector caveats:** the adapter implements OAuth metadata discovery (RFC 9728/RFC 8414), dynamic client registration (RFC 7591), PKCE authorization-code flow, and refresh-token rotation. It does **not** implement SSE/GET streaming on `/mcp` (JSON-RPC `POST` only) and every consent decision requires the local-operator PIN by design — a remote party cannot self-approve. If a connector insists on "No authentication", do not use that option; it is unsupported by design. Redirect URIs must be `https` or RFC 8252 loopback addresses (`http://127.0.0.1`/`http://localhost`, any port).

## 5. Enable local tools deliberately

The bridge starts with privileged tools locked. `bridge_status` can report status while locked, but shell and filesystem operations require the local unlock file. First call `bridge_status` and inspect its `unlockFile` field; on a standard Windows profile this is normally `%LOCALAPPDATA%\WindowsDeveloperBridge\FULL_ACCESS_ENABLED`.

Read [SECURITY.md](SECURITY.md) before enabling it. Create an empty file at the exact path returned by `bridge_status` to unlock, and remove that same file to lock again. Only do this if you understand that enabled commands and file operations run with your Windows user's permissions. This is not a sandbox, and a public tunnel means remote parties can attempt to reach the service. Keep the token private and stop the tunnel when not in use.

## Troubleshooting

| Problem | Check |
|---|---|
| Token too short/missing | Set `WDB_HTTP_TOKEN` to a fresh random token as shown above. |
| Local health works, remote URL fails | Keep both processes running; use the current Quick Tunnel hostname and append `/mcp`. |
| `401 Unauthorized` | Supply `Authorization: Bearer <token>`; verify the client supports custom bearer headers. |
| `404 Not found` | Endpoint is `/mcp`, not the root URL. |
| `cloudflared` not recognized | Install it from Cloudflare's official guide and reopen PowerShell. |
| Tools report full access locked | Check the `unlockFile` returned by `bridge_status` and review `SECURITY.md`. |
| Client rejects OAuth metadata / issuer mismatch | Set `WDB_HTTP_PUBLIC_URL` to the exact public base URL clients use and restart the adapter. |
| Consent page PIN unknown | Read the startup banner or `<dataDir>/oauth/consent.pin` on the bridge machine; never share it remotely. |
| Connector only offers "no authentication" | Unsupported by design; configure OAuth or a static bearer header instead. |

## Development and tests

```powershell
node --check .\bridge.mjs
node --check .\mcp-http.mjs
node --test
```

The current automated suite primarily tests the stdio bridge. Dedicated HTTP auth, Cloudflare, OAuth/SSE, and Windows process-containment end-to-end tests are still needed.

## Implemented and missing

Initial implementation includes MCP stdio protocol, local PowerShell/filesystem/job tools, patch application, Codex history adapter, audit log, fail-closed unlock latch, and an HTTP JSON-RPC adapter with static bearer auth plus an OAuth 2.1 server (RFC 9728/8414 metadata, RFC 7591 dynamic client registration, PKCE, refresh rotation, PIN-gated local-operator consent). Still missing or unverified: SSE/streaming transport, full original tool/schema parity, ConPTY, Chrome extension/native messaging, browser workspace, hardened Windows process containment, and complete revocation lifecycle. See [TODO.md](TODO.md) and [compatibility matrix](docs/compatibility-matrix.md).

## Security

The HTTP service binds to loopback by default. Cloudflare Quick Tunnels create a publicly reachable URL; bearer authentication is mandatory but is not a substitute for restricting access. Use a unique high-entropy token and stop the tunnel when it is not needed. See [SECURITY.md](SECURITY.md).
