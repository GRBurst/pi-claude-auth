import assert from "node:assert/strict"
import { spawn } from "node:child_process"
import { once } from "node:events"
import { mkdtempSync, rmSync, utimesSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, test } from "node:test"
import { acquireRefreshLock } from "./refresh-lock.ts"
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
        console.log(lock ? "owned" : "busy");
        if (lock) { process.stdin.resume(); process.stdin.on("data", () => { lock.release(); process.exit(); }); }
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

test("same HOME profiles share lock and futile record; ancient lock never taken", () => {
    const path = getRefreshLockTarget()
    const lock = acquireRefreshLock()!
    utimesSync(`${path}.lock`, new Date(0), new Date(0))
    const marker = { source: "file", state: "expired" }
    writeFutileRefresh(marker)
    process.env.PI_CODING_AGENT_DIR = join(home, "profile-b")
    assert.equal(getRefreshLockTarget(), path)
    assert.equal(acquireRefreshLock(), null)
    assert.deepEqual(readFutileRefresh(), marker)
    lock.release()
    acquireRefreshLock()!.release()
})

test("real child contention across profiles and explicit owner-death orphan barrier", async () => {
    const owner = child("profile-a")
    try {
        const [owned] = await once(owner.stdout, "data")
        assert.match(String(owned), /owned/)
        const waiter = child("profile-b")
        const waiterExit = once(waiter, "exit")
        const [busy] = await once(waiter.stdout, "data")
        assert.match(String(busy), /busy/)
        await waiterExit
        const ownerExit = once(owner, "exit")
        owner.kill("SIGKILL")
        await ownerExit
        assert.equal(
            acquireRefreshLock(),
            null,
            "owner death must not authorize takeover",
        )
    } finally {
        owner.kill("SIGKILL")
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
