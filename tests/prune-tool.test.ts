import assert from "node:assert/strict"
import test from "node:test"
import { createPruneTool, PRUNE_TOOL_NAME } from "../lib/prune-tool"
import { DtcState } from "../lib/dtc/state"
import { fakeLogger } from "./fixtures"

function build() {
    const state = new DtcState()
    const { logger } = fakeLogger()
    const definition = createPruneTool({ state, logger, now: () => 42_000 }) as any
    return { state, definition }
}

test("the tool is named dcp_prune and takes no arguments", () => {
    const { definition } = build()
    assert.equal(PRUNE_TOOL_NAME, "dcp_prune")
    assert.deepEqual(definition.args, {})
})

test("the tool description promises instant, non-interrupting folding", () => {
    const { definition } = build()
    assert.match(definition.description, /话题.*变更/)
    assert.match(definition.description, /瞬时/)
    assert.match(definition.description, /不打断/)
    assert.ok(!definition.description.includes("排队"), "no queueing semantics remain")
})

test("execute returns instantly, marks the boundary, and deepens folding", async () => {
    const { state, definition } = build()
    const output = await definition.execute({}, { sessionID: "ses_tool" })
    assert.match(output, /话题边界/)
    assert.match(output, /未中断/)
    assert.equal(state.minLevel("ses_tool"), 2)
    assert.equal(state.boundaryMark("ses_tool"), 42_000)
})

test("tool calls never touch a client or session — no async work beyond state", async () => {
    const { definition } = build()
    const t0 = performance.now()
    await definition.execute({}, { sessionID: "ses_fast" })
    assert.ok(performance.now() - t0 < 5, "execute must be synchronous-scale fast")
})

test("marks are isolated per session", async () => {
    const { state, definition } = build()
    await definition.execute({}, { sessionID: "ses_x" })
    assert.equal(state.minLevel("ses_y"), 0)
    assert.equal(state.boundaryMark("ses_y"), undefined)
})
