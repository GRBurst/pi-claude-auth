import assert from "node:assert/strict"
import { test } from "node:test"
import {
    buildRefreshEnv,
    parseClaudeVersion,
    readClaudeCliVersion,
} from "./claude-cli.ts"

// The refresh-lock tests below resolve ~/.claude from a temporary HOME; an
// inherited Claude config-dir override would point them at a real directory.
delete process.env.CLAUDE_CONFIG_DIR
delete process.env.CLAUDE_SECURESTORAGE_CONFIG_DIR

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
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
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

test("parseClaudeVersion: takes the leading semver", () => {
    assert.equal(parseClaudeVersion("2.1.299 (Claude Code)\n"), "2.1.299")
    assert.equal(parseClaudeVersion("2.1.299"), "2.1.299")
})

test("parseClaudeVersion: rejects anything else", () => {
    assert.equal(parseClaudeVersion(""), null)
    assert.equal(parseClaudeVersion("error: nope"), null)
    assert.equal(parseClaudeVersion("2.1.299-evil\r\nx-injected: 1"), null)
})

// A fake `claude` on PATH: no real CLI, no real credentials.
async function withFakeClaude<T>(
    script: string | null,
    run: () => Promise<T>,
): Promise<T> {
    const dir = mkdtempSync(join(tmpdir(), "fake-claude-"))
    const prevPath = process.env.PATH
    if (script !== null) {
        const bin = join(dir, "claude")
        writeFileSync(bin, `#!/bin/sh\n${script}\n`)
        chmodSync(bin, 0o755)
    }
    process.env.PATH = dir
    try {
        return await run()
    } finally {
        process.env.PATH = prevPath
        rmSync(dir, { recursive: true, force: true })
    }
}

test("readClaudeCliVersion: reads stdout, ignores a stderr banner", async () => {
    const version = await withFakeClaude(
        'echo banner >&2; echo "4.5.6 (Claude Code)"',
        readClaudeCliVersion,
    )
    assert.equal(version, "4.5.6")
})

test("readClaudeCliVersion: null when the CLI is missing or fails", async () => {
    assert.equal(await withFakeClaude(null, readClaudeCliVersion), null)
    assert.equal(await withFakeClaude("exit 1", readClaudeCliVersion), null)
})

test("buildRefreshEnv: keeps the Claude config dir, so the refresh writes the file we read", () => {
    const env = buildRefreshEnv({
        CLAUDE_CONFIG_DIR: "/tmp/claude-agents",
        CLAUDE_SECURESTORAGE_CONFIG_DIR: "/tmp/claude-secure",
    })
    assert.equal(env.CLAUDE_CONFIG_DIR, "/tmp/claude-agents")
    assert.equal(env.CLAUDE_SECURESTORAGE_CONFIG_DIR, "/tmp/claude-secure")
})
