import assert from "node:assert/strict"
import { test } from "node:test"
import {
    CLAUDE_UNAVAILABLE_MESSAGE,
    CredentialStore,
    LOGIN_EXPIRED_MESSAGE,
    LoginUnusable,
    MIN_VALIDITY_MS,
    REFRESH_BUSY_MESSAGE,
    type CredentialStoreDeps,
} from "./credential-store.ts"
import {
    ClaudeCliUnavailable,
    ClaudeRefreshAborted,
    ClaudeTerminationUnconfirmed,
} from "./claude-cli.ts"
import type { ClaudeCredentials } from "./keychain.ts"
import type { FutileRefresh } from "./futile-refresh.ts"

const SOURCE = "file"
const NOW = 1_700_000_000_000

function creds(expiresAt: number, accessToken = "access"): ClaudeCredentials {
    return { accessToken, refreshToken: "refresh", expiresAt }
}

const FRESH = creds(NOW + 8 * 3_600_000, "fresh")
const EXPIRED = creds(NOW - 1_000, "expired")

/**
 * A fake world: an in-memory credential source with a stamp, a lock that can be
 * held by an imaginary other process, and an instant clock. Everything the
 * store does to the outside is observable here — no `claude`, no files, no
 * waiting.
 */
function makeWorld(initial: ClaudeCredentials | null) {
    const world = {
        stored: initial,
        stamp: "s0",
        reads: 0,
        refreshRuns: 0,
        lockHeldByOther: false,
        lockedByUs: false,
        marker: null as FutileRefresh | null,
        slept: 0,
        now: NOW,
        /** What the delegated `claude` run does to the source. */
        onRefresh: (): void => {
            world.write(FRESH)
        },
        write(next: ClaudeCredentials | null): void {
            world.stored = next
            world.stamp = `s${Number(world.stamp.slice(1)) + 1}`
        },
    }

    const deps: CredentialStoreDeps = {
        readSource: () => {
            world.reads++
            return world.stored
        },
        stampSource: () => world.stamp,
        acquireRefreshLock: () => {
            if (world.lockHeldByOther) return "held"
            world.lockedByUs = true
            return {
                release: () => {
                    world.lockedByUs = false
                },
            }
        },
        runClaudeRefresh: async () => {
            world.refreshRuns++
            world.onRefresh()
        },
        readFutileRefresh: () => world.marker,
        writeFutileRefresh: (marker) => {
            world.marker = marker
        },
        now: () => world.now,
        sleep: async (ms) => {
            world.slept += ms
            world.now += ms
        },
    }

    // The store keeps this exact deps object, so tests can still swap a single
    // behaviour (a slow lock holder, a failing CLI) after construction.
    return { world, deps, store: new CredentialStore(deps) }
}

test("read: re-reads only when the source stamp changed", () => {
    const { world, store } = makeWorld(FRESH)

    assert.equal(store.read(SOURCE)?.accessToken, "fresh")
    assert.equal(world.reads, 1)

    // Unchanged source: served from memory.
    store.read(SOURCE)
    store.read(SOURCE)
    assert.equal(world.reads, 1)

    // The Claude CLI rewrote the credentials file.
    world.write(creds(NOW + 3_600_000, "rotated"))
    assert.equal(store.read(SOURCE)?.accessToken, "rotated")
    assert.equal(world.reads, 2)
})

test("read: re-reads every time when the source has no stamp", () => {
    const { world, deps, store } = makeWorld(FRESH)
    deps.stampSource = () => null // keychain file not known: cannot validate

    store.read(SOURCE)
    store.read(SOURCE)
    assert.equal(world.reads, 2)

    // Another process rotated the token; a stale copy would be revoked.
    world.write(creds(NOW + 3_600_000, "rotated"))
    assert.equal(store.read(SOURCE)?.accessToken, "rotated")
})

test("ensureFresh: valid credentials never spawn a refresh", async () => {
    const { world, store } = makeWorld(FRESH)
    const result = await store.ensureFresh(SOURCE)
    assert.equal(result.accessToken, "fresh")
    assert.equal(world.refreshRuns, 0)
})

test("ensureFresh: credentials inside the validity window are refreshed", async () => {
    const { world, store } = makeWorld(creds(NOW + MIN_VALIDITY_MS - 1_000))
    const result = await store.ensureFresh(SOURCE)
    assert.equal(result.accessToken, "fresh")
    assert.equal(world.refreshRuns, 1)
})

test("ensureFresh: expired credentials delegate exactly one refresh", async () => {
    const { world, store } = makeWorld(EXPIRED)

    const result = await store.ensureFresh(SOURCE)

    assert.equal(result.accessToken, "fresh")
    assert.equal(world.refreshRuns, 1)
    assert.equal(world.lockedByUs, false, "lock must be released")
})

test("ensureFresh: no second refresh when the lock holder already refreshed", async () => {
    const { world, store } = makeWorld(EXPIRED)
    // First read caches the expired credentials, then another process refreshes
    // and releases the lock before we take it.
    store.read(SOURCE)
    world.write(FRESH)

    const result = await store.ensureFresh(SOURCE)

    assert.equal(result.accessToken, "fresh")
    assert.equal(world.refreshRuns, 0)
})

test("ensureFresh: a waiter uses the other process's result without spawning", async () => {
    const { world, deps, store } = makeWorld(EXPIRED)
    world.lockHeldByOther = true
    // The holder's `claude` writes the refreshed credentials while we wait.
    const sleep = deps.sleep
    let ticks = 0
    deps.sleep = async (ms) => {
        await sleep(ms)
        if (++ticks === 3) world.write(FRESH)
    }

    const result = await store.ensureFresh(SOURCE)

    assert.equal(result.accessToken, "fresh")
    assert.equal(world.refreshRuns, 0)
    assert.ok(world.slept > 0, "waiter polled the source")
})

test("ensureFresh: a permanently busy lock fails as transient, without spawning", async () => {
    const { world, store } = makeWorld(EXPIRED)
    world.lockHeldByOther = true

    // Callers distinguish the two by type: only an unusable login may make them
    // look for another account, contention says nothing about the login.
    await assert.rejects(store.ensureFresh(SOURCE), (err: Error) => {
        assert.equal(err.message, REFRESH_BUSY_MESSAGE)
        assert.equal(err instanceof LoginUnusable, false)
        return true
    })
    assert.equal(world.refreshRuns, 0)
})

test("ensureFresh: still-expired after the refresh reports an expired login", async () => {
    const { world, store } = makeWorld(EXPIRED)
    world.onRefresh = () => {} // `claude` ran but did not log in

    await assert.rejects(store.ensureFresh(SOURCE), (err: Error) => {
        assert.equal(err.message, LOGIN_EXPIRED_MESSAGE)
        assert.ok(err instanceof LoginUnusable)
        return true
    })
    assert.equal(world.refreshRuns, 1)
    assert.equal(world.lockedByUs, false, "lock must be released")
})

test("ensureFresh: a failing claude run still uses what it wrote", async () => {
    const { world, deps, store } = makeWorld(EXPIRED)
    deps.runClaudeRefresh = async () => {
        world.refreshRuns++
        world.write(FRESH)
        throw new Error("claude exited with 1")
    }

    const result = await store.ensureFresh(SOURCE)
    assert.equal(result.accessToken, "fresh")
})

test("a failed login is remembered and retried only after the source changes", async () => {
    const { world, store } = makeWorld(EXPIRED)
    world.onRefresh = () => {} // `claude` cannot log in anymore

    await assert.rejects(store.ensureFresh(SOURCE), {
        message: LOGIN_EXPIRED_MESSAGE,
    })
    assert.equal(world.refreshRuns, 1)
    assert.equal(world.marker?.source, SOURCE)

    // Same source state: no second `claude`, no waiting, just the message.
    await assert.rejects(store.ensureFresh(SOURCE), {
        message: LOGIN_EXPIRED_MESSAGE,
    })
    assert.equal(world.refreshRuns, 1)
    assert.equal(store.loginProblem(SOURCE), LOGIN_EXPIRED_MESSAGE)

    // The user ran `claude` and logged in: the source changed, so retry.
    world.onRefresh = () => world.write(FRESH)
    world.write(creds(NOW - 500, "still-expired-but-new"))
    assert.equal(store.loginProblem(SOURCE), null)

    const result = await store.ensureFresh(SOURCE)
    assert.equal(result.accessToken, "fresh")
    assert.equal(world.refreshRuns, 2)
    assert.equal(world.marker, null, "successful refresh clears the record")
})

test("a marker from another account does not block this one", () => {
    const { world, store } = makeWorld(EXPIRED)
    world.marker = { source: "Claude Code-credentials", state: world.stamp }
    assert.equal(store.loginProblem(SOURCE), null)
})

test("credentials short of the safety margin are used, not declared dead", async () => {
    // The CLI refuses to refresh a token it still considers good.
    const { world, store } = makeWorld(creds(NOW + 30_000, "almost-expired"))
    world.onRefresh = () => {}

    const result = await store.ensureFresh(SOURCE)

    assert.equal(result.accessToken, "almost-expired")
    assert.equal(world.refreshRuns, 1)
    assert.equal(store.loginProblem(SOURCE), null, "not a login problem yet")

    // A second request in the same window must not run the CLI again.
    await store.ensureFresh(SOURCE)
    assert.equal(world.refreshRuns, 1)

    // Once the token is actually expired, the CLI is worth another try.
    world.now = NOW + 60_000
    world.onRefresh = () => world.write(FRESH)
    assert.equal((await store.ensureFresh(SOURCE)).accessToken, "fresh")
    assert.equal(world.refreshRuns, 2)
})

test("a transient lock timeout is not remembered as a failed login", async () => {
    const { world, store } = makeWorld(EXPIRED)
    world.lockHeldByOther = true

    await assert.rejects(store.ensureFresh(SOURCE), {
        message: REFRESH_BUSY_MESSAGE,
    })
    assert.equal(world.marker, null)
})

test("a waiter does not repeat a futile refresh the holder already tried", async () => {
    const { world, deps, store } = makeWorld(EXPIRED)
    world.lockHeldByOther = true
    // The holder runs `claude`, learns it changes nothing, and releases.
    let ticks = 0
    const sleep = deps.sleep
    deps.sleep = async (ms) => {
        await sleep(ms)
        if (++ticks === 2) {
            world.marker = { source: SOURCE, state: `${world.stamp}|expired` }
            world.lockHeldByOther = false
        }
    }

    await assert.rejects(store.ensureFresh(SOURCE), {
        message: LOGIN_EXPIRED_MESSAGE,
    })
    assert.equal(world.refreshRuns, 0, "the CLI must not run a second time")
})

test("an unrunnable claude CLI is reported as such and not remembered", async () => {
    const { world, deps, store } = makeWorld(EXPIRED)
    deps.runClaudeRefresh = async () => {
        world.refreshRuns++
        throw new ClaudeCliUnavailable("spawn claude ENOENT")
    }

    await assert.rejects(store.ensureFresh(SOURCE), (err: Error) => {
        assert.equal(err.message, CLAUDE_UNAVAILABLE_MESSAGE)
        assert.equal(err instanceof LoginUnusable, false)
        return true
    })
    assert.equal(world.marker, null, "a CLI that never ran proves nothing")
    assert.equal(world.lockedByUs, false)

    // The next attempt must try again rather than stay silent.
    deps.runClaudeRefresh = async () => {
        world.refreshRuns++
        world.write(FRESH)
    }
    assert.equal((await store.ensureFresh(SOURCE)).accessToken, "fresh")
})

test("ensureFresh: confirmed timeout is transient and does not mark login futile", async () => {
    const { world, deps, store } = makeWorld(EXPIRED)
    deps.runClaudeRefresh = async () => {
        throw new ClaudeRefreshAborted("incomplete rotation")
    }
    await assert.rejects(store.ensureFresh(SOURCE), ClaudeRefreshAborted)
    assert.equal(world.marker, null)
    assert.equal(world.lockedByUs, false)
})

test("ensureFresh: unconfirmed termination retains barrier", async () => {
    const { world, deps, store } = makeWorld(EXPIRED)
    deps.runClaudeRefresh = async () => {
        throw new ClaudeTerminationUnconfirmed("uncertain")
    }
    await assert.rejects(
        store.ensureFresh(SOURCE),
        ClaudeTerminationUnconfirmed,
    )
    assert.equal(world.lockedByUs, true)
    assert.equal(world.marker, null)
})

function deferred<T>() {
    let resolve!: (value: T) => void
    let reject!: (error: Error) => void
    const promise = new Promise<T>((yes, no) => {
        resolve = yes
        reject = no
    })
    return { promise, resolve, reject }
}

/** pi's abort (its hard refresh timeout) surfaces as the busy message. */
function busyBecause(reason: string) {
    return (err: Error) => {
        assert.equal(err.message, REFRESH_BUSY_MESSAGE)
        assert.equal((err.cause as Error).message, reason)
        return true
    }
}

test("aborted before ownership never takes lock or launches CLI", async () => {
    const { world, deps, store } = makeWorld(EXPIRED)
    let acquisitions = 0
    deps.acquireRefreshLock = () => {
        acquisitions++
        return "held"
    }
    const caller = new AbortController()
    caller.abort(new Error("caller canceled"))
    await assert.rejects(
        store.ensureFresh(SOURCE, caller.signal),
        /caller canceled/,
    )
    assert.equal(acquisitions, 0)
    assert.equal(world.refreshRuns, 0)
})

test("canceled busy waiter never launches later", async () => {
    const { world, deps, store } = makeWorld(EXPIRED)
    world.lockHeldByOther = true
    const sleeping = deferred<void>()
    deps.sleep = () => sleeping.promise
    const caller = new AbortController()
    const result = store.ensureFresh(SOURCE, caller.signal)
    caller.abort(new Error("cancel waiter"))
    await assert.rejects(result, busyBecause("cancel waiter"))
    world.lockHeldByOther = false
    sleeping.resolve()
    await new Promise((resolve) => setImmediate(resolve))
    assert.equal(world.refreshRuns, 0)
    assert.equal(world.lockedByUs, false)
})

test("aborted owner returns promptly but job, reread and marker stay locked", async () => {
    const { world, deps, store } = makeWorld(EXPIRED)
    const command = deferred<void>()
    let ownerSignal: AbortSignal | undefined
    deps.runClaudeRefresh = (signal) => {
        world.refreshRuns++
        ownerSignal = signal
        return command.promise
    }
    const writeMarker = deps.writeFutileRefresh
    deps.writeFutileRefresh = (marker) => {
        assert.equal(world.lockedByUs, true, "finalization is inside barrier")
        writeMarker(marker)
    }
    const caller = new AbortController()
    const result = store.ensureFresh(SOURCE, caller.signal)
    caller.abort(new Error("stop waiting"))
    await assert.rejects(result, busyBecause("stop waiting"))
    assert.equal(world.lockedByUs, true)
    assert.equal(ownerSignal?.aborted, false)
    world.write(FRESH)
    command.resolve()
    await new Promise((resolve) => setImmediate(resolve))
    assert.equal(world.lockedByUs, false)
    assert.equal((await store.ensureFresh(SOURCE)).accessToken, "fresh")
    assert.equal(world.refreshRuns, 1)
})

test("abandoned owner rejection is observed and still records unchanged state", async () => {
    const { world, deps, store } = makeWorld(EXPIRED)
    const command = deferred<void>()
    deps.runClaudeRefresh = () => command.promise
    const caller = new AbortController()
    const result = store.ensureFresh(SOURCE, caller.signal)
    caller.abort(new Error("abandon"))
    await assert.rejects(result, busyBecause("abandon"))
    command.reject(new Error("failed command"))
    await new Promise((resolve) => setImmediate(resolve))
    assert.equal(world.lockedByUs, false)
    assert.ok(world.marker)
})

test("confirmed timeout accepts authoritative fresh reread without futile marker", async () => {
    const { world, deps, store } = makeWorld(EXPIRED)
    deps.runClaudeRefresh = async () => {
        world.write(FRESH)
        throw new ClaudeRefreshAborted("timed out mid-rotation")
    }
    assert.equal((await store.ensureFresh(SOURCE)).accessToken, "fresh")
    assert.equal(world.marker, null)
    assert.equal(world.lockedByUs, false)
})
