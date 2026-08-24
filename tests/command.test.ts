import assert from "node:assert/strict"
import test from "node:test"
import { createCommandExecuteHandler } from "../lib/hooks"
import { Logger } from "../lib/logger"

function client(messages: unknown[]) {
    const toasts: unknown[] = []
    return {
        value: {
            session: { messages: async () => ({ data: messages }) },
            tui: {
                showToast: async (input: unknown) => {
                    toasts.push(input)
                },
            },
        } as any,
        toasts,
    }
}

test("/dcp summarize calls the session-level native summarize entry", async () => {
    const ctx = client([
        {
            info: {
                role: "user",
                model: { providerID: "anthropic", modelID: "claude-sonnet" },
            },
        },
    ])
    const calls: unknown[] = []
    const summarize = {
        summarize: async (request: unknown) => {
            calls.push(request)
            return { status: "succeeded" as const }
        },
    }
    const handler = createCommandExecuteHandler(ctx.value, summarize as any, new Logger(false))
    const output = { parts: [{ type: "text", text: "/dcp summarize" }] }

    await assert.rejects(
        handler({ command: "dcp", sessionID: "ses_command", arguments: "summarize" }, output),
        /__DCP_SUMMARIZE_HANDLED__/,
    )

    assert.deepEqual(calls, [
        {
            sessionID: "ses_command",
            model: { providerID: "anthropic", modelID: "claude-sonnet" },
        },
    ])
    assert.deepEqual(output.parts, [{ type: "text", text: "/dcp summarize" }])
    assert.equal(ctx.toasts.length, 1)
})

test("/dcp summarize fails before native compaction when no model exists", async () => {
    const ctx = client([])
    let calls = 0
    const summarize = {
        summarize: async () => {
            calls++
            return { status: "succeeded" as const }
        },
    }
    const handler = createCommandExecuteHandler(ctx.value, summarize as any, new Logger(false))

    await assert.rejects(
        handler({ command: "dcp", sessionID: "ses_empty", arguments: "summarize" }, { parts: [] }),
        /__DCP_SUMMARIZE_NO_MODEL__/,
    )

    assert.equal(calls, 0)
    assert.equal(ctx.toasts.length, 1)
})

test("non-DCP commands are untouched", async () => {
    const ctx = client([])
    const handler = createCommandExecuteHandler(
        ctx.value,
        { summarize: async () => ({ status: "succeeded" as const }) } as any,
        new Logger(false),
    )
    const output = { parts: [{ type: "text", text: "/other" }] }

    await handler({ command: "other", sessionID: "ses_other", arguments: "" }, output)

    assert.deepEqual(output.parts, [{ type: "text", text: "/other" }])
    assert.equal(ctx.toasts.length, 0)
})
