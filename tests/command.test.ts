import assert from "node:assert/strict"
import test from "node:test"
import { SessionActivityTracker } from "../lib/activity"
import { createCommandExecuteHandler } from "../lib/hooks"
import { Logger } from "../lib/logger"
import { PruneService } from "../lib/prune-service"
import { MODEL_MESSAGES, fakeOpenCodeClient } from "./fixtures"

interface Ctx {
    client: any
    toasts: unknown[]
    service: PruneService
    calls: Array<{ sessionID: string; model?: unknown }>
    markBusy: (sessionID: string) => void
}

function build(messages: unknown[] = MODEL_MESSAGES): Ctx {
    const toasts: unknown[] = []
    const calls: Array<{ sessionID: string; model?: unknown }> = []
    const { client } = fakeOpenCodeClient({
        messages,
        onToast: (input) => {
            toasts.push(input)
        },
    })
    const summarize = {
        summarize: async (request: any) => {
            calls.push(request)
            return { status: "succeeded" as const }
        },
    } as any
    const activity = new SessionActivityTracker()
    const service = new PruneService({
        client,
        summarize,
        activity,
        logger: new Logger(false),
    })
    return {
        client,
        toasts,
        service,
        calls,
        markBusy: (id) =>
            activity.observe("session.status", { sessionID: id, status: { type: "busy" } }),
    }
}

test("/dcp summarize calls the session-level native summarize entry", async () => {
    const ctx = build()
    const handler = createCommandExecuteHandler(ctx.client, ctx.service, new Logger(false))
    const output = { parts: [{ type: "text", text: "/dcp summarize" }] }

    await assert.rejects(
        handler({ command: "dcp", sessionID: "ses_command", arguments: "summarize" }, output),
        /__DCP_SUMMARIZE_HANDLED__/,
    )

    assert.deepEqual(ctx.calls, [
        {
            sessionID: "ses_command",
            model: { providerID: "anthropic", modelID: "claude-sonnet" },
        },
    ])
    assert.deepEqual(output.parts, [{ type: "text", text: "/dcp summarize" }])
    assert.equal(ctx.toasts.length, 1)
})

test("/dcp summarize refuses to interrupt a busy session", async () => {
    const ctx = build()
    ctx.markBusy("ses_busy")
    const handler = createCommandExecuteHandler(ctx.client, ctx.service, new Logger(false))

    await assert.rejects(
        handler({ command: "dcp", sessionID: "ses_busy", arguments: "summarize" }, { parts: [] }),
        /__DCP_SUMMARIZE_HANDLED__/,
    )

    assert.equal(ctx.calls.length, 0)
    assert.equal(ctx.toasts.length, 1)
})

test("/dcp summarize fails before native compaction when no model exists", async () => {
    const ctx = build([])
    const handler = createCommandExecuteHandler(ctx.client, ctx.service, new Logger(false))

    await assert.rejects(
        handler({ command: "dcp", sessionID: "ses_empty", arguments: "summarize" }, { parts: [] }),
        /__DCP_SUMMARIZE_NO_MODEL__/,
    )

    assert.equal(ctx.calls.length, 0)
    assert.equal(ctx.toasts.length, 1)
})

test("non-DCP commands are untouched", async () => {
    const ctx = build()
    const handler = createCommandExecuteHandler(ctx.client, ctx.service, new Logger(false))
    const output = { parts: [{ type: "text", text: "/other" }] }

    await handler({ command: "other", sessionID: "ses_other", arguments: "" }, output)

    assert.deepEqual(output.parts, [{ type: "text", text: "/other" }])
    assert.equal(ctx.toasts.length, 0)
    assert.equal(ctx.calls.length, 0)
})
