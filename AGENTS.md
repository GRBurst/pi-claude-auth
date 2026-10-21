# pi-claude-auth — map for changing the code

pi extension that reads Claude Code OAuth credentials. Requires pi 0.85+.

## Invariants

- **Claude Code is the only credential writer.** Delegate refresh to `claude`;
  pi receives access/expiry and an empty refresh token, never the real one.
- **Every consuming pi process must load this extension**, including children.
  Otherwise pi's built-in refresh attempts the empty token and fails with 400.
- **Caller cancellation ends waiting, not an owned refresh.** Before ownership,
  an aborted waiter must not launch a CLI. After launch, the owner retains the
  refresh lock through command completion and authoritative re-read. No
  background `auth.json` writes or canceled-caller account switching.
- **Refresh coordination is per Claude store, not per pi profile.** Lock and
  futile-attempt record live in `~/.claude/pi-claude-auth/`. The lock is
  never taken over and never expires: no cross-process proof of owner death
  exists (pi sessions may run in separate PID namespaces, so recorded PIDs are
  meaningless to other processes). A crashed owner strands it; recovery is
  the manual step in `README.md`. Do not add PID, time or file-lock based
  takeover. The lock is published by atomic rename of a complete dir, so it
  is never empty. Unix completion covers direct-child close plus its original
  process-group probe, within the owner's own PID namespace; Windows covers the
  direct child only. Escaped/detached descendants and independently launched
  Claude processes are outside this guarantee.
- **pi's `auth.json` keeps pi's locking protocol.** Only a missing file may
  initialize an empty object. Reject invalid/non-object contents without changing
  them; preserve unrelated providers and replace valid contents atomically.
- **pi owns model catalogs and tool-schema conversion.** This extension owns
  credential bridging and Claude Code billing headers.

## Source map

| File | Contains |
|------|----------|
| `src/index.ts` | Provider registration, OAuth hooks, session notification |
| `src/credentials.ts` | Account selection and credential-store effects |
| `src/credential-store.ts` | Re-read, refresh ownership, retry suppression, caller waits; injected effects |
| `src/keychain.ts` | Claude credentials from macOS Keychain or file |
| `src/claude-cli.ts` | Delegated CLI execution and its independent timeout |
| `src/dir-lock.ts` | pi-compatible directory lock for `auth.json` |
| `src/refresh-lock.ts` | Non-expiring exclusion for extension-launched refreshes; atomic publish, owner-checked release |
| `src/futile-refresh.ts` | Shared unchanged-attempt record; not proof of revocation |
| `src/auth-json.ts` | Seed/remove pi credentials, parsing boundary, atomic writes |
| `src/paths.ts` | Credential, pi-profile, and shared-coordination paths |
| `src/signing.ts`, `src/transforms.ts` | Claude Code identity and billing header |
| `src/logger.ts` | Opt-in redacted diagnostics (`PI_CLAUDE_AUTH_DEBUG`) |

## Verification and release

`main` is the release channel (`@main`, no version tags). Keep it green.
Stop old extension processes before upgrading: previous lock namespaces do not
coordinate with the current one. See `README.md` for recovery and limitations.

Analyze callers and affected flows before edits; review the diff before commits.
`just all` (lint, build, test) must pass before every commit. `just smoke` must
pass before pushing to `main`. Unit tests use Node; pi embeds Bun with a proxied
`node:fs`. Mutating that module object (as `proper-lockfile` does) crashes pi;
unit tests alone do not cover that runtime.

Unit tests use temporary `HOME` and `PI_CODING_AGENT_DIR` and fake CLIs.
Keep all unit-test credentials and CLI executions isolated from real accounts.

`scripts/smoke-pi-runtime.ts` first runs fully isolated with fake expired
credentials and a stub CLI. Its second run reads real credentials and seeds real
pi `auth.json` and makes a model request. It skips tokens within five minutes of
expiry and guards the CLI with a failing stub so it cannot redeem a real refresh
token. No live model-probing script is maintained.
