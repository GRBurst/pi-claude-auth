import assert from "node:assert/strict"
import { test } from "node:test"
import { buildRefreshEnv } from "./claude-cli.ts"

test("buildRefreshEnv: drops auth sources that outrank the OAuth login", () => {
    const env = buildRefreshEnv({
        ANTHROPIC_API_KEY: "sk-ant-secret",
        ANTHROPIC_AUTH_TOKEN: "token",
        PATH: "/usr/bin",
    })

    // Present, the CLI would answer via the API key and never refresh the
    // OAuth token — a run that succeeds and changes nothing.
    assert.equal(env.ANTHROPIC_API_KEY, undefined)
    assert.equal(env.ANTHROPIC_AUTH_TOKEN, undefined)
    assert.equal(env.PATH, "/usr/bin")
})

test("buildRefreshEnv: forces TERM=dumb", () => {
    assert.equal(buildRefreshEnv({ TERM: "xterm-256color" }).TERM, "dumb")
})

test("buildRefreshEnv: leaves the caller's environment untouched", () => {
    const base = { ANTHROPIC_API_KEY: "sk-ant-secret", TERM: "xterm" }
    buildRefreshEnv(base)
    assert.equal(base.ANTHROPIC_API_KEY, "sk-ant-secret")
    assert.equal(base.TERM, "xterm")
})

// Fake processes exercise completion without running Claude or touching tokens.
import { EventEmitter } from "node:events"
import type { ChildProcess } from "node:child_process"
import {
    ClaudeRefreshAborted,
    ClaudeTerminationUnconfirmed,
    waitForClaudeCompletion,
} from "./claude-cli.ts"

function fakeChild() {
    const child = new EventEmitter() as ChildProcess
    let kills = 0
    child.kill = () => {
        kills++
        return true
    }
    return { child, kills: () => kills }
}

test("runner stop request stays pending until confirmed close", async () => {
    const { child, kills } = fakeChild()
    const controller = new AbortController()
    let settled = false
    const result = waitForClaudeCompletion(child, controller.signal)
    const rejected = assert.rejects(result, ClaudeRefreshAborted).then(() => {
        settled = true
    })
    controller.abort()
    await new Promise((resolve) => setImmediate(resolve))
    assert.equal(kills(), 1)
    assert.equal(settled, false)
    child.emit("close", null, "SIGKILL")
    await rejected
})

test("runner unconfirmed process error cannot claim completion", async () => {
    const { child } = fakeChild()
    Object.defineProperty(child, "pid", { value: process.pid })
    const result = waitForClaudeCompletion(child, new AbortController().signal)
    child.emit("error", new Error("cannot observe process"))
    await assert.rejects(result, ClaudeTerminationUnconfirmed)
})

test("runner timeout is incomplete refresh, not permanent revocation", async () => {
    const { child } = fakeChild()
    child.kill = () => {
        setImmediate(() => child.emit("close", null, "SIGKILL"))
        return true
    }
    await assert.rejects(
        waitForClaudeCompletion(child, new AbortController().signal, 1),
        /rotation may be incomplete/,
    )
})

import { spawn } from "node:child_process"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { acquireRefreshLock } from "./refresh-lock.ts"

// These children execute Node only: no CLI, tokens, or credential reads.
test("Unix wrapper close with ordinary group child retains real barrier", async (t) => {
    if (process.platform === "win32") {
        t.skip("Unix process groups")
        return
    }
    const home = mkdtempSync(join(tmpdir(), "pi-runner-group-"))
    const oldHome = process.env.HOME
    process.env.HOME = home
    const lock = acquireRefreshLock()!
    const wrapper = spawn(
        process.execPath,
        [
            "-e",
            `
        const { spawn } = require("node:child_process");
        const child = spawn(process.execPath, ["-e", "setTimeout(() => process.exit(), 5000)"], { stdio: "ignore" });
        child.once("spawn", () => process.exit(0));
    `,
        ],
        {
            detached: true,
            stdio: "ignore",
            env: { ...process.env, HOME: home },
        },
    )
    try {
        await assert.rejects(
            waitForClaudeCompletion(wrapper, new AbortController().signal),
            ClaudeTerminationUnconfirmed,
        )
        assert.equal(
            acquireRefreshLock(),
            "held",
            "close cannot permit another owner while group lives",
        )
    } finally {
        // Explicit test cleanup, never a production takeover heuristic.
        stopTestGroup(wrapper.pid!)
        lock.release()
        if (oldHome === undefined) delete process.env.HOME
        else process.env.HOME = oldHome
        rmSync(home, { recursive: true, force: true })
    }
})

test("Unix normal direct-child/group completion succeeds", async (t) => {
    if (process.platform === "win32") {
        t.skip("Unix process groups")
        return
    }
    const child = spawn(process.execPath, ["-e", "process.exit(0)"], {
        detached: true,
        stdio: "ignore",
    })
    await waitForClaudeCompletion(child, new AbortController().signal)
})

test("stop without close becomes unconfirmed rather than claiming completion", async (t) => {
    t.mock.timers.enable({ apis: ["setTimeout"] })
    const { child } = fakeChild()
    const caller = new AbortController()
    const result = waitForClaudeCompletion(child, caller.signal)
    const rejected = assert.rejects(result, ClaudeTerminationUnconfirmed)
    caller.abort()
    t.mock.timers.tick(5_000)
    await rejected
})

function stopTestGroup(pid: number): void {
    try {
        process.kill(-pid, "SIGKILL")
    } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== "ESRCH") throw err
    }
}
