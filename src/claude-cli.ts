import { spawn, type ChildProcess } from "node:child_process"
import { tmpdir } from "node:os"

/**
 * Upper bound for one delegated refresh. A cold `claude` start plus a Haiku
 * round trip is usually well under 20s; beyond a minute the CLI is stuck and
 * killing it is better than blocking the caller further.
 */
export const CLAUDE_TIMEOUT_MS = 60_000

/**
 * The CLI could not be started at all (not installed, not on PATH, not
 * executable). Distinct from a CLI that ran and failed, because it says nothing
 * about the state of the login.
 */
export class ClaudeCliUnavailable extends Error {}

/** The refresh was stopped before it could finish. Transient, retryable. */
export class ClaudeRefreshAborted extends Error {}

/** No confirmed completion: keep the refresh barrier for manual recovery. */
export class ClaudeTerminationUnconfirmed extends Error {}

/**
 * Auth sources that outrank the Claude Code login inside the CLI. With one of
 * these set, `claude` authenticates the refresh request with it and never
 * touches the OAuth token — the run succeeds and refreshes nothing.
 */
const OVERRIDING_AUTH_VARS = [
    "ANTHROPIC_API_KEY",
    "ANTHROPIC_AUTH_TOKEN",
] as const

/**
 * Environment for the delegated refresh.
 *
 * The run exists solely to make the CLI exercise its OAuth login, so any auth
 * source that would take precedence over that login is removed. Inheriting one
 * turns the refresh into a silent no-op: the CLI answers the prompt via the API
 * key, the credentials stay expired, and the caller records a futile refresh
 * and reports the login as dead.
 *
 * TERM=dumb keeps the CLI from emitting terminal control sequences.
 *
 * Pure, so the policy is testable without spawning anything.
 */
export function buildRefreshEnv(
    base: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv {
    const env: NodeJS.ProcessEnv = { ...base, TERM: "dumb" }
    for (const name of OVERRIDING_AUTH_VARS) delete env[name]
    return env
}

/**
 * Make the Claude CLI refresh its own OAuth credentials.
 *
 * Claude Code is the only writer of its credentials: OAuth refresh tokens are
 * single-use, so a second rotator (pi) racing Claude Code gets the session
 * revoked server-side and logs the user out. There is no documented "refresh
 * only" command, so we trigger the CLI's own refresh path with the cheapest
 * request available (Haiku, minimal effort, a prompt answerable in one word)
 * and then re-read what it wrote.
 *
 * The owner's signal can stop the run; request cancellation never reaches it.
 * The refresh barrier stays held until completion is confirmed.
 *
 * `onSpawn` receives the CLI pid (its process group id on Unix) so the refresh
 * lock can record it. If recording fails, the CLI is stopped: an unrecorded CLI
 * could outlive its owner and let a waiter take over the lock while it runs.
 *
 * Rejects when the CLI cannot be started, is aborted, times out, or exits
 * non-zero.
 */
export function refreshViaClaudeCli(
    signal: AbortSignal,
    onSpawn: (pid: number) => void,
): Promise<void> {
    if (signal.aborted)
        return Promise.reject(new ClaudeRefreshAborted("refresh aborted"))
    // Argument array (no shell) keeps the attack surface minimal.
    // cwd=tmpdir avoids picking up the project's CLAUDE.md/settings.
    //
    // The prompt states the whole expected answer, and `--effort low`
    // keeps reasoning minimal: the run exists only to make the CLI perform
    // an authenticated request. A contentless prompt would still reach the
    // user's global CLAUDE.md and produce a chatty reply, spending output
    // tokens on text nobody reads. The `haiku` alias outlives any concrete
    // model id, so a retired model cannot break the refresh path.
    const child = spawn(
        "claude",
        ["-p", "only say OK", "--model", "haiku", "--effort", "low"],
        {
            cwd: tmpdir(),
            env: buildRefreshEnv(),
            stdio: "ignore",
            // Ordinary wrappers/children stay in this group. The completion
            // contract below does not cover wrappers that escape the group.
            detached: process.platform !== "win32",
        },
    )

    const stop = new AbortController()
    const onAbort = () => stop.abort(signal.reason)
    signal.addEventListener("abort", onAbort, { once: true })
    if (child.pid) {
        try {
            onSpawn(child.pid)
        } catch {
            stop.abort()
        }
    }
    return waitForClaudeCompletion(child, stop.signal).finally(() =>
        signal.removeEventListener("abort", onAbort),
    )
}

/** Completion means the direct child closed and its ordinary process group stopped.
 * Wrappers that escape that group and standalone Claude processes are outside
 * this extension's exclusion contract. Uncertainty preserves the barrier.
 */
export function waitForClaudeCompletion(
    child: ChildProcess,
    signal: AbortSignal,
    timeoutMs = CLAUDE_TIMEOUT_MS,
): Promise<void> {
    return new Promise((resolve, reject) => {
        let stopped: "aborted" | "timeout" | null = null
        let settled = false
        let stopTimer: ReturnType<typeof setTimeout> | undefined
        const settle = (err: Error | null) => {
            if (settled) return
            settled = true
            clearTimeout(timer)
            clearTimeout(stopTimer)
            signal.removeEventListener("abort", onAbort)
            if (err) reject(err)
            else resolve()
        }
        const stop = (reason: "aborted" | "timeout") => {
            if (stopped || settled) return
            stopped = reason
            // A kill request is not completion. Wait for close, but fail closed
            // if the runtime never confirms it, rather than release the lock.
            kill(child)
            stopTimer = setTimeout(
                () =>
                    settle(
                        new ClaudeTerminationUnconfirmed(
                            "Claude refresh stop could not be confirmed. Stop all extension-launched Claude processes before manually removing the refresh lock.",
                        ),
                    ),
                5_000,
            )
        }
        const timer = setTimeout(() => stop("timeout"), timeoutMs)
        const onAbort = () => stop("aborted")
        signal.addEventListener("abort", onAbort, { once: true })
        if (signal.aborted) onAbort()
        child.on("error", (err) => {
            // Spawn failure has no owner process. Other errors do not establish
            // termination and must retain the exclusion barrier.
            if (!child.pid) settle(new ClaudeCliUnavailable(err.message))
            else settle(new ClaudeTerminationUnconfirmed(err.message))
        })
        child.on("close", (code, killedBy) => {
            if (!groupStopped(child)) {
                settle(
                    new ClaudeTerminationUnconfirmed(
                        "Claude refresh process group may still be running; manual recovery required.",
                    ),
                )
            } else if (stopped) {
                settle(
                    new ClaudeRefreshAborted(
                        `Claude refresh ${stopped}; credential rotation may be incomplete. Retry after checking Claude Code login.`,
                    ),
                )
            } else if (code === 0) settle(null)
            else settle(new Error(`claude exited with ${killedBy ?? code}`))
        })
    })
}

function groupStopped(child: ChildProcess): boolean {
    if (!child.pid || process.platform === "win32") return true
    try {
        process.kill(-child.pid, 0)
        return false
    } catch (err) {
        return (err as NodeJS.ErrnoException).code === "ESRCH"
    }
}

function kill(child: ChildProcess): void {
    try {
        if (child.pid && process.platform !== "win32")
            process.kill(-child.pid, "SIGKILL")
        else child.kill("SIGKILL")
    } catch {
        // The close event and group probe, not this request, confirm stopping.
    }
}
