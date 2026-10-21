import { randomUUID } from "node:crypto"
import {
    mkdirSync,
    readFileSync,
    renameSync,
    rmSync,
    statSync,
    writeFileSync,
} from "node:fs"
import { dirname, join } from "node:path"
import { log } from "./logger.ts"
import { getRefreshLockTarget } from "./paths.ts"

/**
 * Exclusion barrier for extension-launched refreshes: at most one delegated
 * `claude` run per Claude store (a second rotator of the single-use refresh
 * token gets the login revoked).
 *
 * It never expires and is never taken over. Nothing can prove an owner dead
 * across processes: pids are meaningful only inside one PID namespace
 * (sandboxed pi sessions each get their own), liveness by file lock would free
 * the barrier while an orphaned CLI still rotates, and time cannot tell a
 * suspended owner from a dead one. A barrier stranded by a crashed owner is
 * removed by hand (README, "Refresh lock recovery"). A wrong release costs a
 * revoked login, a stranded lock costs one `rm`: fail closed (Inversion).
 */
export interface RefreshLock {
    release(): void
}

/**
 * The lock's only content: "<nonce> <acquisition time>". It makes a published
 * lock never empty (see acquireRefreshLock) and names the instance, so an
 * owner whose lock was removed by hand cannot release a successor's lock.
 */
const OWNER_FILE = "owner"

export function refreshLockPath(): string {
    return `${getRefreshLockTarget()}.lock`
}

/**
 * Acquire the exclusion barrier, or return "held" when someone else has it.
 *
 * The lock is published, never created in place: a claim dir holding the
 * OWNER_FILE file is renamed onto the lock path. Rename is atomic, so the lock
 * exists only complete, and exactly one of several concurrent publishers wins:
 * renaming onto an existing non-empty dir fails. A crash mid-acquisition
 * strands an unpublished claim dir, which excludes nobody.
 *
 * Only an empty lock dir could be replaced. This protocol never publishes
 * one, so an empty dir is a relic of a pre-publish version whose owner is
 * gone (stop old extension processes before upgrading, see AGENTS.md).
 */
export function acquireRefreshLock(): RefreshLock | "held" {
    const path = refreshLockPath()
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 })
    // A sibling of the lock path keeps the rename on one filesystem.
    const nonce = randomUUID()
    const claim = `${getRefreshLockTarget()}.claim-${nonce}`
    mkdirSync(claim, { mode: 0o700 })
    try {
        writeFileSync(
            join(claim, OWNER_FILE),
            `${nonce} ${new Date().toISOString()}`,
            { mode: 0o600 },
        )
        renameSync(claim, path)
    } catch (err) {
        try {
            rmSync(claim, { recursive: true, force: true })
        } catch {
            /* Unpublished garbage blocks no one. */
        }
        // POSIX: a non-empty target refuses the rename. Windows reports other
        // codes for the same refusal, so fall back to looking at the path.
        // The owner may release between the refusal and the look: still held.
        const code = (err as NodeJS.ErrnoException).code
        if (code === "ENOTEMPTY" || code === "EEXIST" || exists(path))
            return "held"
        throw err
    }
    return { release: () => release(path, nonce) }
}

/** Whether a path exists, telling "missing" (ENOENT) from real failure. */
function exists(path: string): boolean {
    try {
        statSync(path)
        return true
    } catch (err) {
        if ((err as NodeJS.ErrnoException).code === "ENOENT") return false
        throw err
    }
}

/**
 * Atomically detach our lock instance, then delete it. Never throws. A lock
 * that is not ours any more (removed by hand, then re-acquired) stays.
 * The check-then-rename gap needs a manual removal and a new acquisition
 * within microseconds; closing it would need a primitive we do not have.
 */
function release(path: string, nonce: string): void {
    const grave = `${path}.removed-${randomUUID()}`
    try {
        const owner = readFileSync(join(path, OWNER_FILE), "utf8")
        if (!owner.startsWith(nonce)) return
        renameSync(path, grave)
        rmSync(grave, { recursive: true, force: true })
    } catch (err) {
        // A failed rename (e.g. a Windows handle inside the dir) strands the
        // barrier; leave a trace, since every waiter then reports "busy".
        if ((err as NodeJS.ErrnoException).code !== "ENOENT")
            log("refresh_lock_release_failed", { error: String(err) })
    }
}
