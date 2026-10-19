# Windows Developer Bridge

[![Windows CI](https://github.com/Icecream0507/windows-developer-bridge/actions/workflows/ci.yml/badge.svg)](https://github.com/Icecream0507/windows-developer-bridge/actions/workflows/ci.yml) [![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)

A Windows-first compatibility port of Mac Developer Bridge (MDB). This project is developed separately from the original macOS checkout.

## Current status

**Early implementation; not yet a complete or production-ready mirror.** The MCP stdio server and an initial set of shell, filesystem, job, patch, and audit tools are implemented. The local macOS host is useful for protocol and filesystem tests, but Windows-only execution and process-tree behavior must be validated on Windows 10/11.

## Roadmap

See [TODO.md](TODO.md) for the prioritized roadmap, security work, parity checklist, and release gates. The detailed [compatibility matrix](docs/compatibility-matrix.md) tracks every original MDB tool.

## Implemented in this milestone

- MCP JSON-RPC stdio framing: initialize, ping, tools/list, and tools/call.
- bridge_status with platform/runtime information.
- shell_exec using PowerShell on Windows, bounded output, timeout, environment overrides, working directory, and stdin.
- shell_start, shell_job_status, shell_job_list, and shell_job_kill with persistent metadata/logs and taskkill /T process-tree termination.
- fs_read, fs_write, fs_list, fs_stat, and fs_manage.
- apply_patch through git apply.
- Codex thread read/list/turn pagination wired to the Codex app-server (Windows app-server integration remains unverified).
- Fail-closed FULL_ACCESS_ENABLED unlock latch, rechecked on tool calls, with a background poll that terminates known background-job process trees after revocation.
- Append-only JSONL audit records and bounded audit_tail.
- Initial Node.js tests for protocol negotiation, tool listing, status, filesystem round-trip/pagination, and fail-closed non-Windows shell behavior.

## Not yet ported

The original MDB advertises 33 tools. This implementation currently advertises 16 of those names; 17 remain unported. See docs/compatibility-matrix.md for the tool-by-tool status. These areas still require design, implementation, and compatibility tests:

- Windows Codex app-server launch, protocol compatibility, and persisted-history integration tests.
- Real interactive terminals using Windows ConPTY, including reliable resize, signal/interrupt semantics, byte-cursor reads, bounded buffers, and session cleanup.
- Chrome background workspace, extension/native messaging, ChatGPT extension status, and browser operations.
- HTTP transport, OAuth, install/startup integration, kill switch, and full permission-revocation lifecycle.
- Full compatibility for original tool schemas, error codes, annotations, audit redaction, timeout races, and process containment.
- Windows-specific integration and adversarial tests.

## Development

- Node.js 20 or newer.
- Windows 10/11 x64 or ARM64 for actual PowerShell and process-tree tests.
- PowerShell 7 (pwsh.exe) is the default. Set WDB_POWERSHELL to an alternate executable path if required.
- Run node --check bridge.mjs.
- Run node --test.

On non-Windows hosts, the MCP protocol and portable filesystem tools can be tested. PowerShell execution and job process control deliberately return a clear platform error rather than silently substituting a different shell.

## Security model

The bridge starts locked. On Windows, first run bridge_status to see the expected unlock path, then explicitly create an empty file named FULL_ACCESS_ENABLED in the reported data directory (normally %LOCALAPPDATA%\\WindowsDeveloperBridge\\FULL_ACCESS_ENABLED). Removing that file locks subsequent tool calls and triggers cleanup of recorded background-job process trees. The bridge remains available for status inspection. This initial implementation does not yet match the original kill switch in every lifecycle detail.

This bridge is intentionally powerful: commands and filesystem operations execute with the logged-in OS user's permissions. It is not a sandbox and does not enforce a filesystem path allowlist or command allowlist. Keep the stdio server attached to a trusted local MCP client; do not expose it directly to a network. The audit log redacts common credential-like values but is not a substitute for secret-safe command construction. Windows ACLs, process-tree containment, and revocation behavior still require review before production use.

See SECURITY.md before enabling the unlock latch. This is an independent Windows-focused port project; it does not bundle the original macOS checkout.
