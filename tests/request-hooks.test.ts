import assert from "node:assert/strict"
import test from "node:test"
import {
    createChatParamsHandler,
    createSessionCompactingHandler,
    createTransformHandler,
} from "../lib/hooks"
import { DtcState } from "../lib/dtc/state"
import { DTC_DEFAULTS } from "../lib/dtc/engine"
import { fakeLogger } from "./fixtures"

function history(modelID = "small"): any[] {
    return [
        {
            info: {
                id: "user_1",
                role: "user",
                sessionID: "ses_a",
                time: { created: 1 },
                model: { providerID: "test", modelID },
            },
            parts: [{ type: "text", id: "p_user", text: "Inspect the source" }],
        },
        ...Array.from({ length: 5 }, (_, index) => ({
            info: {
                id: `assistant_${index}`,
                role: "assistant",
                sessionID: "ses_a",
                time: { created: index + 2, completed: index + 3 },
            },
            parts: [
                {
                    type: "tool",
                    id: `tool_${index}`,
                    callID: `call_${index}`,
                    tool: "read",
                    state: {
                        status: "completed",
                        input: { filePath: `/file-${index}` },
                        output: "evidence ".repeat(1500),
                        time: { start: index + 2, end: index + 3 },
                    },
                },
            ],
        })),
    ]
}

function build() {
    const state = new DtcState()
    const { logger } = fakeLogger()
    let calls = 0
    const client = {
        config: {
            providers: async () => {
                calls++
                return {
                    data: {
                        providers: [
                            {
                                id: "test",
                                models: {
                                    small: {
                                        id: "small",
                                        limit: { context: 16_000, output: 8000 },
                                    },
                                    large: {
                                        id: "large",
                                        limit: { context: 1_000_000, output: 8000 },
                                    },
                                },
                            },
                        ],
                    },
                }
            },
        },
    } as any
    const transform = createTransformHandler({
        state,
        client,
        logger,
        config: {
            ...DTC_DEFAULTS,
            enabled: true,
            protectRecentSteps: 1,
            protectRecentTokens: 0,
            minimumSavingsTokens: 1,
        },
    })
    return {
        state,
        client,
        logger,
        transform,
        params: createChatParamsHandler({ state, logger }),
        compact: createSessionCompactingHandler({ state, logger }),
        calls: () => calls,
    }
}

test("transform uses this request's model and commits into the original host array", async () => {
    const deps = build()
    const large = history("large")
    const largeBefore = structuredClone(large)
    await deps.transform({}, { messages: large })
    assert.deepEqual(large, largeBefore)
    const small = history("small")
    const database = structuredClone(small)
    const output = { messages: small }
    await deps.transform({}, output)
    assert.equal(output.messages, small, "host array identity remains valid")
    assert.ok(small.some((m) => m.parts.some((p: any) => p.state?.time?.compacted)))
    assert.equal(
        database.some((m) => m.parts.some((p: any) => p.state?.time?.compacted)),
        false,
    )
    assert.equal(deps.calls(), 2, "each request resolves its current model")
})

test("host reference markers and cleared attachments preserve normal and forced projection", async () => {
    const changes: Array<(messages: any[]) => void> = [
        (messages) =>
            messages[0].parts.push({
                type: "file",
                mime: "text/plain",
                url: "file:///repo/source.ts",
            }),
        (messages) =>
            messages[0].parts.push({
                type: "file",
                mime: "application/x-directory",
                url: "file:///repo/src",
            }),
        (messages) => messages[0].parts.push({ type: "agent", name: "explore" }),
        (messages) => {
            const state = messages[1].parts[0].state
            state.time.compacted = 999
            state.attachments = [
                { type: "file", mime: "image/png", url: "data:image/png;base64,AAAA" },
            ]
        },
    ]
    for (const change of changes) {
        for (const force of [false, true]) {
            const deps = build()
            const messages = history(force ? "large" : "small")
            change(messages)
            const before = structuredClone(messages)
            const output = { messages }
            if (force) deps.state.requestFold("ses_a")
            await deps.transform({}, output)
            assert.equal(output.messages, messages)
            let newlyFolded = 0
            for (const [index, message] of messages.entries()) {
                for (const [partIndex, part] of message.parts.entries()) {
                    const original = before[index].parts[partIndex]
                    if (part.state?.time?.compacted && !original.state?.time?.compacted) {
                        newlyFolded++
                        delete part.state.time.compacted
                    }
                }
            }
            assert.ok(newlyFolded > 0)
            assert.deepEqual(messages, before, "only new compacted markers may differ")
            assert.equal(deps.state.consumeFold("ses_a"), false)
        }
    }
})

test("one forced normal request survives compaction and does not become permanent", async () => {
    const deps = build()
    deps.state.requestFold("ses_a")
    await deps.compact({ sessionID: "ses_a" })
    const compact = history("large")
    const before = structuredClone(compact)
    await deps.transform({}, { messages: compact })
    assert.deepEqual(compact, before)
    assert.equal(deps.calls(), 0)
    const forced = history("large")
    await deps.transform({}, { messages: forced })
    assert.ok(forced.some((m) => m.parts.some((p: any) => p.state?.time?.compacted)))
    const normal = history("large")
    await deps.transform({}, { messages: normal })
    assert.deepEqual(normal, before)
})

test("compaction params cleans a skip left by an empty or unidentified history", async () => {
    const deps = build()
    await deps.compact({ sessionID: "ses_a" })
    await deps.transform({}, { messages: [] })
    await deps.params({ sessionID: "ses_a", agent: "compaction" })
    assert.equal(deps.state.consumeCompactionSkip("ses_a"), false)
    await deps.compact({ sessionID: "ses_a" })
    await deps.params({ sessionID: "ses_a", agent: "build" })
    assert.equal(deps.state.consumeCompactionSkip("ses_a"), true)
})

test("unidentified or mixed sessions never query providers or mutate messages", async () => {
    const deps = build()
    for (const mixed of [false, true]) {
        const messages = history()
        if (mixed) messages[0].info.sessionID = "other"
        else delete messages[0].info.sessionID
        const before = structuredClone(messages)
        await deps.transform({}, { messages })
        assert.deepEqual(messages, before)
    }
    assert.equal(deps.calls(), 0)
})

test("failed lookup consumes only this normal request's force and leaves the array untouched", async () => {
    const deps = build()
    deps.state.requestFold("ses_a")
    deps.client.config.providers = async () => {
        throw new Error("offline")
    }
    const messages = history()
    const before = structuredClone(messages)
    await deps.transform({}, { messages })
    assert.deepEqual(messages, before)
    assert.equal(deps.state.consumeFold("ses_a"), false)
})

test("unsupported request shapes and unavailable budgets report content-free skip reasons", async () => {
    const deps = build()
    const entries: unknown[] = []
    deps.logger.debug = async (message: string, data: unknown) => {
        entries.push({ message, data })
    }
    const cases = [
        {
            reason: "unidentified-session",
            change: (messages: any[]) => delete messages[0].info.sessionID,
        },
        { reason: "unknown-model", change: (messages: any[]) => delete messages[0].info.model },
        {
            reason: "unavailable-budget",
            change: () => {
                deps.client.config.providers = async () => ({ error: "offline" })
            },
        },
    ]
    for (const item of cases) {
        const messages = history()
        item.change(messages)
        const before = structuredClone(messages)
        await deps.transform({}, { messages })
        assert.deepEqual(messages, before)
        assert.deepEqual(entries.at(-1), {
            message: "DCP request projection skipped",
            data: { reason: item.reason },
        })
    }
    assert.equal(JSON.stringify(entries).includes("evidence"), false)
})

test("a later nonwritable array slot cannot produce a partially committed request", async () => {
    const deps = build()
    const messages = history()
    const originalObjects = [...messages]
    Object.defineProperty(messages, "3", { writable: false })
    await deps.transform({}, { messages })
    for (let i = 0; i < messages.length; i++) assert.equal(messages[i], originalObjects[i])
    assert.equal(deps.calls(), 0)
    const proxy = new Proxy(history(), {
        set() {
            throw new Error("no writes")
        },
    })
    await deps.transform({}, { messages: proxy })
    assert.equal(deps.calls(), 0)
})

test("more than 500 pending compactions cannot expose the oldest summary to projection", async () => {
    const deps = build()
    await deps.compact({ sessionID: "ses_a" })
    for (let i = 0; i < 500; i++) await deps.compact({ sessionID: `other_${i}` })
    const messages = history("small")
    const before = structuredClone(messages)
    await deps.transform({}, { messages })
    assert.deepEqual(messages, before)
    assert.equal(deps.calls(), 0)
    assert.equal(deps.state.stats().blockedReason, "compaction-guard-capacity")
})

test("synchronous and asynchronous diagnostic failures do not change a successful projection", async () => {
    for (const asynchronous of [false, true]) {
        const deps = build()
        const messages = history()
        deps.logger.debug = () => {
            if (asynchronous) return Promise.reject(new Error("injected async logging failure"))
            throw new Error("injected logging failure")
        }
        await deps.transform({}, { messages })
        assert.ok(messages.some((m) => m.parts.some((p: any) => p.state?.time?.compacted)))
    }
})

test("a diagnostic callback that appends a message runs after the complete commit", async () => {
    const deps = build()
    const messages = history()
    const appended = { info: { id: "external", sessionID: "ses_a", role: "assistant" }, parts: [] }
    deps.logger.debug = async () => {
        assert.ok(messages.some((m) => m.parts.some((p: any) => p.state?.time?.compacted)))
        await Promise.resolve()
        messages.push(appended)
    }
    await deps.transform({}, { messages })
    assert.equal(messages.at(-1), appended)
    assert.equal(messages.length, 7)
    assert.ok(messages.every((message) => message !== undefined))
})

test("a model changed during metadata lookup cannot use the previous model's budget", async () => {
    const deps = build()
    const messages = history("small")
    const providers = deps.client.config.providers
    deps.client.config.providers = async () => {
        messages[0].info.model.modelID = "large"
        return providers()
    }
    await deps.transform({}, { messages })
    assert.equal(messages[0].info.model.modelID, "large")
    assert.equal(
        messages.some((m) => m.parts.some((p: any) => p.state?.time?.compacted)),
        false,
    )
})

test("a guard circuit opened during metadata lookup also stops the in-flight projection", async () => {
    const deps = build()
    const messages = history("small")
    const before = structuredClone(messages)
    const providers = deps.client.config.providers
    deps.client.config.providers = async () => {
        for (let i = 0; i < 501; i++) deps.state.armCompactionSkip(`overflow_${i}`)
        return providers()
    }
    await deps.transform({}, { messages })
    assert.deepEqual(messages, before)
    assert.equal(deps.state.projectionBlockReason(), "compaction-guard-capacity")
})
