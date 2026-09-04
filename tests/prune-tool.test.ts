import assert from "node:assert/strict"
import test from "node:test"
import { createPruneTool, PRUNE_TOOL_NAME } from "../lib/prune-tool"
import { DtcState } from "../lib/dtc/state"
import { fakeLogger } from "./fixtures"

function build() {
    const state = new DtcState()
    const { logger } = fakeLogger()
    return { state, definition: createPruneTool({ state, logger }) as any }
}

test("the model tool has no arguments and accurately describes one-request behavior", () => {
    const { definition } = build()
    assert.equal(PRUNE_TOOL_NAME, "dcp_prune")
    assert.deepEqual(definition.args, {})
    assert.match(definition.description, /只生效一次/)
    assert.match(definition.description, /预算.*保持原样/)
})

test("a tool call marks exactly one request without a client or history mutation", async () => {
    const { state, definition } = build()
    const result = await definition.execute({}, { sessionID: "ses_a" })
    assert.match(result, /仅生效一次/)
    assert.equal(state.consumeFold("ses_b"), false)
    assert.equal(state.consumeFold("ses_a"), true)
    assert.equal(state.consumeFold("ses_a"), false)
})

test("an unidentified tool call reports that it did not mark a request", async () => {
    const { state, definition } = build()
    const result = await definition.execute({}, { sessionID: "" })
    assert.match(result, /未设置/)
    assert.equal(state.stats().sessions, 0)
})

test("the tool reports a tripped guard circuit instead of pretending to schedule folding", async () => {
    const { state, definition } = build()
    for (let i = 0; i < 501; i++) state.armCompactionSkip(`ses_${i}`)
    const result = await definition.execute({}, { sessionID: "normal" })
    assert.match(result, /本实例已停止折叠/)
    assert.match(result, /未设置/)
    assert.equal(state.consumeFold("normal"), false)
})
