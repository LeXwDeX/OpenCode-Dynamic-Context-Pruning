import assert from "node:assert/strict"
import test from "node:test"
import { createSessionCompactingHandler } from "../lib/hooks"
import { DtcState } from "../lib/dtc/state"
import { fakeLogger } from "./fixtures"

function build() {
    const state = new DtcState()
    const { logger } = fakeLogger()
    return {
        state,
        handler: createSessionCompactingHandler({ state, logger }),
    }
}

test("compacting hook arms the one-shot DTC skip for the summarizer input", async () => {
    const { state, handler } = build()
    await handler({ sessionID: "ses_arm" })
    assert.equal(state.consumeCompactionSkip("ses_arm"), true)
    assert.equal(state.consumeCompactionSkip("ses_arm"), false, "skip is one-shot")
})

test("compacting hook never touches the host prompt or context (native compaction stays in charge)", async () => {
    const { handler } = build()
    const output = { context: ["host-memory-context"], prompt: undefined as string | undefined }
    await handler({ sessionID: "ses_native" }, output)
    assert.equal(output.prompt, undefined, "the native buildPrompt path must run untouched")
    assert.deepEqual(output.context, ["host-memory-context"])
})

test("compacting hook is safe without an output argument", async () => {
    const { handler } = build()
    await handler({ sessionID: "ses_nooutput" })
})
