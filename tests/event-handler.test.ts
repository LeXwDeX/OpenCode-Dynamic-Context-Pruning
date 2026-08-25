import assert from "node:assert/strict"
import test from "node:test"
import { AutoPruner } from "../lib/auto-prune"
import type { AutoPruneConfig } from "../lib/config"
import { createEventHandler } from "../lib/hooks"
import { Logger } from "../lib/logger"

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
    calls: Array<{ sessionID: string; model?: unknown }>
    toasts: unknown[]
    autoPruner: AutoPruner
    summarizeResult: { status: "succeeded" | "failed"; error?: string }
}

function build(): Harness {
    const harness: Harness = {
        calls: [],
        toasts: [],
        autoPruner: new AutoPruner(config()),
        summarizeResult: { status: "succeeded" },
        handler: null as never,
    }
    const deps = {
        client: {
            session: {
                messages: async () => ({
                    data: [
                        {
                            info: {
                                role: "user",
                                model: { providerID: "anthropic", modelID: "claude-sonnet" },
                            },
                        },
                    ],
                }),
            },
            tui: {
                showToast: async (input: unknown) => {
                    harness.toasts.push(input)
                },
            },
        } as any,
        summarize: {
            summarize: async (request: any) => {
                harness.calls.push(request)
                return harness.summarizeResult
            },
        } as any,
        autoPruner: harness.autoPruner,
        config: config(),
        logger: new Logger(false),
    }
    harness.handler = createEventHandler(deps)
    return harness
}

function textParts(text: string): unknown[] {
    return [{ type: "text", text }]
}

test("session.idle consumes pending signals and triggers native compaction", async () => {
    const h = build()
    h.autoPruner.observeUserMessage("ses_idle", textParts("一"), 0)
    h.autoPruner.observeUserMessage("ses_idle", textParts("二"), 1000)

    await h.handler({ event: { type: "session.idle", properties: { sessionID: "ses_idle" } } })

    assert.equal(h.calls.length, 1)
    assert.deepEqual(h.calls[0].model, { providerID: "anthropic", modelID: "claude-sonnet" })
    assert.equal(h.toasts.length, 1)
})

test("idle without pending signals does not compact", async () => {
    const h = build()
    h.autoPruner.observeUserMessage("ses_quiet", textParts("只有一条"), 0)

    await h.handler({ event: { type: "session.idle", properties: { sessionID: "ses_quiet" } } })

    assert.equal(h.calls.length, 0)
    assert.equal(h.toasts.length, 0)
})

test("failed auto prune still warns and resets pending state", async () => {
    const h = build()
    h.summarizeResult = { status: "failed", error: "boom" }
    h.autoPruner.observeUserMessage("ses_fail", textParts("一"), 0)
    h.autoPruner.observeUserMessage("ses_fail", textParts("二"), 1000)

    await h.handler({ event: { type: "session.idle", properties: { sessionID: "ses_fail" } } })
    await h.handler({ event: { type: "session.idle", properties: { sessionID: "ses_fail" } } })

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
    await h.handler({ event: { type: "session.idle", properties: { sessionID: "ses_compact" } } })

    assert.equal(h.calls.length, 0)
})

test("session.deleted drops heuristic state", async () => {
    const h = build()
    await h.handler({
        event: { type: "session.deleted", properties: { sessionID: "ses_gone" } },
    })
    assert.equal(h.autoPruner.consumePending("ses_gone"), null)
})

test("unrelated events are ignored", async () => {
    const h = build()
    await h.handler({ event: { type: "message.updated", properties: {} } })
    await h.handler({ event: { type: "session.idle", properties: {} } })
    assert.equal(h.calls.length, 0)
})
