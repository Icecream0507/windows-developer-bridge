# WDB tool reference

All tools except `bridge_status` require full access (`wdb unlock`). Results are JSON (also in `structuredContent`); failures set `isError` with `{ error, code }`. Unknown arguments are rejected with `INVALID_ARGUMENT`; optional arguments sent as `null` are treated as omitted. Paths may be absolute Windows paths or start with `~`.

## Status and audit

| Tool | Arguments | Notes |
|---|---|---|
| `bridge_status` | – | Host, user, `shell` (resolved PowerShell), `git`, `codexPath`, `pty.available`, `fullAccessUnlocked`, `unlockFile`, job counts. |
| `audit_tail` | `max_bytes` | JSONL audit tail: tool name, argument keys, args hash, duration, error code. |

## PowerShell

| Tool | Arguments | Notes |
|---|---|---|
| `shell_exec` | `command`*, `cwd`, `env` (null removes), `stdin`, `timeout_ms` (default 600000, max 1800000, 0 = none), `max_output_bytes` (default 1 MiB per stream) | Returns `exitCode`, `stdout`, `stderr`, `timedOut`, `durationMs`, `outputTruncated`, `stdoutBytes`. Missing `cwd` → `INVALID_CWD`. Timeout kills the whole process tree. |
| `shell_start` | `command`*, `cwd`, `env`, `label` | Detached job with log files under the data dir; survives bridge restarts; exit code recorded. |
| `shell_job_status` | `job_id`*, `wait_ms` (≤120000), `max_log_bytes`, `stdout_offset`, `stderr_offset` | `state`: running / exited / terminated / revoked. Without offsets returns log tails; with offsets returns the next page and `stdoutNextOffset`/`stderrNextOffset`. |
| `shell_job_list` | `include_finished`, `limit` | Newest first. Finished jobs are pruned after 14 days. |
| `shell_job_kill` | `job_id`*, `signal` | Forced tree kill (`taskkill /T /F`). |

## Files

| Tool | Arguments | Notes |
|---|---|---|
| `fs_read` | `path`*, `offset`, `max_bytes` (default 1 MB), `encoding` utf8/base64 | `nextOffset`/`truncated` for paging; UTF-8 pages never split characters. |
| `fs_write` | `path`*, `content`*, `encoding`, `append`, `atomic` (default true), `create_parents` (default true), `mode` | Atomic temp-file + rename with retries for AV/indexer locks. On Windows `mode` only toggles read-only. |
| `fs_list` | `path`*, `recursive`, `max_depth` (10), `max_entries` (5000), `include_hidden` (true) | Links/junctions are listed, not followed. |
| `fs_stat` | `path`* | `exists:false` for missing paths. |
| `fs_manage` | `operation`* mkdir/remove/move/copy/chmod/symlink, `path`*, `destination`, `recursive`, `force`, `mode` | move/copy create parent dirs and refuse to overwrite unless `force`. Directory symlinks become junctions (no admin needed). |
| `apply_patch` | `patch`*, `cwd`, `check_only`, `reverse`, `three_way` | `*** Begin Patch` envelope (native, atomic, CRLF/BOM preserved, fuzzy whitespace matching) or unified diff via `git apply`. Failures → `PATCH_FAILED` with details, nothing written. |

## Terminals (ConPTY)

| Tool | Arguments | Notes |
|---|---|---|
| `pty_start` | `command` (PowerShell source) or `argv` ([exe, ...args]) or neither (interactive PowerShell), `cwd`, `env`, `cols` (120), `rows` (30), `label` | Real Windows pseudo console; whole process tree in a kill-on-close job. Max 16 sessions. |
| `pty_read` | `session_id`*, `cursor`, `max_bytes` (64 KiB), `wait_ms` (≤60000), `encoding`, `strip_ansi` | Absolute byte cursors; omit `cursor` to continue. Returns `data`, `next_cursor`, `exited`, `exit_code`, `dropped_bytes` (8 MiB ring buffer). |
| `pty_write` | `session_id`*, `data`*, `encoding` | Raw input: `\r` Enter, `\u0003` Ctrl+C, `\u001b[A` Up. |
| `pty_resize` | `session_id`*, `cols`*, `rows`* | Confirmed by the pseudo console. |
| `pty_signal` | `session_id`*, `signal` (default SIGINT) | SIGINT/SIGQUIT/SIGBREAK → Ctrl+C; SIGTERM/SIGKILL/SIGHUP → kill tree. |
| `pty_close` | `session_id`* | Kills the tree and frees the session. |
| `pty_list` | – | Open sessions. |

Typical loop: `pty_start` → `pty_read {wait_ms: 3000, strip_ansi: true}` until the prompt appears → `pty_write "answer\r"` → `pty_read …` → `pty_close`.

## Codex CLI history

| Tool | Arguments |
|---|---|
| `codex_thread_list` | `limit`, `cursor`, `search_term`, `cwd`, `archived`, `is_pinned`, `model_providers`, `source_kinds`, `sort_key`, `sort_direction`, `use_state_db_only`, `timeout_ms` |
| `codex_thread_read` | `thread_id`*, `include_turns`, `timeout_ms` |
| `codex_thread_turns_list` | `thread_id`*, `limit`, `cursor`, `sort_direction`, `items_view` (notLoaded/summary/full), `timeout_ms` |

Requires the Codex CLI (`npm i -g @openai/codex`) on PATH or `CODEX_BIN`.
