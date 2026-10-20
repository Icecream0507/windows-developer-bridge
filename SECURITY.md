# Security notes

Windows Developer Bridge can run arbitrary PowerShell commands, drive interactive terminals and modify files with the logged-in Windows account's permissions. It is not a sandbox.

## Access control

- **Transport**: the HTTP adapter binds to `127.0.0.1`. Remote access goes through a Cloudflare tunnel or, in `ssh` mode, an SSH reverse tunnel to your own server (bound to the server's loopback) behind an nginx TLS proxy. Either way the URL is public.
- **Authentication**: every `/mcp` request needs a bearer credential — either an OAuth 2.1 access token or the optional static token (`WDB_HTTP_TOKEN`, ≥32 characters, compared in constant time).
- **Consent**: OAuth clients register dynamically, but an authorization code is only issued after someone enters the 9-digit consent PIN on the consent page. The PIN is generated locally (`<dataDir>\oauth\consent.pin`) and never sent to clients. Wrong PINs are limited per request (5) and globally (30 per 10 minutes).
- **Tokens**: access tokens last 12 h, refresh tokens 30 days and rotate on use; only SHA-256 hashes are stored. `POST /revoke` (RFC 7009) revokes a token pair, `wdb reset-auth` revokes everything and rotates the PIN and static token.
- Redirect URIs must be `https` or loopback (`http://127.0.0.1` / `localhost`).

## Full-access latch

- All tools except `bridge_status` require `FULL_ACCESS_ENABLED` (a regular file, not a symlink) in the data directory. `wdb unlock` / `wdb lock` create and remove it; the one-click installer creates it unless `WDB_LOCKED=1`.
- Every call re-checks the latch. When it is missing, and on a 3-second background poll, the bridge kills running `shell_exec` processes, background jobs (`taskkill /T /F`) and all ConPTY sessions.
- ConPTY sessions run inside a Job Object with `KILL_ON_JOB_CLOSE`, so their whole process tree dies if the helper or bridge dies. Background jobs deliberately outlive the bridge and are tracked by PID.

## Audit

`audit.jsonl` records tool name, argument keys, a 16-hex argument hash, duration and error code — never raw arguments, command text, terminal input or file contents. It rotates at 10 MB (`audit.jsonl.1`).

## Recommendations

- Use a least-privilege Windows account; do not run WDB elevated.
- Keep the PIN and static token private; never put them in URLs or screenshots.
- `wdb stop` (or at least `wdb lock`) when not actively using it.
- A Quick Tunnel URL is unguessable but public; a named tunnel with Cloudflare Access adds another layer if you need permanent exposure.
- In `ssh` mode TLS terminates on your server: anyone with root there can read the traffic, including bearer tokens, and can reach the bridge through the forwarded loopback port. Only use a server whose administrators you trust as much as this PC.

## Reporting

Please report vulnerabilities privately via GitHub security advisories on this repository rather than public issues.
