---
name: windows-developer-bridge
description: Install, start, connect and troubleshoot Windows Developer Bridge (WDB), an MCP server that exposes this Windows PC (PowerShell, files, background jobs, real ConPTY terminals, patches, Codex history) to ChatGPT, Claude and other MCP clients through an authenticated Cloudflare tunnel; also how to use its tools well. Use when the user wants ChatGPT/Claude to access or control their Windows computer, asks to set up, start, stop, restart or fix WDB / the `wdb` command, needs the MCP URL, consent PIN or token, or is calling WDB tools (shell_exec, fs_*, pty_*, apply_patch). 触发：让 ChatGPT 远程操作我的 Windows 电脑、MCP 桥接、wdb 启动/连接/报错。
---

# Windows Developer Bridge (WDB)

WDB turns a Windows 10/11 PC into an MCP server. Remote clients (ChatGPT connectors, Claude, etc.) reach it at `https://<random>.trycloudflare.com/mcp`, authenticate with OAuth 2.1 and a 9-digit consent PIN that only the person at the PC can see, and then run tools with that Windows user's permissions. Local clients can use the same tools over stdio.

## Install / update / remove

Run in PowerShell (no admin needed):

```powershell
irm https://raw.githubusercontent.com/Icecream0507/windows-developer-bridge/main/install.ps1 | iex
```

This installs Node.js LTS via winget when needed, puts the app in `%LOCALAPPDATA%\WindowsDeveloperBridge\app`, downloads cloudflared, adds `wdb` to the user PATH, installs this skill for Claude Code/Codex, enables full access and runs `wdb start`. Set `$env:WDB_NO_START=1` or `$env:WDB_LOCKED=1` before the one-liner to skip starting or to keep tools locked. Update with `wdb update`; remove with `wdb uninstall` (`--purge` also deletes config, tokens and audit log).

If `wdb` is not recognised right after installing, open a new terminal or call `%LOCALAPPDATA%\WindowsDeveloperBridge\bin\wdb.cmd`.

## Everyday commands

| Command | Effect |
|---|---|
| `wdb start` | Start the HTTP MCP service and the configured tunnel in the background; prints the MCP URL (also copied to the clipboard) and the consent PIN. `--local` skips the tunnel, `--port N` changes the port. |
| `wdb status` | Health, tunnel mode, URL, PIN, lock state; flags a tunnel that is reconnecting or a Quick Tunnel URL that Cloudflare has recycled. |
| `wdb stop` / `wdb restart` | Stop / restart service and tunnel (a Quick Tunnel gets a new URL on every start; a fixed URL stays). |
| `wdb tunnel [quick\|setup\|ssh\|none]` | Show or switch the tunnel. `wdb tunnel setup <ssh-host> <domain> [--port 8443]` gives a permanent URL through the user's own server (see below). |
| `wdb url`, `wdb pin`, `wdb token` | Print just the MCP URL, the PIN, or the static bearer token. |
| `wdb unlock` / `wdb lock` | Enable / disable command and file tools (`bridge_status` always works). Locking also kills running jobs and terminals. |
| `wdb logs [http\|tunnel] [-f]` | Show service or tunnel logs. |
| `wdb doctor` | Check Node, PowerShell, Git, Codex, ConPTY and the tunnel: Cloudflare reachability, or SSH key login + public URL in ssh mode. |
| `wdb mcp-config` | Print stdio config for Claude Code, Codex, Claude Desktop, Cursor. |
| `wdb reset-auth` | Revoke every OAuth client/token and generate a new PIN and token. |

## Connect a client

**ChatGPT** (needs developer mode for custom connectors): Settings → Apps & Connectors → Advanced → enable Developer mode → Create connector. URL = the `https://…/mcp` address from `wdb start`, authentication = OAuth. A consent page opens; the user types the PIN shown by `wdb start` / `wdb pin` and approves. When the tunnel URL changes, edit the connector URL.

## Tunnels and when the URL changes

- **Quick Tunnel** (default, zero config): new `*.trycloudflare.com` URL on every `wdb start`/`restart` and after a reboot. Short network drops reconnect with the same URL, but if the PC stays offline for a long time (observed: ~80 min) Cloudflare deletes the tunnel; the log shows `Tunnel not found`, `wdb status` reports the URL as expired, and only `wdb restart` (new URL) fixes it.
- **Own server, fixed URL** (`ssh` mode): needs a Linux server with key-based SSH login, sudo, Docker, and a domain pointing at it with a Let's Encrypt certificate in `/etc/letsencrypt/live/<domain>/`. `wdb tunnel setup <ssh-host> <domain> [--port 8443]` uploads `scripts/server/setup-wdb-proxy.sh`, which starts an `nginx:alpine` container `wdb-proxy-<port>` (host network, `https://<domain>:<port>` → `127.0.0.1:18787`), adds a certbot deploy hook, and enables sshd `ClientAliveInterval 15` so dead sessions release the port. It never touches existing sites. Then open TCP `<port>` in the cloud security group and `wdb restart`. `lib/ssh-tunnel.mjs` keeps `ssh -R 127.0.0.1:18787:127.0.0.1:8787` alive and reconnects after drops/sleep (≈1 min worst case). TLS terminates on that server, so its root users can see traffic.
- **Named Cloudflare tunnel**: `CLOUDFLARE_TUNNEL_TOKEN=...` + `WDB_HTTP_PUBLIC_URL=https://your.host` in `config.env`.
- **None**: `wdb tunnel none` or `wdb start --local`.

**Clients with custom headers**: same URL with header `Authorization: Bearer <wdb token>`.

**Local stdio clients** (Claude Code, Codex, Claude Desktop, Cursor): run `wdb mcp-config` and use the printed command, e.g. `claude mcp add --scope user windows-bridge -- node "%LOCALAPPDATA%\WindowsDeveloperBridge\app\bridge.mjs"`.

## Using the tools well

Call `bridge_status` first: it reports the host, which PowerShell is used (`pwsh` 7 or Windows PowerShell 5.1), Git/Codex/ConPTY availability and whether full access is unlocked. Full tool reference: [references/tools.md](references/tools.md).

- **Commands**: `shell_exec` runs PowerShell, not bash. On 5.1 use `;` instead of `&&`, `$env:NAME` for variables, `Get-ChildItem`, `Select-String`, `Invoke-WebRequest`. Output is UTF-8; `exitCode` reflects `exit N` or the last native command. Huge output is cut to head + tail (`outputTruncated`). Default timeout 10 min, max 30 min.
- **Long-running processes** (dev servers, builds, watchers): `shell_start`, then `shell_job_status` with `wait_ms` to block until it finishes, or `stdout_offset` = previous `stdoutNextOffset` to read new output only. Jobs survive bridge restarts; stop them with `shell_job_kill`.
- **Interactive programs** (REPLs, ssh, installers asking questions, TUIs): `pty_start` (omit `command` for an interactive PowerShell), then loop `pty_write` (`\r` = Enter, `\u0003` = Ctrl+C) and `pty_read` with `wait_ms: 1000-5000` and `strip_ansi: true`. Always `pty_close` when done.
- **Files**: prefer `fs_read`/`fs_write`/`fs_list`/`fs_stat`/`fs_manage` over shell commands. `fs_read` pages by bytes (`offset` = `nextOffset`); `fs_stat` returns `exists: false` for missing paths.
- **Code edits**: `apply_patch` with the Codex envelope, applied natively and atomically (no Git needed), CRLF preserved:

  ```
  *** Begin Patch
  *** Update File: src/app.js
  @@ function greet() {
  -  return "hi";
  +  return "hello";
  *** Add File: docs/notes.md
  +# Notes
  *** Delete File: old.txt
  *** End Patch
  ```

  Paths are relative to `cwd`. Unified git diffs also work (needs Git). Use `check_only: true` to validate first.
- **Codex history**: `codex_thread_list` / `codex_thread_read` / `codex_thread_turns_list` read local Codex CLI threads without starting turns.

## Troubleshooting

| Symptom | Fix |
|---|---|
| Tool returns `FULL_ACCESS_LOCKED` | User runs `wdb unlock` (deliberate opt-in). |
| ChatGPT says the server is unreachable / 404 / 530 | `wdb status`; if the tunnel died, the Quick Tunnel URL expired or the URL changed, `wdb restart` and update the connector URL (must end in `/mcp`). |
| ssh mode: `wdb doctor` says the public URL is unreachable | HTTP 0 = security group / firewall does not allow the port, or the `wdb-proxy-<port>` container is down (`wdb tunnel setup` again); 503 = proxy is up but the tunnel is not connected (`wdb logs tunnel`). `remote port forwarding failed` right after a network drop is expected for up to ~1 min. |
| Tunnel never connects | cloudflared always connects directly (it ignores HTTPS_PROXY and the system proxy). Run `wdb doctor`; if `api.trycloudflare.com:443` or `region1.v2.argotunnel.com:7844` is unreachable, enable the proxy app's TUN / virtual-adapter mode (Clash Verge, v2rayN), then `wdb restart`. Check `wdb logs tunnel`. |
| OAuth page rejects the PIN | Use the PIN from `wdb pin` on the PC; 5 wrong tries void the request, 30 failures in 10 min lock briefly. |
| Client keeps getting 401 after `wdb reset-auth` | Remove and re-add the connector so it registers again. |
| `Port 8787 is in use` | `wdb start --port 8788`. |
| Want a URL that never changes | Own server: `wdb tunnel setup <ssh-host> <domain>`, open the port, `wdb restart`. Or a named Cloudflare tunnel (see above). |

## Safety

Everything runs with the logged-in Windows user's permissions; there is no sandbox. The tunnel URL is public, so access relies on OAuth + the local PIN (or the static token). Keep the PIN/token private, `wdb lock` or `wdb stop` when not in use, and review `audit_tail` (records tool names and argument hashes, never contents).
