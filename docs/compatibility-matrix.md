# MDB compatibility matrix

Compares the original Mac Developer Bridge (MDB) tool names with the Windows port. "Implemented" means implemented and covered by Windows tests in `tests/` (run in Windows CI); it does not claim byte-for-byte schema parity with MDB, which still needs a captured MDB fixture.

| Original tool | Windows port status | Notes |
|---|---|---|
| bridge_status | Implemented | Reports resolved PowerShell (pwsh 7 / 5.1), Git, Codex, ConPTY availability, lock state, job counts. |
| chrome_workspace_status | Not ported | Depends on the Chrome extension/native bridge. |
| chatgpt_extension_status | Not ported | Requires Windows extension/native-host support. |
| chatgpt_conversation_start | Not ported | First-party ChatGPT page runtime integration remains separate work. |
| chrome_workspace_setup | Not ported | Requires extension-owned tab pool. |
| chrome_tabs | Not ported | Requires Chrome profile/extension bridge. |
| chrome_open | Not ported | Requires Chrome extension bridge. |
| chrome_navigate | Not ported | Requires Chrome extension bridge. |
| chrome_snapshot | Not ported | Requires Chrome extension bridge. |
| chrome_click | Not ported | Requires Chrome extension bridge. |
| chrome_fill | Not ported | Requires Chrome extension bridge. |
| chrome_close | Not ported | Requires Chrome extension bridge. |
| shell_exec | Implemented | PowerShell 7 or 5.1; UTF-8 I/O; `exit N`/native exit codes; stdin; head+tail output caps; process-tree timeout kill; cwd validation. |
| shell_start | Implemented | Launched outside the bridge's job object so jobs survive bridge restarts; PID and exit code persisted to files. |
| shell_job_status | Implemented | `wait_ms`, byte-offset log paging, tails. |
| shell_job_list | Implemented | Refreshes live state; 14-day retention for finished jobs. |
| shell_job_kill | Implemented | `taskkill /T /F`, waits for the tree to exit. Signals are all forced kills on Windows. |
| fs_read | Implemented | Offset pagination, base64, UTF-8 pages never split characters. |
| fs_write | Implemented | Atomic replace with retry on AV/indexer locks; `mode` maps to the read-only attribute on Windows. |
| fs_list | Implemented | Bounded recursion; links/junctions listed but not traversed; unreadable subdirectories skipped and counted. |
| fs_stat | Implemented | Returns `exists:false` for missing paths. |
| fs_manage | Implemented | Parents created for copy/move; no silent overwrite without `force`; directory symlinks as junctions. |
| apply_patch | Implemented (extended) | Codex `*** Begin Patch` envelope applied natively and atomically (no Git), plus unified diffs via `git apply`. |
| codex_thread_read | Implemented | Verified against Codex CLI 0.163 on Windows (npm `.cmd` shim). |
| codex_thread_list | Implemented | Verified against Codex CLI 0.163; mapping covered by a fake app-server test. |
| codex_thread_turns_list | Implemented | Verified against Codex CLI 0.163. |
| audit_tail | Implemented | Records tool, argument keys, args hash, duration, error code; rotates at 10 MB. |
| pty_start | Implemented | Real ConPTY via a helper compiled on first use with the in-box .NET Framework `csc.exe`; process tree in a kill-on-close Job Object. |
| pty_read | Implemented | Absolute byte cursors, 8 MiB ring buffer, long-poll `wait_ms`, optional ANSI stripping. |
| pty_write | Implemented | Exact bytes (utf8/base64); input is never logged. |
| pty_resize | Implemented | Waits for the pseudo console's acknowledgement. |
| pty_signal | Implemented | SIGINT/SIGQUIT/SIGBREAK → Ctrl+C; SIGTERM/SIGKILL/SIGHUP → job termination. |
| pty_close | Implemented | Terminates the whole tree, frees the session. |
| pty_list | WDB extension | Lists open sessions. |

## HTTP transport

| Feature | Status |
|---|---|
| Streamable HTTP POST (JSON responses) | Implemented |
| SSE responses for `tools/call` with keepalive + `notifications/progress` | Implemented (keeps long calls alive through Cloudflare's 100 s limit; verified with a 110 s call) |
| GET /mcp server-initiated stream | Not implemented (405, allowed by the spec) |
| OAuth 2.1: RFC 9728/8414 metadata, RFC 7591 DCR, PKCE S256, refresh rotation, RFC 7009 revocation, local PIN consent | Implemented |
| Issuer derived from Host / X-Forwarded-Proto when no public URL is configured | Implemented |

## Release gate

Do not call this a complete MDB mirror until the Chrome tools are ported or explicitly rejected and input schemas are compared mechanically against a captured MDB fixture.
