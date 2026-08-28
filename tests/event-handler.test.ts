import assert from "node:assert/strict"
import test from "node:test"
import { SessionActivityTracker } from "../lib/activity"
import { AutoPruner } from "../lib/auto-prune"
import type { AutoPruneConfig } from "../lib/config"
import { createEventHandler } from "../lib/hooks"
import { Logger } from "../lib/logger"
import { PruneService } from "../lib/prune-service"
import { MODEL_MESSAGES, drainUntil, fakeOpenCodeClient, textParts } from "./fixtures"

function config(overrides: Partial<AutoPruneConfig> = {}): AutoPruneConfig {
    return {
        enabled: true,
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
    const service = new PruneService({
        client,
        summarize,
        activity: new SessionActivityTracker(),
        logger: new Logger(false),
    })
    harness.service = service
    harness.client = client
    harness.setSummarizeResult = (result) => {
        summarizeState.result = result
    }
    harness.handler = createEventHandler({
        client,
        prune: service,
        autoPruner: harness.autoPruner,
        config: config(),
        logger: new Logger(false),
    })
    return harness
}

function idle(sessionID: string) {
    return { event: { type: "session.idle", properties: { sessionID } } }
}

test("session.idle consumes pending signals and triggers native compaction", async () => {
    const h = build()
    h.autoPruner.observeUserMessage("ses_idle", textParts("一"), 0)
    h.autoPruner.observeUserMessage("ses_idle", textParts("二"), 1000)

    await h.handler(idle("ses_idle"))

    assert.equal(h.calls.length, 1)
    assert.deepEqual(h.calls[0].model, { providerID: "anthropic", modelID: "claude-sonnet" })
    assert.equal(h.toasts.length, 1)
})

test("idle without pending signals does not compact", async () => {
    const h = build()
    h.autoPruner.observeUserMessage("ses_quiet", textParts("只有一条"), 0)

    await h.handler(idle("ses_quiet"))

    assert.equal(h.calls.length, 0)
    assert.equal(h.toasts.length, 0)
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

    const running = h.handler(idle("ses_race"))
    h.service.observeEvent("session.status", {
        sessionID: "ses_race",
        status: { type: "busy" },
    })
    resolveMessages({ data: MODEL_MESSAGES })
    await running

    assert.equal(h.calls.length, 0)
    assert.equal(h.toasts.length, 1)
    assert.match(String((h.toasts[0] as { body: { message: string } }).body.message), /正忙/)
})

test("an idle event after busy evidence still compacts at the turn boundary", async () => {
    const h = build()
    h.autoPruner.observeUserMessage("ses_wrap", textParts("一"), 0)
    h.autoPruner.observeUserMessage("ses_wrap", textParts("二"), 1000)

    await h.handler({
        event: {
            type: "session.status",
            properties: { sessionID: "ses_wrap", status: { type: "busy" } },
        },
    })
    await h.handler(idle("ses_wrap"))

    assert.equal(h.calls.length, 1)
    assert.equal(h.toasts.length, 1)
})

test("events feed the prune service so deferred tool prunes drain on idle", async () => {
    const h = build()
    await h.service.request({ sessionID: "ses_defer", onBusy: "defer" })
    assert.equal(h.calls.length, 0)

    await h.handler(idle("ses_defer"))
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
    await h.handler(idle("ses_fail"))

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
    assert.equal(h.calls.length, 0)
})

test("a throwing prune.observeEvent does not reject the event handler", async () => {
    const warnMessages: string[] = []
    const requests: unknown[] = []
    const { client } = fakeOpenCodeClient({ messages: MODEL_MESSAGES })
    const handler = createEventHandler({
        client,
        prune: {
            observeEvent: () => {
                throw new Error("observe exploded")
            },
            request: async (request: unknown) => {
                requests.push(request)
                return { status: "succeeded" }
            },
        } as any,
        autoPruner: new AutoPruner(config()),
        config: config(),
        logger: {
            debug: () => {},
            warn: (message: string) => {
                warnMessages.push(message)
            },
        } as any,
    })

    await handler(idle("ses_throw"))

    assert.ok(warnMessages.some((message) => /Event handler failed/.test(message)))
    assert.equal(requests.length, 0)
})

test("a busy-skipped auto prune does not retry its consumed signals on the next idle", async () => {
    const h = build()
    h.autoPruner.observeUserMessage("ses_consumed", textParts("一"), 0)
    h.autoPruner.observeUserMessage("ses_consumed", textParts("二"), 1000)
    h.client.session.status = async () => ({ data: { ses_consumed: { type: "busy" } } })

    await h.handler(idle("ses_consumed"))
    assert.equal(h.calls.length, 0)
    assert.equal(h.toasts.length, 1, "the busy skip is surfaced to the user")

    h.client.session.status = async () => ({ data: {} })
    await h.handler(idle("ses_consumed"))
    assert.equal(h.calls.length, 0, "consumed signals are gone; new signals come from new messages")
})

test("unrelated events are ignored", async () => {
    const h = build()
    await h.handler({ event: { type: "message.updated", properties: {} } })
    await h.handler({ event: { type: "session.idle", properties: {} } })
    assert.equal(h.calls.length, 0)
})
