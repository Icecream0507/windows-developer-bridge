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

Open PowerShell **Terminal A**. Generate a high-entropy token and start the HTTP adapter:

```powershell
$env:WDB_HTTP_TOKEN = node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
$env:WDB_HTTP_PORT = "8787"
node .\mcp-http.mjs
```

Keep this terminal open. Save the generated token privately; do not put it in the URL, source control, screenshots, or issue reports. If you restart the service, generate/set the token again.

Default local MCP endpoint: `http://127.0.0.1:8787/mcp`. The service binds to loopback, requires a Bearer token, and also provides `GET /healthz`.

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

Once installed, open **Terminal C** (keep Terminal A running) and run:

```powershell
cloudflared tunnel --url http://127.0.0.1:8787
```

Wait for a URL like `https://some-words.trycloudflare.com` in the output. Your MCP URL is the exact URL printed by cloudflared with `/mcp` appended:

`https://YOUR-ACTUAL-HOST.trycloudflare.com/mcp`

The hostname is temporary and may change when the tunnel restarts. Keep both the HTTP server and tunnel running. Stop with Ctrl+C in Terminal C and then Terminal A.

## 4. Configure your MCP client

Add a **remote MCP / Streamable HTTP** server:

- **Server URL:** `https://YOUR-ACTUAL-HOST.trycloudflare.com/mcp` (replace with the hostname cloudflared printed)
- **Authentication:** Bearer token / custom Authorization header, if supported
- **Header:** `Authorization: Bearer YOUR_WDB_HTTP_TOKEN`

Do not enter the placeholder URL literally, and never append the token to the URL.

**ChatGPT compatibility caveat:** this initial adapter supports authenticated JSON-RPC `POST /mcp`, `GET /healthz`, and static bearer-token authentication. It does not yet implement OAuth discovery/authorization or SSE streaming. Some ChatGPT connector setup flows require OAuth and do not provide a static bearer-header field; those flows are not supported by this adapter as-is. Do not select “No authentication” as a workaround. Use an MCP client that supports custom bearer headers, or add and test OAuth before claiming compatibility with an OAuth-only connector.

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
| ChatGPT only offers OAuth/no-auth | OAuth is not implemented in this adapter yet. |

## Development and tests

```powershell
node --check .\bridge.mjs
node --check .\mcp-http.mjs
node --test
```

The current automated suite primarily tests the stdio bridge. Dedicated HTTP auth, Cloudflare, OAuth/SSE, and Windows process-containment end-to-end tests are still needed.

## Implemented and missing

Initial implementation includes MCP stdio protocol, local PowerShell/filesystem/job tools, patch application, Codex history adapter, audit log, fail-closed unlock latch, and a bearer-authenticated HTTP JSON-RPC adapter. Still missing or unverified: OAuth, SSE/streaming, full original tool/schema parity, ConPTY, Chrome extension/native messaging, browser workspace, hardened Windows process containment, and complete revocation lifecycle. See [TODO.md](TODO.md) and [compatibility matrix](docs/compatibility-matrix.md).

## Security

The HTTP service binds to loopback by default. Cloudflare Quick Tunnels create a publicly reachable URL; bearer authentication is mandatory but is not a substitute for restricting access. Use a unique high-entropy token and stop the tunnel when it is not needed. See [SECURITY.md](SECURITY.md).
