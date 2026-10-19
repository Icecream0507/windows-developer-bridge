# Roadmap and TODO

This checklist is the working source of truth for the Windows Developer Bridge (WDB) port of Mac Developer Bridge (MDB). Items are intentionally marked incomplete until implementation and tests demonstrate the behavior. Matching tool names alone does not count as compatibility.

## P0 — Safety and correctness before wider use

- [ ] **Establish a compatibility baseline**
  - [ ] Capture the original MDB's 33 tool schemas, descriptions, annotations, defaults, required fields, result shapes, and error behavior as a versioned fixture.
  - [ ] Generate a machine-readable schema diff between MDB and WDB.
  - [ ] Define which behaviors must be identical and document deliberate Windows-specific differences.
- [ ] **Harden the full-access latch and revocation lifecycle**
  - [ ] Match original kill-switch semantics and lifecycle timing.
  - [ ] Make unlock-file creation/removal atomic and resistant to symlink/reparse-point and TOCTOU issues.
  - [ ] Test revocation during a foreground command, Codex app-server call, background job, and concurrent tool call.
  - [ ] Ensure revocation terminates every owned process tree, not only the direct child PID.
  - [ ] Evaluate Windows Job Objects as the reliable containment mechanism; do not rely solely on \`taskkill /T\`.
  - [ ] Verify startup fails closed when data directories or security metadata have unsafe ACLs.
  - [ ] Document that full-access mode executes with the logged-in user's privileges and is not a sandbox.
- [ ] **Correct command execution and timeout behavior**
  - [ ] Test PowerShell 7 and Windows PowerShell compatibility policy.
  - [ ] Test Unicode, stdin, large stdout/stderr, output caps, exit codes, signal/termination reporting, and missing executables.
  - [ ] Test timeout races, including exit exactly as timeout fires.
  - [ ] Ensure timeout and cancellation leave no descendant processes.
  - [ ] Verify environment overrides and secret stripping/redaction behavior against the original contract.
- [ ] **Make filesystem behavior safe and predictable**
  - [ ] Define and test atomic replacement behavior on Windows, including existing destination, sharing violations, and antivirus/file-lock interference.
  - [ ] Test cross-volume moves, directory moves, symlinks, junctions, reparse points, and dangling links.
  - [ ] Prevent traversal outside intended roots where the original contract requires it; document unrestricted operations where applicable.
  - [ ] Test path normalization, drive-relative paths, UNC paths, long paths, reserved names, case-insensitive collisions, and Unicode paths.
  - [ ] Verify file permissions/ACL handling and preserve or explicitly document metadata semantics.
- [ ] **Make audit logging robust**
  - [ ] Add bounded rotation/retention and behavior for disk-full/permission failures.
  - [ ] Test secret redaction with realistic token, password, URL, environment, and command formats.
  - [ ] Confirm logs never contain raw terminal input or file contents unless explicitly required.
  - [ ] Decide whether audit write failures should fail the operation or be reported as degraded security state.
- [ ] **Windows integration CI**
  - [ ] Run CI on supported Windows 10/11 runners and Node.js LTS versions.
  - [ ] Add tests for process-tree cleanup, ACLs, symlinks/junctions, cross-volume operations, timeout races, and revocation.
  - [ ] Keep tests deterministic; do not mark an untested Windows feature as passed merely because its test was skipped on macOS.

## P1 — Reach feature parity with original MDB

- [ ] **PowerShell command tools**
  - [x] Initial \`shell_exec\` implementation.
  - [x] Initial persistent background-job API.
  - [ ] Match every original argument, default, output field, error code, and timeout contract.
  - [ ] Add job log cursor/pagination, output bounds, stale-job recovery, and cleanup policy as required by the original contract.
- [ ] **Filesystem tools**
  - [x] Initial \`fs_read\`, \`fs_write\`, \`fs_list\`, \`fs_stat\`, and \`fs_manage\`.
  - [ ] Complete schema-level and behavioral parity for every operation.
  - [ ] Test recursive listing limits, symlink traversal, atomic writes, overwrite rules, and error mapping.
- [ ] **Codex history**
  - [x] Initial app-server adapter for \`codex_thread_read\`, \`codex_thread_list\`, and \`codex_thread_turns_list\`.
  - [ ] Validate actual Windows Codex CLI discovery and process launch.
  - [ ] Test real thread history, archived threads, filters, ordering, pagination cursors, large histories, and missing/unsupported Codex versions.
  - [ ] Handle app-server stderr and startup failures without leaking secrets or hanging.
- [ ] **Interactive terminal / ConPTY**
  - [ ] Implement a real Windows ConPTY backend; do not emulate a PTY with ordinary pipes.
  - [ ] Implement \`pty_start\`, \`pty_read\`, \`pty_write\`, \`pty_resize\`, \`pty_signal\`, and \`pty_close\`.
  - [ ] Preserve byte-cursor semantics, bounded ring buffers, resize behavior, encoding, and read-after-close behavior.
  - [ ] Test Ctrl-C, Ctrl-Z equivalents where meaningful, child process trees, shell startup, interactive programs, and cleanup after bridge crash.
- [ ] **Chrome extension and browser workspace**
  - [ ] Port the Chrome extension/service worker and Windows native-messaging host.
  - [ ] Implement extension installation/setup, host registration, profile selection, status reporting, and uninstall/revocation.
  - [ ] Port \`chrome_workspace_status\`, \`chatgpt_extension_status\`, \`chatgpt_conversation_start\`, \`chrome_workspace_setup\`, \`chrome_tabs\`, \`chrome_open\`, \`chrome_navigate\`, \`chrome_snapshot\`, \`chrome_click\`, \`chrome_fill\`, and \`chrome_close\`.
  - [ ] Match tab-pool isolation, navigation timeouts, DOM snapshots, background fill/click semantics, and error reporting.
  - [ ] Test Chrome stable/beta channels, multiple profiles, extension reloads, browser restarts, and disconnected extension states.
- [ ] **HTTP transport and OAuth**
  - [ ] Port the HTTP MCP transport and transport-level compatibility tests.
  - [ ] Port OAuth/session handling, callback flow, token storage, expiry, logout, and revocation.
  - [ ] Enforce loopback/network binding defaults and verify origin/host protections.
  - [ ] Test authentication failures, replay, expired tokens, concurrent sessions, and shutdown.
- [ ] **Install, startup, and uninstall**
  - [ ] Provide a safe Windows installer and uninstall flow (PowerShell/MSI/winget decision documented).
  - [ ] Add startup integration only with explicit opt-in.
  - [ ] Ensure uninstall removes only WDB-owned artifacts and preserves user data unless asked.
  - [ ] Test upgrades, rollback, stale processes, missing prerequisites, and paths with spaces/non-ASCII characters.
- [ ] **Kill switch and operational status**
  - [ ] Match the original kill-switch behavior and make its state observable.
  - [ ] Ensure disable/revoke stops listeners, jobs, terminal sessions, and browser sessions.
  - [ ] Report degraded dependencies and cleanup failures rather than claiming successful shutdown.

## P2 — Engineering quality and maintainability

- [ ] Split \`bridge.mjs\` into focused modules (MCP protocol, process execution, filesystem, audit, Codex, ConPTY, browser, transport).
- [ ] Add strict input validation and shared error types/codes across all tools.
- [ ] Add request correlation, concurrency controls, and tests for parallel tool calls.
- [ ] Add fuzz/property tests for JSON-RPC framing, path handling, patch inputs, pagination cursors, and malformed arguments.
- [ ] Add test fixtures for original MDB outputs and regression cases.
- [ ] Add lint/format configuration and static analysis.
- [ ] Add dependency/license inventory and automated dependency/security updates.
- [ ] Add structured diagnostics that never include secrets or raw sensitive payloads.
- [ ] Add performance tests for large file reads, large directories, long-running jobs, and large Codex threads.

## P3 — Documentation and community readiness

- [x] Initial README with honest feature/limitation statements.
- [x] Initial security notes.
- [x] Initial tool-by-tool compatibility matrix.
- [ ] Add \`CONTRIBUTING.md\` with development setup, test requirements, coding conventions, and pull-request checklist.
- [ ] Add \`CODE_OF_CONDUCT.md\`.
- [ ] Add issue templates for bug reports, feature requests, and compatibility gaps.
- [ ] Add pull-request template with security and regression checklist.
- [ ] Add support policy and tested Windows/Node.js/PowerShell/Chrome/Codex version matrix.
- [ ] Add architecture document and threat model.
- [ ] Document exact install, configure, unlock, revoke, upgrade, backup, and uninstall procedures.
- [ ] Add troubleshooting guide and known limitations.
- [ ] Ensure README badges reflect real CI results only.
- [ ] Publish a first alpha only after Windows CI passes; clearly label unsupported features.
- [ ] Create release notes and semantic versioning policy.
- [ ] Review public repository contents for credentials, private paths, local logs, user data, and accidental copied artifacts.

## Release gates

### Alpha
- [ ] Windows CI passes for every feature claimed as implemented.
- [ ] All P0 security and process-cleanup tests pass.
- [ ] README and compatibility matrix clearly distinguish tested, untested, and unsupported behavior.
- [ ] No secrets or private local data in repository history.

### Feature-complete compatibility release
- [ ] All 33 original tool names are implemented or explicitly justified as intentionally unsupported.
- [ ] Schema diff has no unexplained incompatibilities.
- [ ] Windows-specific ConPTY, browser, HTTP/OAuth, install/uninstall, and revocation suites pass.
- [ ] Security review covers process containment, ACLs, transport exposure, token storage, and audit data.

### Stable release
- [ ] Supported Windows and dependency versions are documented and continuously tested.
- [ ] Upgrade/uninstall and rollback paths are tested.
- [ ] Security reporting process and maintenance policy are published.
- [ ] No P0/P1 defects remain open.
