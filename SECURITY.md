# Security notes

Windows Developer Bridge can run arbitrary PowerShell commands and modify files with the logged-in Windows account's permissions. It is not a sandbox.

## Unlock and revocation

- The bridge starts locked unless FULL_ACCESS_ENABLED exists in its data directory.
- bridge_status remains available while locked so the operator can inspect the expected path and lock state.
- Every other tool call rechecks the latch. A missing latch rejects the call.
- A background poll checks the latch and tries to terminate background jobs recorded in the bridge job directory using taskkill /T /F.
- This is an initial implementation, not a complete substitute for Windows Job Objects or the original MDB kill switch. Process-tree containment and races still require Windows integration tests.

## Deployment

- Keep the stdio process attached to a trusted local MCP client.
- Do not expose the stdio process directly to a network.
- Use a least-privilege Windows account.
- Keep the unlock file absent except while actively using the bridge.
- Audit records contain tool names, argument keys, and a hash of the arguments; they deliberately do not persist raw tool arguments or file contents.
- Do not treat audit redaction as a reason to put credentials in commands or files.

## Current verification boundary

The portable protocol/filesystem tests run on Node.js. PowerShell, Windows process-tree cleanup, Windows atomic replacement, Windows symlinks, and Codex app-server launch must be tested on Windows before production use.
