import { mkdirSync, rmdirSync } from "node:fs"
import { dirname } from "node:path"
import { getRefreshLockTarget } from "./paths.ts"

/** A non-expiring barrier. Recovery requires explicit operator quiescence. */
export interface RefreshLock {
    release(): void
}

export function acquireRefreshLock(): RefreshLock | null {
    const path = `${getRefreshLockTarget()}.lock`
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 })
    try {
        mkdirSync(path, { mode: 0o700 })
    } catch (err) {
        if ((err as NodeJS.ErrnoException).code === "EEXIST") return null
        throw err
    }
    return {
        release() {
            // No takeover protocol: only this owner may remove the barrier.
            try {
                rmdirSync(path)
            } catch {
                /* Preserve a barrier we cannot remove. */
            }
        },
    }
}
