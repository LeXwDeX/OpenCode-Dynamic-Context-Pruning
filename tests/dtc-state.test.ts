import assert from "node:assert/strict"
import test from "node:test"
import { DtcState } from "../lib/dtc/state"

test("context limits are recorded per session and survive re-observation", () => {
    const state = new DtcState()
    state.observeContextLimit("ses_a", 200_000)
    state.observeContextLimit("ses_b", 32_000)
    assert.equal(state.contextTokens("ses_a"), 200_000)
    assert.equal(state.contextTokens("ses_b"), 32_000)
    state.observeContextLimit("ses_a", 128_000)
    assert.equal(state.contextTokens("ses_a"), 128_000)
})

test("invalid context limits are ignored", () => {
    const state = new DtcState()
    state.observeContextLimit("ses_a", undefined)
    state.observeContextLimit("ses_a", Number.NaN)
    state.observeContextLimit("ses_a", -5)
    state.observeContextLimit("", 100)
    assert.equal(state.contextTokens("ses_a"), undefined)
    assert.equal(state.stats().sessions, 0)
})

test("session table is LRU-bounded", () => {
    const state = new DtcState()
    for (let i = 0; i < 600; i++) {
        state.observeContextLimit(`ses_${i}`, 1000)
    }
    assert.ok(state.stats().sessions <= 500)
    assert.equal(state.contextTokens("ses_599"), 1000)
    assert.equal(state.contextTokens("ses_0"), undefined)
})

test("compaction skip is one-shot per session", () => {
    const state = new DtcState()
    state.armCompactionSkip("ses_a")
    assert.equal(state.consumeCompactionSkip("ses_a"), true)
    assert.equal(state.consumeCompactionSkip("ses_a"), false)
    assert.equal(state.consumeCompactionSkip("ses_b"), false)
})

test("boundary marks raise the minimum fold level monotonically", () => {
    const state = new DtcState()
    assert.equal(state.minLevel("ses_a"), 0)
    state.markBoundary("ses_a", 1000, 2)
    assert.equal(state.minLevel("ses_a"), 2)
    assert.equal(state.boundaryMark("ses_a"), 1000)
    state.markBoundary("ses_a", 2000, 3)
    assert.equal(state.minLevel("ses_a"), 3)
    state.markBoundary("ses_a", 3000, 2)
    assert.equal(state.minLevel("ses_a"), 3, "a weaker mark never lowers the level")
    assert.equal(state.boundaryMark("ses_a"), 3000, "the mark timestamp always advances")
})

test("digest cache stores, hits, and is LRU-bounded", () => {
    const state = new DtcState()
    state.storeDigest("k1", "digest-1")
    assert.equal(state.cachedDigest("k1"), "digest-1")
    assert.equal(state.cachedDigest("missing"), undefined)
    for (let i = 0; i < 2500; i++) {
        state.storeDigest(`bulk_${i}`, "d")
    }
    assert.ok(state.stats().digests <= 2000)
    assert.equal(state.cachedDigest("k1"), undefined)
})

test("dropSession clears limits, marks, and skip flags but not digests", () => {
    const state = new DtcState()
    state.observeContextLimit("ses_a", 1000)
    state.markBoundary("ses_a", 5, 2)
    state.armCompactionSkip("ses_a")
    state.storeDigest("k", "d")
    state.dropSession("ses_a")
    assert.equal(state.contextTokens("ses_a"), undefined)
    assert.equal(state.minLevel("ses_a"), 0)
    assert.equal(state.consumeCompactionSkip("ses_a"), false)
    assert.equal(state.cachedDigest("k"), "d")
})
