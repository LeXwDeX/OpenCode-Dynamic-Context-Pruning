import assert from "node:assert/strict"
import test from "node:test"
import { offTopicMiddleTurns } from "../lib/dtc/digest"
import { DTC_DEFAULTS, transformMessages } from "../lib/dtc/engine"
import { DtcState } from "../lib/dtc/state"
import type { MessageLike, Turn } from "../lib/dtc/types"
import {
    buildTurns,
    deepCloneMessages,
    fakeLogger,
    reasoningPart,
    textPart,
    toolPart,
} from "./fixtures"

// Issue #27: middle-zone turns topically discontinuous with the current-task
// C-zone deepen to the distant mechanical digest treatment. The off-topic
// fixture shares zero CJK bigrams with the buildTurns template (Jaccard 0
// against every C-zone union reference; template-vs-template stays ~0.5,
// far above the 0.18 drift threshold).
const OFFTOPIC = "东京五日游行程安排，浅草寺和涩谷十字路口都要去，还要去上野公园看樱花"

function harness(options: { contextTokens?: number; config?: Partial<typeof DTC_DEFAULTS> } = {}) {
    const state = new DtcState()
    if (options.contextTokens !== undefined) {
        state.observeContextLimit("ses_test", options.contextTokens)
    }
    const { logger } = fakeLogger()
    return {
        state,
        config: { ...DTC_DEFAULTS, ...options.config },
        logger,
        run: (messages: MessageLike[]) =>
            transformMessages(messages, {
                state,
                config: { ...DTC_DEFAULTS, ...options.config },
                logger,
                now: () => 1_700_000_000_000,
            }),
    }
}

/** Replaces the opening user text of head-turn ordinals with the off-topic fixture. */
function makeOffTopic(messages: MessageLike[], ordinals: number[]): void {
    for (const ordinal of ordinals) {
        messages[2 * ordinal]!.parts = [textPart(OFFTOPIC)]
    }
}

/** Installs a same-target edit×3 run (2 errors) plus one bystander bash call. */
function installArtifactRun(messages: MessageLike[], ordinal: number, target: string): void {
    messages[2 * ordinal + 1]!.parts = [
        reasoningPart(`推理 ${target}`),
        toolPart({
            tool: "edit",
            status: "error",
            error: `write failed 1\n${"e".repeat(300)}`,
            input: { filePath: target, oldString: "a" },
        }),
        toolPart({
            tool: "edit",
            status: "error",
            error: `write failed 2\n${"e".repeat(300)}`,
            input: { filePath: target, oldString: "b" },
        }),
        toolPart({
            tool: "edit",
            output: "saved",
            input: { filePath: target, oldString: "c", newString: "d" },
        }),
        toolPart({
            tool: "bash",
            output: "ok",
            input: { command: "echo verify", filePath: target },
        }),
    ]
}

test("off-topic middle turns deepen to the faithful pre-excision digest", () => {
    // 30 turns → head 26. Off-topic runs are real topic discontinuities, so
    // the predecessor-drift scanner puts boundaries at the run's edges only:
    // run [14, 16] → boundaries 14 and 17 → cStart 18, mStart 14, and the
    // on-topic turn 17 stays inside M as the classic-fold neighbor.
    const messages = buildTurns(30, { toolOutputChars: 3000, textChars: 60 })
    makeOffTopic(messages, [14, 15, 16])
    installArtifactRun(messages, 15, "/src/tokyo.ts")
    const h = harness({ contextTokens: 100 })
    const stats = h.run(messages)
    assert.ok(stats.level >= 2)
    assert.equal(stats.offTopicTurns, 3)
    assert.match(String(messages[28]!.parts![0].text), /^\[DCP·轮15\]/)
    // The digest carries pre-excision counts: edit×3 (never edit×1) and 错误×2.
    assert.match(String(messages[30]!.parts![0].text), /^\[DCP·轮16\] \| 意图: 东京五日游/)
    assert.match(String(messages[30]!.parts![0].text), /动作: edit×3/)
    assert.match(String(messages[30]!.parts![0].text), /错误×2/)
    assert.match(String(messages[32]!.parts![0].text), /^\[DCP·轮17\]/)
    // The turn folds with the full D-level treatment: host marker, cleared
    // inputs, and the run survivor keeps its `_merged` meta on top.
    const parts = messages[31]!.parts!
    assert.equal(parts.length, 3)
    const survivor = parts.find((p) => p.tool === "edit")!
    assert.equal(survivor.state?.time?.compacted, 1_700_000_000_000)
    assert.deepEqual(survivor.state?.input, { _merged: "edit×3 (2 err)" })
    const bash = parts.find((p) => p.tool === "bash")!
    assert.equal(bash.state?.time?.compacted, 1_700_000_000_000)
    assert.deepEqual(bash.state?.input, {})
    assert.equal(stats.excisedParts, 2)
    assert.equal(stats.mergedRuns, 1)
    // The on-topic neighbor keeps the classic middle-zone skeleton untouched.
    assert.match(String(messages[34]!.parts![0].text), /^任务18/)
    assert.deepEqual(messages[35]!.parts!.find((p) => p.type === "tool")!.state?.input, {
        command: "echo step-18",
        filePath: "/src/m18.ts",
    })
})

test("on-topic middle turns keep their fold shape and count zero", () => {
    const messages = buildTurns(30, { toolOutputChars: 100, textChars: 60 })
    const h = harness({ contextTokens: 100 })
    const stats = h.run(messages)
    assert.ok(stats.level >= 2)
    assert.equal(stats.offTopicTurns, 0)
    for (let t = 6; t < 18; t++) {
        assert.doesNotMatch(String(messages[2 * t]!.parts![0].text), /^\[DCP·轮/)
    }
    assert.match(String(messages[12]!.parts![0].text), /^任务7/)
    assert.deepEqual(messages[13]!.parts!.find((p) => p.type === "tool")!.state?.input, {
        command: "echo step-7",
        filePath: "/src/m7.ts",
    })
})

test("short and missing user texts never deepen and never throw", () => {
    // Off-topic at 14 and 16 with "继续" between them and a textless user
    // turn at 17: boundaries [14, 18] → M = [14, 18); only 14 and 16 deepen.
    const messages = buildTurns(30, { toolOutputChars: 100, textChars: 60 })
    makeOffTopic(messages, [14, 16])
    messages[30]!.parts = [textPart("继续")]
    messages[34]!.parts = [{ type: "file", id: "p_file" }]
    const h = harness({ contextTokens: 100 })
    const stats = h.run(messages)
    assert.equal(stats.offTopicTurns, 2)
    assert.equal(String(messages[30]!.parts![0].text), "继续")
    assert.deepEqual(messages[31]!.parts!.find((p) => p.type === "tool")!.state?.input, {
        command: "echo step-16",
        filePath: "/src/m16.ts",
    })
    assert.match(String(messages[28]!.parts![0].text), /^\[DCP·轮15\]/)
})

test("the C and tail zones stay byte-identical with an off-topic run adjacent to C", () => {
    // Run [15, 17] touches cStart: boundaries [15, 18] → M = [15, 18).
    const messages = buildTurns(30, { toolOutputChars: 3000, textChars: 60 })
    makeOffTopic(messages, [15, 16, 17])
    const cBefore = deepCloneMessages(messages.slice(36))
    const tailBefore = deepCloneMessages(messages.slice(-8))
    const h = harness({ contextTokens: 100 })
    const stats = h.run(messages)
    assert.ok(stats.level >= 2)
    assert.equal(stats.offTopicTurns, 3)
    assert.deepEqual(messages.slice(36), cBefore)
    assert.deepEqual(messages.slice(-8), tailBefore)
    assert.match(String(messages[34]!.parts![0].text), /^\[DCP·轮18\]/)
})

test("digest keys stay stable across deepening and the M→D slide", () => {
    // Single off-topic turn at 14: boundaries [14, 15] → M = [14, 18).
    const base = buildTurns(30, { toolOutputChars: 200, textChars: 60 })
    makeOffTopic(base, [14])
    const h = harness({ contextTokens: 100 })
    const run1 = deepCloneMessages(base)
    const stats1 = h.run(run1)
    assert.equal(stats1.offTopicTurns, 1)
    const digest1 = String(run1[28]!.parts![0].text)
    assert.match(digest1, /^\[DCP·轮15\]/)
    const cached1 = h.state.stats().digests

    const run2 = deepCloneMessages(base)
    const stats2 = h.run(run2)
    assert.equal(stats2.offTopicTurns, 1)
    assert.equal(String(run2[28]!.parts![0].text), digest1)
    assert.equal(h.state.stats().digests, cached1, "second request must hit the cache")

    // Append 12 on-topic turns: head 38 → cStart 30, mStart 18; ordinal 14
    // slides into the D zone. Its digest text must be identical (same 轮15
    // ordinal, cache hit) — only the 3 newly-D on-topic turns store keys.
    const run3 = deepCloneMessages(base)
    run3.push(...buildTurns(12, { toolOutputChars: 200, textChars: 60 }))
    const stats3 = h.run(run3)
    assert.equal(stats3.offTopicTurns, 0)
    assert.equal(String(run3[28]!.parts![0].text), digest1)
    assert.equal(h.state.stats().digests, cached1 + 3)
})

test("deepening works with mergeRuns disabled: no excision, no meta", () => {
    const messages = buildTurns(30, { toolOutputChars: 3000, textChars: 60 })
    makeOffTopic(messages, [14, 15, 16])
    installArtifactRun(messages, 15, "/src/tokyo.ts")
    const h = harness({ contextTokens: 100, config: { mergeRuns: false } })
    const stats = h.run(messages)
    assert.ok(stats.level >= 2)
    assert.equal(stats.offTopicTurns, 3)
    assert.match(String(messages[30]!.parts![0].text), /动作: edit×3/)
    assert.match(String(messages[30]!.parts![0].text), /错误×2/)
    assert.equal(stats.excisedParts, 0)
    assert.equal(stats.mergedRuns, 0)
    const parts = messages[31]!.parts!
    assert.equal(parts.length, 5)
    for (const part of parts) {
        if (part.type !== "tool") continue
        assert.equal((part.state?.input as Record<string, unknown>)?._merged, undefined)
        if (part.state?.status === "completed") {
            assert.equal(part.state?.time?.compacted, 1_700_000_000_000)
            assert.deepEqual(part.state?.input, {})
        } else {
            assert.equal(part.state?.time?.compacted, undefined)
            assert.deepEqual(part.state?.input, {})
            assert.ok(String(part.state?.error).length <= 101)
        }
    }
    const okEdit = parts.find((p) => p.tool === "edit" && p.state?.status === "completed")!
    assert.deepEqual(okEdit.state?.input, {})
})

test("a manual boundary mark keeps geometry and deepens off-topic middle turns", () => {
    // 10 turns → head 6; mark at 5000 → markStart 5, cStart 5. The run [1, 2]
    // leaves boundaries [1, 3] → mStart 1, so both off-topic turns deepen
    // while on-topic turns 4 and 5 stay classic middle folds.
    const messages = buildTurns(10, { toolOutputChars: 200, textChars: 60 })
    makeOffTopic(messages, [1, 2])
    const h = harness({ contextTokens: 1_000_000 })
    h.state.markBoundary("ses_test", 5 * 1000, 2)
    const stats = h.run(messages)
    assert.equal(stats.level, 2)
    assert.equal(stats.offTopicTurns, 2)
    assert.match(String(messages[2]!.parts![0].text), /^\[DCP·轮2\]/)
    assert.match(String(messages[4]!.parts![0].text), /^\[DCP·轮3\]/)
    assert.match(String(messages[6]!.parts![0].text), /^任务4/)
    assert.deepEqual(messages[7]!.parts!.find((p) => p.type === "tool")!.state?.input, {
        command: "echo step-4",
        filePath: "/src/m4.ts",
    })
})

test("an empty current zone yields an empty reference and zero deepening", () => {
    // 30 turns; mark at 29000 covers every head turn → cStart 26 = head end,
    // C empty → no reference → classic middle folding only.
    const messages = buildTurns(30, { toolOutputChars: 200, textChars: 60 })
    makeOffTopic(messages, [15, 16])
    const h = harness({ contextTokens: 1_000_000 })
    h.state.markBoundary("ses_test", 29 * 1000, 2)
    const stats = h.run(messages)
    assert.equal(stats.level, 2)
    assert.equal(stats.offTopicTurns, 0)
    assert.equal(String(messages[30]!.parts![0].text), OFFTOPIC)
    assert.equal(String(messages[32]!.parts![0].text), OFFTOPIC)
})

test("level 1 never deepens the middle zone", () => {
    const messages = buildTurns(30, { toolOutputChars: 10, textChars: 30 })
    makeOffTopic(messages, [8])
    messages[1]!.parts![1]!.state!.output = "q".repeat(200_000)
    const h = harness({
        contextTokens: 100_000,
        config: { lowWatermarkRatio: 0.1, targetRatio: 0.5 },
    })
    const stats = h.run(messages)
    assert.equal(stats.level, 1)
    assert.equal(stats.offTopicTurns, 0)
    assert.match(String(messages[16]!.parts![0].text), /东京五日游/)
})

test("malformed parts never break the deepening path", () => {
    const messages = buildTurns(30, { toolOutputChars: 100, textChars: 60 })
    makeOffTopic(messages, [8])
    messages[16]!.parts = [null as any, textPart(OFFTOPIC), 42 as any]
    messages[17]!.parts = [toolPart({ output: "ok" }), null as any]
    const h = harness({ contextTokens: 100 })
    assert.doesNotThrow(() => h.run(messages))
    assert.match(String(messages[16]!.parts![1].text), /^\[DCP·轮9\]/)
})

function singleTurns(texts: string[]): { messages: MessageLike[]; turns: Turn[] } {
    const messages = texts.map((text, index) => ({
        info: { id: `msg_scan_${index}`, role: "user" },
        parts: [textPart(text)],
    }))
    const turns = texts.map((_, index) => ({ start: index, end: index + 1 }))
    return { messages, turns }
}

test("offTopicMiddleTurns scanner contract", () => {
    const template = (t: number) => `任务${t}：处理模块 m${t} 的接口改造需求，第 ${t} 轮`
    const texts = [
        OFFTOPIC,
        template(2),
        OFFTOPIC,
        "继续",
        OFFTOPIC,
        template(6),
        template(7),
        template(8),
    ]
    const { messages, turns } = singleTurns(texts)
    // M = [2, 5), C = [5, 8): short texts are never members, the D-zone
    // off-topic turn at 0 is outside the scan bounds.
    assert.deepEqual(offTopicMiddleTurns(messages, turns, 2, 5, 0.18), [2, 4])
    // Empty reference (cStart at the head end) → no members at all.
    assert.deepEqual(offTopicMiddleTurns(messages, turns, 2, 8, 0.18), [])
    // Empty inputs fail safe.
    assert.deepEqual(offTopicMiddleTurns([], [], 0, 0, 0.18), [])
})
