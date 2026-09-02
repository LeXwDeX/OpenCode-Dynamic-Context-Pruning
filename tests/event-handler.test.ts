import assert from "node:assert/strict"
import test from "node:test"
import { AutoPruner } from "../lib/auto-prune"
import type { AutoPruneConfig } from "../lib/config"
import { createAtRestAutoPruneListener, createEventHandler } from "../lib/hooks"
import { Logger } from "../lib/logger"
import { PruneService } from "../lib/prune-service"
import { MODEL_MESSAGES, drainUntil, fakeOpenCodeClient, textParts } from "./fixtures"

function config(overrides: Partial<AutoPruneConfig> = {}): AutoPruneConfig {
    return {
        enabled: true,
        signals: { topicDrift: true, volume: true, idleGap: true },
        minMessages: 1,
        volumeThreshold: 2,
        driftThreshold: 0.18,
        idleGapMs: 60_000,
        cooldownMs: 0,
        ...overrides,
    }
}

interface Harness {
    handler: ReturnType<typeof createEventHandler>
    service: PruneService
    client: any
    calls: Array<{ sessionID: string; model?: unknown }>
    toasts: unknown[]
    autoPruner: AutoPruner
    setSummarizeResult: (result: unknown) => void
    /** Fire the armed quiet-window timers (drives windows to at-rest). */
    reachBoundary: () => Promise<void>
}

function build(): Harness {
    const harness: Harness = {
        calls: [],
        toasts: [],
        autoPruner: new AutoPruner(config()),
        service: null as never,
        handler: null as never,
        client: null as never,
        setSummarizeResult: null as never,
        reachBoundary: null as never,
    }
    const summarizeState: { result: unknown } = { result: { status: "succeeded" } }
    const { client } = fakeOpenCodeClient({
        messages: MODEL_MESSAGES,
        onToast: (input) => {
            harness.toasts.push(input)
        },
    })
    const summarize = {
        summarize: async (request: any) => {
            harness.calls.push(request)
            return summarizeState.result
        },
    } as any
    let handle = 0
    const timers = new Map<number, () => void>()
    const service = new PruneService({
        client,
        summarize,
        logger: new Logger(false),
        setTimer: (fn: () => void, ms: number) => {
            handle += 1
            timers.set(handle, fn)
            return handle
        },
        clearTimer: (t: unknown) => {
            timers.delete(t as number)
        },
    })
    harness.service = service
    harness.client = client
    harness.setSummarizeResult = (result) => {
        summarizeState.result = result
    }
    service.boundary.onAtRest(
        createAtRestAutoPruneListener({
            client,
            prune: service,
            autoPruner: harness.autoPruner,
            config: config(),
            logger: new Logger(false),
        }),
    )
    harness.handler = createEventHandler({
        prune: service,
        autoPruner: harness.autoPruner,
        logger: new Logger(false),
    })
    harness.reachBoundary = async () => {
        const fns = [...timers.values()]
        timers.clear()
        for (const fn of fns) fn()
        for (let index = 0; index < 50; index++) {
            await Promise.resolve()
        }
    }
    return harness
}

function idle(sessionID: string) {
    return { event: { type: "session.idle", properties: { sessionID } } }
}

function status(sessionID: string, type: string) {
    return { event: { type: "session.status", properties: { sessionID, status: { type } } } }
}

test("an at-rest boundary consumes pending signals and triggers native compaction", async () => {
    const h = build()
    h.autoPruner.observeUserMessage("ses_idle", textParts("一"), 0)
    h.autoPruner.observeUserMessage("ses_idle", textParts("二"), 1000)

    await h.handler(idle("ses_idle"))
    await h.reachBoundary()
    await drainUntil(() => h.calls.length > 0)

    assert.equal(h.calls.length, 1)
    assert.deepEqual(h.calls[0].model, { providerID: "anthropic", modelID: "claude-sonnet" })
    assert.equal(h.toasts.length, 1)
})

test("at-rest without pending signals does not compact", async () => {
    const h = build()
    h.autoPruner.observeUserMessage("ses_quiet", textParts("只有一条"), 0)

    await h.handler(idle("ses_quiet"))
    await h.reachBoundary()

    assert.equal(h.calls.length, 0)
    assert.equal(h.toasts.length, 0)
})

test("a busy turn starting during the quiet window cancels the boundary (relay idle)", async () => {
    const h = build()
    h.autoPruner.observeUserMessage("ses_relay", textParts("一"), 0)
    h.autoPruner.observeUserMessage("ses_relay", textParts("二"), 1000)

    await h.handler(idle("ses_relay"))
    await h.handler(status("ses_relay", "busy"))
    await h.reachBoundary()

    assert.equal(h.calls.length, 0)
    assert.equal(h.toasts.length, 0, "a cancelled boundary never consumes signals")
    // Signals survive for the next real at-rest boundary.
    assert.ok(h.autoPruner.consumePending("ses_relay"))
})

test("auto prune stands down when a new turn starts before the summarize fires", async () => {
    const h = build()
    h.autoPruner.observeUserMessage("ses_race", textParts("一"), 0)
    h.autoPruner.observeUserMessage("ses_race", textParts("二"), 1000)

    let resolveMessages!: (value: unknown) => void
    const gate = new Promise((resolve) => {
        resolveMessages = resolve
    })
    h.client.session.messages = async () => gate

    await h.handler(idle("ses_race"))
    await h.reachBoundary()
    // The at-rest listener is now resolving the model; flip busy mid-flight.
    h.service.observeEvent("session.status", {
        sessionID: "ses_race",
        status: { type: "busy" },
    })
    resolveMessages({ data: MODEL_MESSAGES })
    await drainUntil(() => h.toasts.length > 0)

    assert.equal(h.calls.length, 0)
    assert.equal(h.toasts.length, 1)
    assert.match(String((h.toasts[0] as { body: { message: string } }).body.message), /正忙/)
})

test("an at-rest boundary after busy evidence still compacts", async () => {
    const h = build()
    h.autoPruner.observeUserMessage("ses_wrap", textParts("一"), 0)
    h.autoPruner.observeUserMessage("ses_wrap", textParts("二"), 1000)

    await h.handler(status("ses_wrap", "busy"))
    await h.handler(status("ses_wrap", "idle"))
    await h.reachBoundary()
    await drainUntil(() => h.calls.length > 0)

    assert.equal(h.calls.length, 1)
    assert.equal(h.toasts.length, 1)
})

test("events feed the prune service so deferred tool prunes drain on at-rest", async () => {
    const h = build()
    await h.service.request({ sessionID: "ses_defer", onBusy: "defer" })
    assert.equal(h.calls.length, 0)

    await h.handler(idle("ses_defer"))
    await h.reachBoundary()
    await drainUntil(() => h.calls.length > 0)

    assert.equal(h.calls.length, 1)
    assert.deepEqual(h.calls[0].model, { providerID: "anthropic", modelID: "claude-sonnet" })
})

test("failed auto prune still warns and resets pending state", async () => {
    const h = build()
    h.autoPruner.observeUserMessage("ses_fail", textParts("一"), 0)
    h.autoPruner.observeUserMessage("ses_fail", textParts("二"), 1000)
    h.setSummarizeResult({ status: "failed", error: "boom" })

    await h.handler(idle("ses_fail"))
    await h.reachBoundary()
    await drainUntil(() => h.calls.length > 0)
    await h.handler(idle("ses_fail"))
    await h.reachBoundary()

    assert.equal(h.calls.length, 1)
    assert.equal(h.toasts.length, 1)
})

test("session.compacted marks the session pruned without calling summarize", async () => {
    const h = build()
    h.autoPruner.observeUserMessage("ses_compact", textParts("一"), 0)
    h.autoPruner.observeUserMessage("ses_compact", textParts("二"), 1000)

    await h.handler({
        event: { type: "session.compacted", properties: { sessionID: "ses_compact" } },
    })
    await h.handler(idle("ses_compact"))
    await h.reachBoundary()

    assert.equal(h.calls.length, 0)
})

test("session.deleted drops heuristic state from the SDK info shape", async () => {
    const h = build()
    h.autoPruner.observeUserMessage("ses_gone", textParts("一"), 0)
    h.autoPruner.observeUserMessage("ses_gone", textParts("二"), 1000)

    await h.handler({
        event: { type: "session.deleted", properties: { info: { id: "ses_gone" } } },
    })

    assert.equal(h.autoPruner.consumePending("ses_gone"), null)
    await h.handler(idle("ses_gone"))
    await h.reachBoundary()
    assert.equal(h.calls.length, 0, "dropped state must not compact later")
})

test("session.deleted also understands the legacy sessionID shape", async () => {
    const h = build()
    h.autoPruner.observeUserMessage("ses_legacy", textParts("一"), 0)
    h.autoPruner.observeUserMessage("ses_legacy", textParts("二"), 1000)

    await h.handler({
        event: { type: "session.deleted", properties: { sessionID: "ses_legacy" } },
    })

    assert.equal(h.autoPruner.consumePending("ses_legacy"), null)
    await h.handler(idle("ses_legacy"))
    await h.reachBoundary()
    assert.equal(h.calls.length, 0)
})

test("a throwing prune.observeEvent does not reject the event handler", async () => {
    const warnMessages: string[] = []
    const handler = createEventHandler({
        prune: {
            observeEvent: () => {
                throw new Error("observe exploded")
            },
            request: async () => ({ status: "succeeded" }),
        } as any,
        autoPruner: new AutoPruner(config()),
        logger: {
            debug: () => {},
            warn: (message: string) => {
                warnMessages.push(message)
            },
        } as any,
    })

    await handler(idle("ses_throw"))

    assert.ok(warnMessages.some((message) => /Event handler failed/.test(message)))
})

test("T3 degrade: consecutive turn-end idles each drain their boundary", async () => {
    const h = build()
    await h.service.request({ sessionID: "ses_t3", onBusy: "defer" })

    // Turn 1: legacy idle only (no status events ever) -> at-rest -> drain.
    await h.handler(idle("ses_t3"))
    await h.reachBoundary()
    await drainUntil(() => h.calls.length > 0)
    assert.equal(h.calls.length, 1)

    // Turn 2: another deferred prune must drain on the next legacy idle too.
    await h.service.request({ sessionID: "ses_t3", onBusy: "defer" })
    await h.handler(idle("ses_t3"))
    await h.reachBoundary()
    await drainUntil(() => h.calls.length > 1)
    assert.equal(h.calls.length, 2, "no permanent stall on status-less hosts (B-1)")
})

test("a busy probe skip keeps the signals pending for the next at-rest", async () => {
    const h = build()
    h.autoPruner.observeUserMessage("ses_consumed", textParts("一"), 0)
    h.autoPruner.observeUserMessage("ses_consumed", textParts("二"), 1000)

    // The expiry probe reports busy: relay idle, boundary cancelled, no toast.
    h.client.session.status = async () => ({ data: { ses_consumed: { type: "busy" } } })
    await h.handler(idle("ses_consumed"))
    await h.reachBoundary()
    assert.equal(h.calls.length, 0)
    assert.equal(h.toasts.length, 0, "a cancelled boundary is silent")
    assert.ok(h.autoPruner.consumePending("ses_consumed"), "signals were not consumed")

    // The next real at-rest boundary consumes and executes them.
    h.client.session.status = async () => ({ data: {} })
    h.autoPruner.observeUserMessage("ses_consumed", textParts("三"), 2000)
    await h.handler(idle("ses_consumed"))
    await h.reachBoundary()
    await drainUntil(() => h.calls.length > 0)
    assert.equal(h.calls.length, 1)
})

test("the at-rest auto-prune listener checks its enabled gate at the mount point", async () => {
    const { client } = fakeOpenCodeClient({ messages: MODEL_MESSAGES })
    const requests: unknown[] = []
    const service = {
        request: async (request: unknown) => {
            requests.push(request)
            return { status: "succeeded" }
        },
        boundary: { onAtRest: () => {} },
    } as any
    const autoPruner = new AutoPruner(config())
    autoPruner.observeUserMessage("ses_gate", textParts("一"), 0)
    autoPruner.observeUserMessage("ses_gate", textParts("二"), 1000)

    const listener = createAtRestAutoPruneListener({
        client,
        prune: service,
        autoPruner,
        config: config({ enabled: false }),
        logger: new Logger(false),
    })
    await listener("ses_gate", "window-expired")

    assert.equal(requests.length, 0, "a disabled auto prune never fires at at-rest")
})

test("unrelated events are ignored", async () => {
    const h = build()
    await h.handler({ event: { type: "message.updated", properties: {} } })
    await h.handler({ event: { type: "session.idle", properties: {} } })
    await h.reachBoundary()
    assert.equal(h.calls.length, 0)
})
