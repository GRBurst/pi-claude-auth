import assert from "node:assert/strict"
import { spawn } from "node:child_process"
import { once } from "node:events"
import {
    existsSync,
    mkdirSync,
    mkdtempSync,
    readdirSync,
    rmSync,
    utimesSync,
} from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, test } from "node:test"
import { acquireRefreshLock, refreshLockPath } from "./refresh-lock.ts"
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

test("same HOME profiles share lock and futile record; an old live lock is held", () => {
    const path = getRefreshLockTarget()
    const lock = acquireRefreshLock()
    assert.equal(typeof lock, "object")
    utimesSync(`${path}.lock`, new Date(0), new Date(0))
    const marker = { source: "file", state: "expired" }
    writeFutileRefresh(marker)
    process.env.PI_CODING_AGENT_DIR = join(home, "profile-b")
    assert.equal(getRefreshLockTarget(), path)
    assert.equal(acquireRefreshLock(), "held", "time never frees the barrier")
    assert.deepEqual(readFutileRefresh(), marker)
    ;(lock as { release(): void }).release()
    assert.equal(existsSync(`${path}.lock`), false)
    assert.equal(readdirSync(join(home, ".claude", "pi-claude-auth")).length, 1)
})

test("a dead owner keeps the barrier: death cannot be proven across processes", async () => {
    const owner = child("profile-a")
    try {
        const [owned] = await once(owner.stdout, "data")
        assert.match(String(owned), /owned/)
        const ownerExit = once(owner, "exit")
        owner.kill("SIGKILL")
        await ownerExit
        assert.equal(acquireRefreshLock(), "held")
    } finally {
        owner.kill("SIGKILL")
    }
})

test("an empty relic of a pre-publish version is replaced", () => {
    const path = refreshLockPath()
    mkdirSync(path, { recursive: true })
    const lock = acquireRefreshLock()
    assert.equal(typeof lock, "object")
    assert.equal(acquireRefreshLock(), "held")
})

test("an unpublished claim dir excludes nobody", () => {
    mkdirSync(`${getRefreshLockTarget()}.claim-crashed`, { recursive: true })
    assert.equal(typeof acquireRefreshLock(), "object")
})

test("an owner whose lock was removed by hand does not release its successor", () => {
    const first = acquireRefreshLock() as { release(): void }
    rmSync(refreshLockPath(), { recursive: true })
    const second = acquireRefreshLock() as { release(): void }
    assert.equal(typeof second, "object")
    first.release()
    assert.equal(existsSync(refreshLockPath()), true)
    second.release()
    assert.equal(existsSync(refreshLockPath()), false)
})

test("concurrent contenders: exactly one owns, the rest see it held", async () => {
    const contenders = Array.from({ length: 8 }, (_, i) =>
        child(`profile-${i}`),
    )
    try {
        const outcomes = await Promise.all(
            contenders.map(async (c) =>
                String((await once(c.stdout, "data"))[0]),
            ),
        )
        assert.equal(outcomes.filter((o) => o.includes("owned")).length, 1)
        assert.equal(outcomes.filter((o) => o.includes("held")).length, 7)
    } finally {
        for (const c of contenders) c.kill("SIGKILL")
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
