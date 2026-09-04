import assert from "node:assert/strict"
import test from "node:test"
import { DtcState } from "../lib/dtc/state"

test("force folding is consumed once and isolated by session", () => {
    const state = new DtcState()
    state.requestFold("ses_a")
    assert.equal(state.consumeFold("ses_b"), false)
    assert.equal(state.consumeFold("ses_a"), true)
    assert.equal(state.consumeFold("ses_a"), false)
    assert.equal(state.stats().sessions, 0)
})

test("compaction skips never consume a pending normal-request fold", () => {
    const state = new DtcState()
    state.requestFold("ses_a")
    state.armCompactionSkip("ses_a")
    assert.equal(state.consumeCompactionSkip("ses_a"), true)
    assert.equal(state.consumeCompactionSkip("ses_a"), false)
    assert.equal(state.consumeFold("ses_a"), true)
})

test("compaction cleanup and deletion remove only the matching state", () => {
    const state = new DtcState()
    state.armCompactionSkip("ses_a")
    state.requestFold("ses_a")
    state.armCompactionSkip("ses_b")
    state.clearCompactionSkip("ses_a")
    assert.equal(state.consumeCompactionSkip("ses_a"), false)
    assert.equal(state.consumeFold("ses_a"), true)
    state.dropSession("ses_b")
    assert.equal(state.consumeCompactionSkip("ses_b"), false)
    assert.equal(state.stats().sessions, 0)
})

test("pending state is bounded and repeated marks refresh recency", () => {
    const state = new DtcState()
    for (let i = 0; i < 500; i++) state.requestFold(`ses_${i}`)
    state.requestFold("ses_0")
    state.requestFold("ses_500")
    assert.equal(state.stats().sessions, 500)
    assert.equal(state.consumeFold("ses_0"), true)
    assert.equal(state.consumeFold("ses_1"), false)
    state.requestFold("")
    state.armCompactionSkip("")
    assert.equal(state.consumeFold(""), false)
})

test("force requests may be evicted but a pending compaction guard is never evicted", () => {
    const state = new DtcState()
    state.armCompactionSkip("protected")
    for (let i = 0; i < 499; i++) state.requestFold(`force_${i}`)
    state.requestFold("new_force")
    assert.equal(state.consumeCompactionSkip("protected"), true)
    assert.equal(state.consumeFold("force_0"), false)
    assert.equal(state.projectionBlockReason(), undefined)
})

test("exhausting guard capacity blocks projection for the lifetime of this instance", () => {
    const state = new DtcState()
    for (let i = 0; i < 500; i++) state.armCompactionSkip(`ses_${i}`)
    assert.equal(state.requestFold("force_without_space"), false)
    assert.equal(state.projectionBlockReason(), undefined)
    state.armCompactionSkip("ses_overflow")
    assert.equal(state.stats().sessions, 500)
    assert.equal(state.stats().blockedReason, "compaction-guard-capacity")
    assert.equal(state.consumeCompactionSkip("ses_0"), true)
    state.dropSession("ses_1")
    assert.equal(state.projectionBlockReason(), "compaction-guard-capacity")
    assert.equal(state.requestFold("future_force"), false)
})

test("normal guard consumption reuses bounded capacity without tripping the circuit", () => {
    const state = new DtcState()
    for (let i = 0; i < 2000; i++) {
        state.armCompactionSkip(`ses_${i}`)
        assert.equal(state.consumeCompactionSkip(`ses_${i}`), true)
        state.requestFold(`ses_${i}`)
        assert.equal(state.consumeFold(`ses_${i}`), true)
    }
    assert.equal(state.stats().sessions, 0)
    assert.equal(state.projectionBlockReason(), undefined)
})
