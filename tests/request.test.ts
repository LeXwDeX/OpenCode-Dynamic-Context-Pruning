import assert from "node:assert/strict"
import test from "node:test"
import { setTimeout as delay } from "node:timers/promises"
import { inputBudgetFor, modelFor, sessionIDFor } from "../lib/request"

function user(created: number, modelID = "large", id = `msg_${created}`) {
    return {
        info: {
            id,
            sessionID: "ses_a",
            role: "user",
            time: { created },
            model: { providerID: "test", modelID },
        },
        parts: [{ type: "text", text: "continue" }],
    }
}

function providerClient(data: unknown) {
    return { config: { providers: async () => ({ data }) } } as any
}

test("session identity must be explicit and consistent for every message", () => {
    assert.equal(sessionIDFor([user(1), user(2)]), "ses_a")
    assert.equal(sessionIDFor([]), undefined)
    assert.equal(sessionIDFor([user(1), { info: { role: "assistant" }, parts: [] }]), undefined)
    assert.equal(
        sessionIDFor([user(1), { ...user(2), info: { ...user(2).info, sessionID: "ses_b" } }]),
        undefined,
    )
})

test("model selection follows user creation order rather than reordered history", () => {
    const compaction = { ...user(99, "summary"), parts: [{ type: "compaction" }] }
    assert.deepEqual(modelFor([user(20, "small"), compaction, user(1, "large")]), {
        providerID: "test",
        modelID: "small",
    })
    assert.equal(
        modelFor([user(10, "large", "msg_b"), user(10, "small", "msg_c")])?.modelID,
        "small",
    )
    assert.equal(modelFor([{ info: { role: "user" }, parts: [] }]), undefined)
})

test("current model resolves against the SDK configured-provider response", async () => {
    const client = providerClient({
        providers: [
            {
                id: "test",
                models: {
                    large: { id: "large", limit: { context: 1_000_000, output: 64_000 } },
                    small: { id: "small", limit: { context: 32_000, input: 20_000, output: 8000 } },
                },
            },
        ],
    })
    assert.equal(
        await inputBudgetFor(client, { providerID: "test", modelID: "large" }, 32_000),
        968_000,
    )
    assert.equal(
        await inputBudgetFor(client, { providerID: "test", modelID: "small" }, 32_000),
        20_000,
    )
    assert.equal(await inputBudgetFor(client, { providerID: "test", modelID: "absent" }), undefined)
})

test("unknown or ambiguous provider data never becomes a guessed budget", async () => {
    const model = { providerID: "test", modelID: "small" }
    const provider = {
        id: "test",
        models: { small: { id: "small", limit: { context: 32_000, output: 8000 } } },
    }
    for (const data of [
        undefined,
        {},
        { providers: {} },
        { providers: [provider, provider] },
        {
            providers: [
                {
                    ...provider,
                    models: { small: { id: "other", limit: { context: 32_000, output: 8000 } } },
                },
            ],
        },
    ]) {
        assert.equal(await inputBudgetFor(providerClient(data), model), undefined)
    }
    for (const limit of [
        { context: 32_000 },
        { context: 0, output: 8000 },
        { context: 32_000, output: 0 },
        { context: 32_000, output: 8000, input: -1 },
        { context: 4000, output: 8000 },
    ]) {
        assert.equal(
            await inputBudgetFor(
                providerClient({
                    providers: [{ id: "test", models: { small: { id: "small", limit } } }],
                }),
                model,
            ),
            undefined,
        )
    }
    const failing = {
        config: {
            providers: async () => {
                throw new Error("offline")
            },
        },
    } as any
    assert.equal(await inputBudgetFor(failing, model), undefined)
    const partial = {
        config: {
            providers: async () => ({
                data: { providers: [provider] },
                error: { message: "partial response" },
            }),
        },
    } as any
    assert.equal(await inputBudgetFor(partial, model), undefined)
})

test("metadata lookup supplies an abort deadline and fails open on fetch cancellation", async () => {
    const started = Date.now()
    const client = {
        config: {
            providers: async (options: { signal: AbortSignal }) => {
                assert.ok(options.signal instanceof AbortSignal)
                await delay(10_000, undefined, { signal: options.signal })
                throw new Error("deadline was not applied")
            },
        },
    } as any
    assert.equal(await inputBudgetFor(client, { providerID: "test", modelID: "small" }), undefined)
    assert.ok(Date.now() - started < 5000, "the request must not wait for the metadata service")
})
