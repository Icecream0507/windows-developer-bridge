# MDB compatibility matrix

This matrix compares the original checkout's advertised MCP tool names with the Windows port. “Implemented (initial)” means a first implementation exists but Windows behavior is not yet proven. It is not a claim of behavioral parity.

| Original tool | Windows port status | Notes |
|---|---|---|
| bridge_status | Implemented (initial) | Windows-specific status fields still need review. |
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
| shell_exec | Implemented (initial) | PowerShell path, stdin, timeout, output cap; Windows test pending. |
| shell_start | Implemented (initial) | Persistent metadata/logs; lifecycle and process-tree tests pending. |
| shell_job_status | Implemented (initial) | Needs Windows process-state validation. |
| shell_job_list | Implemented (initial) | Reads persistent job metadata. |
| shell_job_kill | Implemented (initial) | Uses taskkill /T /F; containment must be tested on Windows. |
| fs_read | Implemented (initial) | Offset pagination and base64. |
| fs_write | Implemented (initial) | Atomic replacement behavior must be tested on Windows. |
| fs_list | Implemented (initial) | Bounded recursion; skips traversal through symlinks. |
| fs_stat | Implemented (initial) | Cross-platform metadata subset, not schema-identical yet. |
| fs_manage | Implemented (initial) | Cross-volume move and Windows symlink behavior need testing. |
| apply_patch | Implemented (initial) | Uses installed Git; Windows Git behavior not tested. |
| codex_thread_read | Implemented (initial) | Calls Codex app-server; Windows executable launch/history compatibility pending. |
| codex_thread_list | Implemented (initial) | Calls Codex app-server; pagination contract needs fixture tests. |
| codex_thread_turns_list | Implemented (initial) | Calls Codex app-server; pagination contract needs fixture tests. |
| audit_tail | Implemented (initial) | Bounded JSONL tail; audit records store argument keys/hash, not raw payloads. |
| pty_start | Not ported | Requires a real Windows ConPTY backend. |
| pty_read | Not ported | Must preserve absolute byte cursors and bounded ring-buffer behavior. |
| pty_write | Not ported | Must preserve exact byte delivery and avoid logging terminal input. |
| pty_resize | Not ported | Must confirm actual terminal resize, not echo requested geometry. |
| pty_signal | Not ported | Needs verified process-tree/job-object semantics. |
| pty_close | Not ported | Needs verified cleanup of the full process tree. |

## Release gate

Do not call this a complete MDB mirror until every original tool has a deliberate status, input-schema compatibility is compared mechanically, and the Windows CI suite validates timeouts, output truncation, process-tree cleanup, filesystem replacement/cross-volume behavior, audit redaction, and revocation/kill-switch behavior.
