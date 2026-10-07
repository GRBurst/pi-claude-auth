import { randomUUID } from "node:crypto"
import {
    mkdirSync,
    readFileSync,
    renameSync,
    rmdirSync,
    rmSync,
    writeFileSync,
} from "node:fs"
import { dirname, join } from "node:path"
import { log } from "./logger.ts"
import { getRefreshLockTarget } from "./paths.ts"

/**
 * Exclusion barrier for extension-launched refreshes. It never expires: a
 * paused owner is not a dead one. It is taken over only on proof that its
 * owner and its delegated CLI are gone (see takeOverIfStale).
 */
export interface RefreshLock {
    /**
     * Record the delegated CLI so waiters can prove it stopped: "pending"
     * before spawning, then its pid. Throws on failure.
     */
    recordCli(cli: CliRecord): void
    release(): void
}

/**
 * Why a lock could not be acquired:
 * - "held": a live owner or its CLI may still be refreshing; waiting can help.
 * - "unprovable": nothing proves who holds it (record missing or corrupt, a
 *   liveness probe failed, or another waiter's takeover is in progress);
 *   waiting can only help if this is a transient state.
 */
export type RefreshLockBusy = "held" | "unprovable"

/**
 * The delegated CLI: "pending" from just before spawn until its pid is
 * recorded. An owner dying in that window leaves a CLI nobody can probe.
 */
export type CliRecord = number | "pending"

/** What a lock dir says about its holder. `nonce` names this lock instance. */
export interface OwnerRecord {
    pid: number
    nonce: string
    cli?: CliRecord
}

const RECORD = "owner"

export function refreshLockPath(): string {
    return `${getRefreshLockTarget()}.lock`
}

export function acquireRefreshLock(): RefreshLock | RefreshLockBusy {
    const path = refreshLockPath()
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 })
    // One takeover per call at most; a lock re-taken in between is just held.
    for (let attempt = 0; attempt < 2; attempt++) {
        try {
            mkdirSync(path, { mode: 0o700 })
        } catch (err) {
            if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err
            const verdict = takeOverIfStale(path)
            if (verdict === "removed") continue
            return verdict
        }
        return ownLock(path)
    }
    return "held"
}

function ownLock(path: string): RefreshLock {
    const owner: OwnerRecord = { pid: process.pid, nonce: randomUUID() }
    try {
        writeRecord(path, owner)
    } catch (err) {
        // A record-less lock would block every waiter until manual recovery.
        removeLockDir(path)
        throw err
    }
    return {
        recordCli(cli) {
            writeRecord(path, { ...owner, cli })
        },
        release() {
            // Only this owner removes its barrier. Renaming first removes the
            // whole instance atomically, including a waiter's stray claim dir.
            removeLockDir(path)
        },
    }
}

/**
 * Remove the lock at `path` if its record proves the holder is gone.
 *
 * Proof, never time (Inversion: a stolen live lock means two refresh-token
 * rotations and a revoked login, so every uncertainty keeps the barrier):
 * - the owner PID is dead (ESRCH), and
 * - the recorded CLI is dead too; on Unix its whole process group, because
 *   src/claude-cli.ts spawns it detached (pgid = pid).
 * PID reuse can only make a dead holder look alive, which keeps the barrier.
 */
function takeOverIfStale(path: string): RefreshLockBusy | "removed" {
    const record = readRecord(path)
    if (!record) return "unprovable"
    const owner = liveness(record.pid)
    if (owner !== "dead") return owner
    if (record.cli === "pending") return "unprovable"
    if (record.cli !== undefined) {
        const cli = liveness(
            process.platform === "win32" ? record.cli : -record.cli,
        )
        if (cli !== "dead") return cli
    }
    return removeStaleInstance(path, record)
}

/**
 * Remove the lock at `path` only if it still holds exactly the record `stale`
 * that was proven dead. Since that read, another waiter may have removed it and
 * a new owner re-created it, or the owner may have recorded a CLI and then died.
 *
 * The claim dir is named after the stale instance's nonce, so exactly one
 * waiter claims that instance. The owner was dead before the claim, so the
 * record re-read after claiming is final; if it equals `stale`, the proof
 * holds for the instance at `path`. From then on nothing else changes it
 * (mkdir cannot replace an existing dir, other claimers are excluded), so the
 * rename detaches exactly the proven-stale instance.
 */
export function removeStaleInstance(
    path: string,
    stale: OwnerRecord,
): RefreshLockBusy | "removed" {
    const claim = join(path, `claim-${stale.nonce}`)
    try {
        mkdirSync(claim)
    } catch (err) {
        // ENOENT: the lock is gone, acquisition may simply be retried.
        if ((err as NodeJS.ErrnoException).code === "ENOENT") return "removed"
        // EEXIST: another waiter is removing this instance right now.
        return "unprovable"
    }
    const current = readRecord(path)
    if (
        current?.nonce !== stale.nonce ||
        current.pid !== stale.pid ||
        current.cli !== stale.cli
    ) {
        // A fresh lock or a newer record than the proof covers. Withdraw.
        try {
            rmdirSync(claim)
        } catch {
            /* Its owner may have released it meanwhile. */
        }
        return "held"
    }
    log("refresh_lock_taken_over", { ...stale })
    return removeLockDir(path) ? "removed" : "unprovable"
}

function liveness(pid: number): RefreshLockBusy | "dead" {
    try {
        process.kill(pid, 0)
        return "held"
    } catch (err) {
        const code = (err as NodeJS.ErrnoException).code
        if (code === "ESRCH") return "dead"
        // EPERM: the process exists, it just is not ours.
        return code === "EPERM" ? "held" : "unprovable"
    }
}

function readRecord(path: string): OwnerRecord | null {
    let value: unknown
    try {
        value = JSON.parse(readFileSync(join(path, RECORD), "utf8"))
    } catch {
        return null
    }
    // Parse, don't validate: the nonce becomes a path segment.
    const { pid, nonce, cli } = (value ?? {}) as Record<string, unknown>
    if (!isPid(pid) || typeof nonce !== "string") return null
    if (!/^[0-9a-f-]{36}$/.test(nonce)) return null
    if (cli === undefined) return { pid, nonce }
    if (cli !== "pending" && !isPid(cli)) return null
    return { pid, nonce, cli }
}

function isPid(value: unknown): value is number {
    return Number.isSafeInteger(value) && (value as number) > 0
}

function writeRecord(path: string, record: OwnerRecord): void {
    // Atomic replace: a reader sees the old or the new record, never a torn one.
    const tmp = join(path, `${RECORD}.tmp`)
    writeFileSync(tmp, JSON.stringify(record), { mode: 0o600 })
    renameSync(tmp, join(path, RECORD))
}

/** Atomically detach the lock instance, then delete it. */
function removeLockDir(path: string): boolean {
    const grave = `${path}.removed-${randomUUID()}`
    try {
        renameSync(path, grave)
    } catch {
        return false
    }
    try {
        rmSync(grave, { recursive: true, force: true })
    } catch {
        /* A leftover detached dir no longer excludes anyone. */
    }
    return true
}
