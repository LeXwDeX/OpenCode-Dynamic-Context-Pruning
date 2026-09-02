import assert from "node:assert/strict"
import test from "node:test"
import { BOUNDARY_QUIET_MS, SessionBoundaryTracker } from "../lib/session-boundary"
import type { AtRestListener, RestFireReason } from "../lib/session-boundary"

interface Harness {
    tracker: SessionBoundaryTracker
    fires: Array<{ sessionID: string; reason: RestFireReason }>
    probeCalls: string[]
    setProbe: (impl: (sessionID: string) => Promise<boolean | null>) => void
    fireTimers: () => void
    pendingTimers: () => number
    setNow: (at: number) => void
    warns: Array<{ message: string; meta?: unknown }>
}

function build(): Harness {
    let clock = 0
    let handle = 0
    const timers = new Map<number, () => void>()
    const fires: Array<{ sessionID: string; reason: RestFireReason }> = []
    const warns: Array<{ message: string; meta?: unknown }> = []
    const probeCalls: string[] = []
    let probeImpl: (sessionID: string) => Promise<boolean | null> = async () => false

    const tracker = new SessionBoundaryTracker({
        probeBusy: (sessionID) => {
            probeCalls.push(sessionID)
            return probeImpl(sessionID)
        },
        logger: {
            debug: () => {},
            warn: (message: string, meta?: unknown) => {
                warns.push({ message, meta })
            },
        } as any,
        now: () => clock,
        setTimer: (fn: () => void, ms: number) => {
            assert.equal(ms, BOUNDARY_QUIET_MS)
            handle += 1
            timers.set(handle, fn)
            return handle
        },
        clearTimer: (t: unknown) => {
            timers.delete(t as number)
        },
    })

    return {
        tracker,
        fires,
        probeCalls,
        setProbe: (impl) => {
            probeImpl = impl
        },
        fireTimers: () => {
            const fns = [...timers.values()]
            timers.clear()
            for (const fn of fns) fn()
        },
        pendingTimers: () => timers.size,
        setNow: (at) => {
            clock = at
        },
        warns,
    }
}

function trackFires(h: Harness): void {
    h.tracker.onAtRest((sessionID, reason) => {
        h.fires.push({ sessionID, reason })
    })
}

test("idle opens one quiet window; duplicate idle legs are ignored (I2/I7)", async () => {
    const h = build()
    trackFires(h)
    h.tracker.observeStatus("s1", "idle")
    assert.equal(h.pendingTimers(), 1)
    h.tracker.observeLegacyIdle("s1")
    assert.equal(h.pendingTimers(), 1, "the dual-publish second leg must not arm a second window")

    h.fireTimers()
    await new Promise((resolve) => setTimeout(resolve, 0))
    assert.deepEqual(
        h.fires.map((f) => f.sessionID),
        ["s1"],
    )
})

test("busy observed during the window cancels it and never fires (I1)", async () => {
    const h = build()
    trackFires(h)
    h.tracker.observeStatus("s1", "idle")
    h.tracker.observeStatus("s1", "busy")
    assert.equal(h.pendingTimers(), 0, "busy cancels the armed window")

    h.fireTimers() // any stale timer would be a bug; nothing is armed
    await new Promise((resolve) => setTimeout(resolve, 0))
    assert.equal(h.fires.length, 0)
    assert.equal(h.probeCalls.length, 0, "a cancelled window never probes")
    assert.equal(h.tracker.state("s1"), "busy")
})

test("retry is exactly as busy as busy", async () => {
    const h = build()
    trackFires(h)
    h.tracker.observeStatus("s1", "idle")
    h.tracker.observeStatus("s1", "retry")
    h.fireTimers()
    await new Promise((resolve) => setTimeout(resolve, 0))
    assert.equal(h.fires.length, 0)
    assert.equal(h.tracker.state("s1"), "busy")
})

test("expiry probe returning busy cancels the boundary (relay idle)", async () => {
    const h = build()
    trackFires(h)
    h.setProbe(async () => true)
    h.tracker.observeStatus("s1", "idle")
    h.fireTimers()
    await new Promise((resolve) => setTimeout(resolve, 0))
    assert.equal(h.fires.length, 0)
    assert.equal(h.tracker.state("s1"), "busy")
})

test("probe returning idle classifies at-rest and fires listeners in order (window-expired)", async () => {
    const h = build()
    const order: string[] = []
    h.tracker.onAtRest(() => {
        order.push("drain")
    })
    h.tracker.onAtRest(() => {
        order.push("auto-prune")
    })
    h.tracker.observeStatus("s1", "idle")
    h.fireTimers()
    await new Promise((resolve) => setTimeout(resolve, 0))
    assert.deepEqual(order, ["drain", "auto-prune"])
    assert.equal(h.tracker.state("s1"), "at-rest")
})

test("probe returning null fails open to at-rest (probe-failopen)", async () => {
    const h = build()
    trackFires(h)
    h.setProbe(async () => null)
    h.tracker.observeStatus("s1", "idle")
    h.fireTimers()
    await new Promise((resolve) => setTimeout(resolve, 0))
    assert.deepEqual(
        h.fires.map((f) => f.reason),
        ["probe-failopen"],
    )
})

test("busy arriving while the probe is in flight voids the result (RC-5/I10)", async () => {
    const h = build()
    trackFires(h)
    let resolveProbe!: (value: boolean | null) => void
    h.setProbe(
        () =>
            new Promise<boolean | null>((resolve) => {
                resolveProbe = resolve
            }),
    )
    h.tracker.observeStatus("s1", "idle")
    h.fireTimers()
    assert.equal(h.probeCalls.length, 1)

    h.tracker.observeStatus("s1", "busy")
    resolveProbe(false)
    await new Promise((resolve) => setTimeout(resolve, 0))

    assert.equal(h.fires.length, 0, "a stale probe result must never fire")
    assert.equal(h.tracker.state("s1"), "busy")
})

test("deleted arriving while the probe is in flight voids the result (RC-5/I3)", async () => {
    const h = build()
    trackFires(h)
    let resolveProbe!: (value: boolean | null) => void
    h.setProbe(
        () =>
            new Promise<boolean | null>((resolve) => {
                resolveProbe = resolve
            }),
    )
    h.tracker.observeStatus("s1", "idle")
    h.fireTimers()

    h.tracker.observeDeleted("s1")
    resolveProbe(false)
    await new Promise((resolve) => setTimeout(resolve, 0))

    assert.equal(h.fires.length, 0)
    assert.equal(h.tracker.state("s1"), "unknown")
})

test("deleted cancels a pending window and the session never fires afterwards (I3)", async () => {
    const h = build()
    trackFires(h)
    h.tracker.observeStatus("s1", "idle")
    assert.equal(h.pendingTimers(), 1)
    h.tracker.observeDeleted("s1")
    assert.equal(h.pendingTimers(), 0, "the window timer is cleared on delete")

    h.fireTimers()
    await new Promise((resolve) => setTimeout(resolve, 0))
    assert.equal(h.fires.length, 0)
    assert.equal(h.probeCalls.length, 0)
})

test("compacted resets the phase to unknown so the next idle opens a fresh window", async () => {
    const h = build()
    trackFires(h)
    h.tracker.observeStatus("s1", "idle")
    h.fireTimers()
    await new Promise((resolve) => setTimeout(resolve, 0))
    assert.equal(h.fires.length, 1)

    h.tracker.observeCompacted("s1")
    assert.equal(h.tracker.state("s1"), "unknown")

    h.tracker.observeStatus("s1", "idle")
    h.fireTimers()
    await new Promise((resolve) => setTimeout(resolve, 0))
    assert.equal(h.fires.length, 2, "the boundary re-arms after compaction")
})

test("T3 degrade: at-rest re-arms on the next legacy idle, one fire per turn (B-1)", async () => {
    const h = build()
    trackFires(h)
    h.setProbe(async () => null) // status-less host: the probe is blind

    // Turn 1 boundary: legacy idle only (no status observation ever).
    h.tracker.observeLegacyIdle("s1")
    h.fireTimers()
    await new Promise((resolve) => setTimeout(resolve, 0))
    assert.equal(h.fires.length, 1, "turn 1 drain fires")

    // Turn 2 boundary: another legacy idle must re-arm from at-rest.
    h.tracker.observeLegacyIdle("s1")
    assert.equal(h.pendingTimers(), 1, "at-rest + legacy idle (degrade) re-arms the window")
    h.fireTimers()
    await new Promise((resolve) => setTimeout(resolve, 0))
    assert.equal(h.fires.length, 2, "turn 2 drain fires — no permanent stall")
})

test("T1 hosts: at-rest + legacy idle stays at-rest once status was observed", async () => {
    const h = build()
    trackFires(h)
    h.tracker.observeStatus("s1", "idle")
    h.fireTimers()
    await new Promise((resolve) => setTimeout(resolve, 0))
    assert.equal(h.fires.length, 1)

    h.tracker.observeLegacyIdle("s1")
    assert.equal(h.pendingTimers(), 0, "the dual-publish second leg is absorbed")
    h.fireTimers()
    await new Promise((resolve) => setTimeout(resolve, 0))
    assert.equal(h.fires.length, 1)
})

test("busy evidence decays to unknown after the TTL (fail-open)", () => {
    const h = build()
    h.tracker.observeStatus("s1", "busy")
    assert.equal(h.tracker.state("s1"), "busy")

    h.setNow(10 * 60_000 + 1)
    assert.equal(h.tracker.state("s1"), "unknown")
})

test("a throwing listener does not block later listeners (RC-6)", async () => {
    const h = build()
    const seen: string[] = []
    const throwing: AtRestListener = () => {
        throw new Error("listener exploded")
    }
    h.tracker.onAtRest(throwing)
    h.tracker.onAtRest(() => {
        seen.push("second")
    })

    h.tracker.observeStatus("s1", "idle")
    h.fireTimers()
    await new Promise((resolve) => setTimeout(resolve, 0))

    assert.deepEqual(seen, ["second"])
    assert.ok(h.warns.some((w) => /listener failed/.test(w.message)))
})

test("a rejecting async listener does not block later listeners and never escapes (RC-6)", async () => {
    const h = build()
    const seen: string[] = []
    const rejecting: AtRestListener = async () => {
        throw new Error("async listener exploded")
    }
    h.tracker.onAtRest(rejecting)
    h.tracker.onAtRest(async () => {
        seen.push("second")
    })

    h.tracker.observeStatus("s1", "idle")
    h.fireTimers()
    await new Promise((resolve) => setTimeout(resolve, 0))

    assert.deepEqual(seen, ["second"])
    assert.ok(h.warns.some((w) => /listener rejected/.test(w.message)))
})

test("observations without a session id are ignored", () => {
    const h = build()
    h.tracker.observeStatus(undefined, "idle")
    h.tracker.observeLegacyIdle(undefined)
    h.tracker.observeDeleted(undefined)
    assert.equal(h.pendingTimers(), 0)
})

test("at most one window per session; sessions are independent", () => {
    const h = build()
    h.tracker.observeStatus("s1", "idle")
    h.tracker.observeStatus("s2", "idle")
    assert.equal(h.pendingTimers(), 2)
    h.tracker.observeStatus("s1", "idle")
    assert.equal(h.pendingTimers(), 2, "s1 still has exactly one window")
})

test("LRU cap: the 501st session evicts the oldest and its pending window is cancelled", async () => {
    const h = build()
    trackFires(h)
    h.tracker.observeStatus("ses_0", "idle") // oldest, has a pending window
    for (let index = 1; index <= 500; index++) {
        h.tracker.observeStatus(`ses_${index}`, "busy")
    }
    // ses_0 should be evicted; its timer must have been cleared.
    h.fireTimers()
    await new Promise((resolve) => setTimeout(resolve, 0))
    assert.equal(h.fires.length, 0, "an evicted session's window must not fire")
})

test("an evicted entry's in-flight probe result is discarded (identity guard)", async () => {
    const h = build()
    trackFires(h)
    let resolveProbe!: (value: boolean | null) => void
    h.setProbe(
        () =>
            new Promise<boolean | null>((resolve) => {
                resolveProbe = resolve
            }),
    )
    h.tracker.observeStatus("ses_old", "idle")
    h.fireTimers() // probe in flight for ses_old

    // Evict ses_old by pushing 500 newer sessions through it.
    for (let index = 0; index < 500; index++) {
        h.tracker.observeStatus(`ses_new_${index}`, "busy")
    }

    resolveProbe(false)
    await new Promise((resolve) => setTimeout(resolve, 0))
    assert.equal(h.fires.length, 0, "a probe result for an evicted entry must never fire")
})
