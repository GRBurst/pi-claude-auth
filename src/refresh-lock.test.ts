import assert from "node:assert/strict"
import { spawn } from "node:child_process"
import { randomUUID } from "node:crypto"
import { once } from "node:events"
import {
    existsSync,
    mkdirSync,
    mkdtempSync,
    readdirSync,
    readFileSync,
    rmSync,
    utimesSync,
    writeFileSync,
} from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, test } from "node:test"
import {
    acquireRefreshLock,
    refreshLockPath,
    removeStaleInstance,
    type OwnerRecord,
} from "./refresh-lock.ts"
import { getRefreshLockTarget } from "./paths.ts"
import { readFutileRefresh, writeFutileRefresh } from "./futile-refresh.ts"

let home: string
let oldHome: string | undefined
let oldProfile: string | undefined
beforeEach(() => {
    oldHome = process.env.HOME
    oldProfile = process.env.PI_CODING_AGENT_DIR
    home = mkdtempSync(join(tmpdir(), "pi-refresh-lock-"))
    process.env.HOME = home
    process.env.PI_CODING_AGENT_DIR = join(home, "profile-a")
})
afterEach(() => {
    if (oldHome === undefined) delete process.env.HOME
    else process.env.HOME = oldHome
    if (oldProfile === undefined) delete process.env.PI_CODING_AGENT_DIR
    else process.env.PI_CODING_AGENT_DIR = oldProfile
    rmSync(home, { recursive: true, force: true })
})

/** A child that tries the lock, prints the outcome, and holds it until stdin. */
function child(profile: string) {
    const module = new URL("./refresh-lock.ts", import.meta.url).href
    return spawn(
        process.execPath,
        [
            "--experimental-strip-types",
            "--input-type=module",
            "-e",
            `
        import { acquireRefreshLock } from ${JSON.stringify(module)};
        const lock = acquireRefreshLock();
        console.log(typeof lock === "object" ? "owned" : lock);
        if (typeof lock === "object") { process.stdin.resume(); process.stdin.on("data", () => { lock.release(); process.exit(); }); }
    `,
        ],
        {
            env: {
                ...process.env,
                HOME: home,
                PI_CODING_AGENT_DIR: join(home, profile),
            },
            stdio: ["pipe", "pipe", "pipe"],
        },
    )
}

/** The pid of a process that has exited (a reused pid only fails closed). */
async function deadPid(): Promise<number> {
    const proc = spawn(process.execPath, ["-e", ""], { stdio: "ignore" })
    await once(proc, "exit")
    return proc.pid!
}

/** Plant a lock as some other process would have left it. */
function plantLock(record: Partial<OwnerRecord> | string | null): string {
    const path = refreshLockPath()
    mkdirSync(path, { recursive: true })
    if (record !== null) {
        writeFileSync(
            join(path, "owner"),
            typeof record === "string" ? record : JSON.stringify(record),
        )
    }
    return path
}

function readOwner(path: string): OwnerRecord {
    return JSON.parse(readFileSync(join(path, "owner"), "utf8"))
}

test("same HOME profiles share lock and futile record; an old live lock is held", () => {
    const path = getRefreshLockTarget()
    const lock = acquireRefreshLock()
    assert.equal(typeof lock, "object")
    utimesSync(`${path}.lock`, new Date(0), new Date(0))
    const marker = { source: "file", state: "expired" }
    writeFutileRefresh(marker)
    process.env.PI_CODING_AGENT_DIR = join(home, "profile-b")
    assert.equal(getRefreshLockTarget(), path)
    assert.equal(acquireRefreshLock(), "held", "owner alive: barrier kept")
    assert.deepEqual(readFutileRefresh(), marker)
    ;(lock as { release(): void }).release()
    assert.equal(existsSync(`${path}.lock`), false)
    assert.equal(readdirSync(join(home, ".claude", "pi-claude-auth")).length, 1)
})

test("real owner death without a CLI lets a waiter take over", async () => {
    const owner = child("profile-a")
    try {
        const [owned] = await once(owner.stdout, "data")
        assert.match(String(owned), /owned/)
        const waiter = child("profile-b")
        const waiterExit = once(waiter, "exit")
        const [busy] = await once(waiter.stdout, "data")
        assert.match(String(busy), /held/)
        await waiterExit
        const ownerExit = once(owner, "exit")
        owner.kill("SIGKILL")
        await ownerExit
        const lock = acquireRefreshLock()
        assert.equal(typeof lock, "object", "dead owner: takeover")
        assert.equal(readOwner(refreshLockPath()).pid, process.pid)
    } finally {
        owner.kill("SIGKILL")
    }
})

test("dead owner with a live CLI process group keeps the barrier", async (t) => {
    const cli = spawn(process.execPath, ["-e", "setTimeout(() => {}, 30000)"], {
        detached: process.platform !== "win32",
        stdio: "ignore",
    })
    try {
        const path = plantLock({
            pid: await deadPid(),
            nonce: randomUUID(),
            cli: cli.pid!,
        })
        assert.equal(acquireRefreshLock(), "held")
        assert.equal(existsSync(join(path, "owner")), true)
    } finally {
        const exit = once(cli, "exit")
        cli.kill("SIGKILL")
        await exit
    }
    if (process.platform === "win32") return t.skip("process groups")
    assert.equal(typeof acquireRefreshLock(), "object", "group gone: takeover")
})

test("missing, corrupt or launch-pending records keep the barrier as unprovable", async () => {
    const path = plantLock(null)
    assert.equal(acquireRefreshLock(), "unprovable")
    for (const bad of [
        "not json",
        { pid: await deadPid() },
        { pid: await deadPid(), nonce: "../../escape" },
        { pid: -1, nonce: randomUUID() },
        { pid: await deadPid(), nonce: randomUUID(), cli: "1" },
        // The owner died between spawning the CLI and recording its pid.
        { pid: await deadPid(), nonce: randomUUID(), cli: "pending" },
    ]) {
        plantLock(bad)
        assert.equal(acquireRefreshLock(), "unprovable", JSON.stringify(bad))
        assert.equal(existsSync(path), true)
    }
})

test("a waiter with an outdated stale record cannot remove a fresh lock", async () => {
    const stale = { pid: await deadPid(), nonce: randomUUID() }
    const path = plantLock(stale)
    // Another waiter removed the stale instance and a new owner took the lock
    // after this waiter read `stale`.
    assert.equal(removeStaleInstance(path, stale), "removed")
    const fresh = acquireRefreshLock()
    assert.equal(typeof fresh, "object")
    const freshRecord = readOwner(path)

    assert.equal(removeStaleInstance(path, stale), "held")
    assert.deepEqual(readOwner(path), freshRecord)
    assert.deepEqual(readdirSync(path), ["owner"], "claim withdrawn")
})

test("a record updated after the stale read is not removed", async () => {
    const owner = await deadPid()
    const nonce = randomUUID()
    // The waiter read the record before the owner recorded its CLI and died.
    for (const cli of ["pending", process.pid] as const) {
        const path = plantLock({ pid: owner, nonce, cli })
        assert.equal(removeStaleInstance(path, { pid: owner, nonce }), "held")
        assert.deepEqual(readOwner(path), { pid: owner, nonce, cli })
        assert.deepEqual(readdirSync(path), ["owner"], "claim withdrawn")
    }
})

test("a second claimer of the same stale instance backs off", async () => {
    const stale = { pid: await deadPid(), nonce: randomUUID() }
    const path = plantLock(stale)
    mkdirSync(join(path, `claim-${stale.nonce}`))
    assert.equal(removeStaleInstance(path, stale), "unprovable")
    assert.deepEqual(readOwner(path), stale)
})

test("concurrent waiters on a stale lock: exactly one takes over", async () => {
    plantLock({ pid: await deadPid(), nonce: randomUUID() })
    const waiters = Array.from({ length: 8 }, (_, i) => child(`profile-${i}`))
    try {
        const outcomes = await Promise.all(
            waiters.map(async (w) => String((await once(w.stdout, "data"))[0])),
        )
        assert.equal(outcomes.filter((o) => o.includes("owned")).length, 1)
        // The survivor's lock is intact and recorded.
        assert.equal(typeof readOwner(refreshLockPath()).pid, "number")
    } finally {
        for (const w of waiters) w.kill("SIGKILL")
    }
})

import { CredentialStore, LoginUnusable } from "./credential-store.ts"

test("unchanged completed attempts suppress CLI across separate pi profiles", async () => {
    let runs = 0
    const deps = {
        readSource: () => ({
            accessToken: "fake",
            refreshToken: "fake",
            expiresAt: 1,
        }),
        stampSource: () => "unchanged",
        acquireRefreshLock,
        runClaudeRefresh: async () => {
            runs++
        },
        readFutileRefresh,
        writeFutileRefresh,
        now: () => 1_000_000,
        sleep: async () => {},
    }
    await assert.rejects(
        new CredentialStore(deps).ensureFresh("file"),
        LoginUnusable,
    )
    process.env.PI_CODING_AGENT_DIR = join(home, "profile-b")
    await assert.rejects(
        new CredentialStore(deps).ensureFresh("file"),
        LoginUnusable,
    )
    assert.equal(runs, 1)
})
