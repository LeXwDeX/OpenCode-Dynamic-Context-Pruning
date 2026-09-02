import assert from "node:assert/strict"
import test from "node:test"
import { createCommandExecuteHandler } from "../lib/hooks"
import { DtcState } from "../lib/dtc/state"
import { DTC_DEFAULTS } from "../lib/dtc/engine"
import { buildTurns, fakeLogger, fakeOpenCodeClient } from "./fixtures"

function build(messages: unknown[] = []) {
    const state = new DtcState()
    const { client, toasts } = fakeOpenCodeClient({ messages })
    const { logger } = fakeLogger()
    const handler = createCommandExecuteHandler({
        client,
        state,
        config: { ...DTC_DEFAULTS, enabled: true },
        logger,
    })
    return { state, toasts, handler }
}

test("non-dcp commands pass through untouched", async () => {
    const { handler, toasts } = build()
    const result = await handler({ command: "other", sessionID: "ses_1", arguments: "" })
    assert.equal(result, undefined)
    assert.equal(toasts.length, 0)
})

test("/dcp fold marks the deepest boundary and reports via toast", async () => {
    const { state, toasts, handler } = build()
    await assert.rejects(
        () => handler({ command: "dcp", sessionID: "ses_1", arguments: "fold" }),
        /__DCP_FOLD_HANDLED__/,
    )
    assert.equal(state.minLevel("ses_1"), 3)
    assert.ok(state.boundaryMark("ses_1") !== undefined)
    assert.match(toasts[0]!.body.message, /话题边界/)
})

test("/dcp status reports turns, token estimate, and window knowledge", async () => {
    const messages = buildTurns(6, { toolOutputChars: 100 })
    const { state, toasts, handler } = build(messages)
    state.observeContextLimit("ses_1", 200_000)
    await assert.rejects(
        () => handler({ command: "dcp", sessionID: "ses_1", arguments: "status" }),
        /__DCP_STATUS_HANDLED__/,
    )
    const message = toasts[0]!.body.message
    assert.match(message, /对话轮 6/)
    assert.match(message, /尾部保护 4 轮/)
    assert.match(message, /估算 \d+ tokens/)
    assert.match(message, /200,000/)
})

test("/dcp status degrades gracefully when the window is unknown", async () => {
    const { toasts, handler } = build(buildTurns(6))
    await assert.rejects(
        () => handler({ command: "dcp", sessionID: "ses_1", arguments: "status" }),
        /__DCP_STATUS_HANDLED__/,
    )
    assert.match(toasts[0]!.body.message, /窗口未知/)
})

test("unknown subcommands print usage", async () => {
    const { toasts, handler } = build()
    await assert.rejects(
        () => handler({ command: "dcp", sessionID: "ses_1", arguments: "summarize" }),
        /__DCP_HELP_HANDLED__/,
    )
    assert.match(toasts[0]!.body.message, /\/dcp fold/)
    assert.match(toasts[0]!.body.message, /\/dcp status/)
})

test("a failing message fetch never throws out of status", async () => {
    const state = new DtcState()
    const { logger } = fakeLogger()
    const toasts: any[] = []
    const client = {
        session: {
            messages: async () => {
                throw new Error("boom")
            },
        },
        tui: { showToast: async (input: any) => toasts.push(input) },
    }
    const handler = createCommandExecuteHandler({
        client: client as any,
        state,
        config: { ...DTC_DEFAULTS, enabled: true },
        logger,
    })
    await assert.rejects(
        () => handler({ command: "dcp", sessionID: "ses_1", arguments: "status" }),
        /__DCP_STATUS_HANDLED__/,
    )
    assert.match(toasts[0].body.message, /无法读取/)
})
