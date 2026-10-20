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
| `wdb start` | Start the HTTP MCP service and a Cloudflare Quick Tunnel in the background; prints the MCP URL (also copied to the clipboard) and the consent PIN. `--local` skips the tunnel, `--port N` changes the port. |
| `wdb status` | Health, URL, PIN, lock state. |
| `wdb stop` / `wdb restart` | Stop / restart service and tunnel (a Quick Tunnel gets a new URL on every start). |
| `wdb url`, `wdb pin`, `wdb token` | Print just the MCP URL, the PIN, or the static bearer token. |
| `wdb unlock` / `wdb lock` | Enable / disable command and file tools (`bridge_status` always works). Locking also kills running jobs and terminals. |
| `wdb logs [http\|tunnel] [-f]` | Show service or tunnel logs. |
| `wdb doctor` | Check Node, PowerShell, Git, Codex, ConPTY, cloudflared and whether Cloudflare is directly reachable. |
| `wdb mcp-config` | Print stdio config for Claude Code, Codex, Claude Desktop, Cursor. |
| `wdb reset-auth` | Revoke every OAuth client/token and generate a new PIN and token. |

## Connect a client

**ChatGPT** (needs developer mode for custom connectors): Settings → Apps & Connectors → Advanced → enable Developer mode → Create connector. URL = the `https://…trycloudflare.com/mcp` address from `wdb start`, authentication = OAuth. A consent page opens; the user types the PIN shown by `wdb start` / `wdb pin` and approves. When the tunnel URL changes, edit the connector URL.

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
| ChatGPT says the server is unreachable / 404 / 530 | `wdb status`; if the tunnel died or the URL changed, `wdb restart` and update the connector URL (must end in `/mcp`). |
| Tunnel never connects | cloudflared always connects directly (it ignores HTTPS_PROXY and the system proxy). Run `wdb doctor`; if `api.trycloudflare.com:443` or `region1.v2.argotunnel.com:7844` is unreachable, enable the proxy app's TUN / virtual-adapter mode (Clash Verge, v2rayN), then `wdb restart`. Check `wdb logs tunnel`. |
| OAuth page rejects the PIN | Use the PIN from `wdb pin` on the PC; 5 wrong tries void the request, 30 failures in 10 min lock briefly. |
| Client keeps getting 401 after `wdb reset-auth` | Remove and re-add the connector so it registers again. |
| `Port 8787 is in use` | `wdb start --port 8788`. |
| Want a URL that never changes | Create a named Cloudflare tunnel, then put `CLOUDFLARE_TUNNEL_TOKEN=...` and `WDB_HTTP_PUBLIC_URL=https://your.host` in `config.env`, `wdb restart`. |

## Safety

Everything runs with the logged-in Windows user's permissions; there is no sandbox. The tunnel URL is public, so access relies on OAuth + the local PIN (or the static token). Keep the PIN/token private, `wdb lock` or `wdb stop` when not in use, and review `audit_tail` (records tool names and argument hashes, never contents).
