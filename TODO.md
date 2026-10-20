# Roadmap and TODO

Working checklist for the Windows Developer Bridge (WDB) port of Mac Developer Bridge (MDB). An item is checked only when implementation and tests demonstrate the behaviour. Matching tool names alone does not count as compatibility.

## P0 — Safety and correctness

- [ ] **Compatibility baseline**
  - [ ] Capture the original MDB's tool schemas, descriptions, annotations, defaults, result shapes and error behaviour as a versioned fixture.
  - [ ] Generate a machine-readable schema diff between MDB and WDB.
  - [ ] Document deliberate Windows-specific differences (partially done in `docs/compatibility-matrix.md`).
- [ ] **Full-access latch and revocation**
  - [x] Fail-closed latch re-checked on every call; symlinks rejected.
  - [x] Revocation kills `shell_exec` children, background jobs and ConPTY sessions.
  - [x] ConPTY sessions contained in a kill-on-close Job Object.
  - [ ] Make unlock-file creation/removal resistant to reparse-point and TOCTOU issues.
  - [ ] Test revocation during a Codex app-server call and concurrent tool calls.
  - [ ] Evaluate Job Objects for `shell_exec` and background jobs as well.
  - [ ] Fail closed when data directories or security metadata have unsafe ACLs.
- [ ] **Command execution and timeouts**
  - [x] PowerShell 7 preferred, Windows PowerShell 5.1 fallback (CI covers 7, local runs cover 5.1).
  - [x] UTF-8 stdin/stdout/stderr, exit codes (`exit N`, native commands, terminating errors), output caps (head + tail), missing cwd.
  - [x] Timeout kills the whole process tree.
  - [ ] Timeout race tests (exit exactly as timeout fires).
  - [ ] Environment secret stripping/redaction contract.
- [ ] **Filesystem**
  - [x] Atomic replace with retry on sharing violations / AV locks.
  - [x] Copy/move create parents and refuse silent overwrite; directory links as junctions.
  - [ ] Cross-volume moves, dangling links, long paths, reserved names, case-only renames.
  - [ ] ACL handling beyond the read-only attribute.
- [ ] **Audit logging**
  - [x] Bounded rotation (10 MB).
  - [x] Logs never contain raw arguments, terminal input or file contents.
  - [ ] Behaviour on disk-full / permission failures; redaction tests with realistic secrets.
- [x] **Windows CI** runs syntax checks and the full suite (PowerShell, jobs, ConPTY, HTTP, OAuth) on `windows-latest`.

## P1 — Feature parity and operations

- [x] **PowerShell tools**: `shell_exec`, `shell_start`, `shell_job_status` (wait + log paging), `shell_job_list`, `shell_job_kill`; jobs survive bridge restarts with persisted PID/exit code; 14-day retention.
- [x] **Filesystem tools**: `fs_read`, `fs_write`, `fs_list`, `fs_stat`, `fs_manage`.
- [x] **apply_patch**: Codex `*** Begin Patch` format natively, unified diffs via git.
- [x] **Codex history**: verified against Codex CLI 0.163 on Windows (npm `.cmd` shim).
  - [ ] Fixture tests for pagination cursors and large histories.
- [x] **Interactive terminal / ConPTY**: `pty_start`, `pty_read`, `pty_write`, `pty_resize`, `pty_signal`, `pty_close` (+ `pty_list`) on a real ConPTY helper with byte cursors, ring buffer, resize acknowledgement, Ctrl+C, tree cleanup.
- [ ] **Chrome extension and browser workspace**: port the extension, native-messaging host and the `chrome_*` / `chatgpt_*` tools.
- [x] **HTTP transport and OAuth**
  - [x] Streamable HTTP POST with JSON or SSE responses; SSE keepalive/progress for long calls (verified through Cloudflare with a 110 s call).
  - [x] OAuth 2.1 metadata, dynamic registration, PKCE, local PIN consent, refresh rotation, revocation.
  - [x] Issuer derived from the request host when no public URL is configured.
  - [ ] GET /mcp server-initiated stream and session ids.
- [x] **Install, startup, uninstall**: `install.ps1` one-liner (Node via winget, app, cloudflared, `wdb` on PATH, skill), `wdb start/stop/restart/status/update/uninstall`, background processes via WMI so they outlive the terminal.
  - [ ] Optional start at login.
- [x] **Kill switch and status**: `wdb lock` stops jobs and terminals; `bridge_status` reports dependency availability.

## P2 — Engineering quality

- [ ] Split `bridge.mjs` further (patch and ConPTY already live in `lib/`).
- [x] Strict input validation against the advertised schemas with shared error codes (`INVALID_ARGUMENT`, `INVALID_CWD`, `FULL_ACCESS_LOCKED`, `PATCH_FAILED`, `JOB_NOT_FOUND`, `PTY_*`, …).
- [x] Concurrent request handling (responses correlated by id).
- [ ] Fuzz/property tests for JSON-RPC framing, paths, patches, cursors.
- [ ] Lint/format configuration.

## P3 — Documentation and community

- [x] Chinese README with one-click install, client setup, commands, troubleshooting.
- [x] Agent skill (`skills/windows-developer-bridge`) and packaging script.
- [x] Security notes, compatibility matrix.
- [ ] `CONTRIBUTING.md`, `CODE_OF_CONDUCT.md`, issue/PR templates.
- [ ] Release notes and semantic versioning policy.
