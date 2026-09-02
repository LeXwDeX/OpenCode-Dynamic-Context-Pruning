import assert from "node:assert/strict"
import test from "node:test"
import { DTC_DEFAULTS, segmentTurns, transformMessages } from "../lib/dtc/engine"
import { DtcState } from "../lib/dtc/state"
import type { MessageLike } from "../lib/dtc/types"
import {
    buildTurns,
    deepCloneMessages,
    fakeLogger,
    snapshotStructure,
    toolPart,
    textPart,
    reasoningPart,
    userMessage,
    assistantMessage,
    toForkShape,
} from "./fixtures"

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

test("segmentTurns splits at user messages and skips compaction machinery", () => {
    const messages = buildTurns(3)
    messages.splice(2, 0, {
        info: { id: "msg_c", role: "user", sessionID: "ses_test" },
        parts: [{ type: "compaction" }],
    })
    const turns = segmentTurns(messages)
    assert.equal(turns.length, 3)
    assert.equal(turns[0]!.start, 0)
    assert.equal(turns[1]!.start, 3)
    assert.equal(turns[2]!.end, messages.length)
})

test("sessions within the tail turn count are never folded", () => {
    const messages = buildTurns(4)
    const before = deepCloneMessages(messages)
    const h = harness({ contextTokens: 10 })
    const stats = h.run(messages)
    assert.equal(stats.skipped, "short")
    assert.equal(stats.level, 0)
    assert.deepEqual(messages, before)
})

test("folding fails open until the context window is known", () => {
    const messages = buildTurns(10, { toolOutputChars: 5000 })
    const before = deepCloneMessages(messages)
    const h = harness({ contextTokens: undefined })
    const stats = h.run(messages)
    assert.equal(stats.skipped, "unknown-context")
    assert.deepEqual(messages, before)
})

test("under the low watermark nothing is folded even with many turns", () => {
    const messages = buildTurns(30)
    const before = deepCloneMessages(messages)
    const h = harness({ contextTokens: 1_000_000 })
    const stats = h.run(messages)
    assert.equal(stats.level, 0)
    assert.equal(stats.skipped, undefined)
    assert.deepEqual(messages, before)
})

test("structural invariant: messages never change; parts shrink only by D/M tool-part excision", () => {
    const messages = buildTurns(30, { toolOutputChars: 3000, textChars: 400 })
    const structureBefore = snapshotStructure(messages)
    const h = harness({ contextTokens: 2000 })
    const stats = h.run(messages)
    assert.ok(stats.level >= 1, "must actually fold under pressure")
    // bash-only sessions form no runs: with zero excisions the structure is
    // byte-identical. The run-scenario variant of this rule lives in
    // tests/dtc-engine-merge.test.ts.
    assert.equal(stats.mergedRuns, 0)
    assert.equal(stats.excisedParts, 0)
    assert.equal(snapshotStructure(messages), structureBefore)
    // red line independent of runs: no message is ever emptied
    for (const message of messages) {
        assert.ok((message.parts ?? []).length > 0)
    }
})

test("the protected tail is never touched at any fold level", () => {
    const messages = buildTurns(30, { toolOutputChars: 3000, textChars: 400 })
    const tailBefore = deepCloneMessages(messages.slice(-8))
    const h = harness({ contextTokens: 100, config: { tailTurns: 4 } })
    const stats = h.run(messages)
    assert.equal(stats.level, 3, "tiny window must escalate to the deepest level")
    assert.deepEqual(messages.slice(-8), tailBefore)
})

test("distant turns collapse to a mechanical digest and host-native tool markers", () => {
    const messages = buildTurns(30, { toolOutputChars: 3000, textChars: 400 })
    const h = harness({ contextTokens: 100 })
    h.run(messages)
    const firstUserText = messages[0]!.parts![0]
    assert.match(String(firstUserText.text), /^\[DCP·轮1\] \| 意图: /)
    assert.match(String(firstUserText.text), /动作: bash/)
    assert.match(String(firstUserText.text), /涉及: .*\/src\/m1\.ts/)
    const tool = messages[1]!.parts!.find((p) => p.type === "tool")!
    assert.equal(tool.state?.time?.compacted, 1_700_000_000_000)
    assert.deepEqual(tool.state?.input, {})
    const reasoning = messages[1]!.parts!.find((p) => p.type === "reasoning")!
    assert.equal(reasoning.text, " ")
})

test("middle-zone tools keep their inputs while outputs get the host marker", () => {
    // 30 turns, head 26; force level 2+ via a small window; zones:
    // cStart = max(0, 26-8) = 18, mStart = max(0, 18-12) = 6 → M = turns 6..17
    const messages = buildTurns(30, { toolOutputChars: 100, textChars: 60 })
    const h = harness({ contextTokens: 100 })
    const stats = h.run(messages)
    assert.ok(stats.level >= 2)
    const mTurnUser = messages[12] // head turn ordinal 6 → message index 12
    const mTool = messages[13]!.parts!.find((p) => p.type === "tool")!
    assert.ok(mTool.state?.time?.compacted, "M-zone tool folded with host marker")
    assert.deepEqual(mTool.state?.input, { command: "echo step-7", filePath: "/src/m7.ts" })
    assert.ok(mTurnUser, "M-zone user message still present")
})

test("current-zone folding only truncates oversized tool outputs head+tail", () => {
    // Make the C zone the only foldable weight: short D/M content, huge C tools.
    const messages = buildTurns(12, { toolOutputChars: 10, textChars: 20 })
    // head = 8 turns; cStart = max(0, 8-8) = 0 → whole head is C zone
    for (const message of messages.slice(0, 16)) {
        for (const part of message.parts ?? []) {
            if (part.type === "tool" && part.state) {
                part.state.output = "z".repeat(20_000)
            }
        }
    }
    const h = harness({
        contextTokens: 30_000,
        config: { lowWatermarkRatio: 0.1, targetRatio: 0.2, toolOutputKeepChars: 2000 },
    })
    const stats = h.run(messages)
    assert.equal(stats.level, 3)
    const cTool = messages[1]!.parts!.find((p) => p.type === "tool")!
    const output = String(cTool.state?.output)
    assert.ok(output.includes("[DCP 已折叠"))
    assert.ok(output.length < 2500)
    assert.equal(cTool.state?.time?.compacted, undefined, "C zone never uses the cleared marker")
    // C-zone text is untouched
    assert.match(String(messages[0]!.parts![0].text), /任务1/)
})

test("escalation stops as soon as the estimate fits the target", () => {
    // One huge distant tool output; folding D alone must satisfy the budget.
    const messages = buildTurns(30, { toolOutputChars: 10, textChars: 30 })
    const dTool = messages[1]!.parts!.find((p) => p.type === "tool")!
    dTool.state!.output = "q".repeat(200_000)
    const h = harness({
        contextTokens: 100_000,
        config: { lowWatermarkRatio: 0.1, targetRatio: 0.5 },
    })
    const stats = h.run(messages)
    assert.equal(stats.level, 1)
    assert.ok(stats.estimatedAfter <= 50_000)
})

test("a manual boundary mark deepens folding even below the low watermark", () => {
    const messages = buildTurns(10, { toolOutputChars: 200, textChars: 100 })
    const h = harness({ contextTokens: 1_000_000 })
    h.state.markBoundary("ses_test", 5 * 1000, 2)
    const stats = h.run(messages)
    assert.ok(stats.level >= 2)
    // head = 6 turns; mark at t=5000 covers turns created <= 5000 (turns 1..5)
    // → markStart = 5, cStart = min(6, max(0,5,6-8→0)) = 5 → M = [mStart,5)
    const mTool = messages[1]!.parts!.find((p) => p.type === "tool")!
    assert.ok(mTool.state?.time?.compacted)
})

test("a manual minimum level folds every band up to it, distant zone included", () => {
    // 30 turns → head 26; mark at t=25000 → markStart 25 → cStart 25,
    // mStart 13 → D = [0,13) must digest even though folding starts at 2.
    const messages = buildTurns(30, { toolOutputChars: 200, textChars: 100 })
    const h = harness({ contextTokens: 1_000_000 })
    h.state.markBoundary("ses_test", 25 * 1000, 2)
    const stats = h.run(messages)
    assert.equal(stats.level, 2)
    assert.ok(stats.digestedTurns >= 13, "distant band folds when starting at level 2")
    const dTool = messages[1]!.parts!.find((p) => p.type === "tool")!
    assert.ok(dTool.state?.time?.compacted, "distant tool folded")
    const mTool = messages[27]!.parts!.find((p) => p.type === "tool")!
    assert.ok(mTool.state?.time?.compacted, "middle tool folded")
    // Band 3 never runs at level 2: the current zone stays raw.
    const cTool = messages[51]!.parts!.find((p) => p.type === "tool")!
    assert.equal(cTool.state?.time?.compacted, undefined)
    assert.ok(String(cTool.state?.output).length >= 200)
})

test("the deepest manual level (3) folds distant, middle, and current bands", () => {
    const messages = buildTurns(30, { toolOutputChars: 200, textChars: 100 })
    const h = harness({ contextTokens: 1_000_000 })
    h.state.markBoundary("ses_test", 25 * 1000, 3)
    const stats = h.run(messages)
    assert.equal(stats.level, 3)
    assert.ok(stats.digestedTurns >= 13, "distant band folds when starting at level 3")
    const mTool = messages[27]!.parts!.find((p) => p.type === "tool")!
    assert.ok(mTool.state?.time?.compacted)
    // Tail stays untouched at every level.
    const tTool = messages[53]!.parts!.find((p) => p.type === "tool")!
    assert.equal(tTool.state?.time?.compacted, undefined)
})

test("digests are deterministic and cached across requests", () => {
    const h = harness({ contextTokens: 100 })
    const first = buildTurns(30, { toolOutputChars: 500, textChars: 200 })
    h.run(first)
    const digestFirst = String(first[0]!.parts![0].text)
    const cached = h.state.stats().digests
    assert.ok(cached >= 1)

    const second = buildTurns(30, { toolOutputChars: 500, textChars: 200 })
    // Different message IDs but identical content shape → different keys, so
    // determinism is asserted on the digest text, not cache hits.
    h.run(second)
    const digestSecond = String(second[0]!.parts![0].text)
    assert.equal(
        digestFirst
            .replace(/轮\d+/, "轮N")
            .replace(/m\d+/, "mX")
            .replace(/任务\d+/, "任务N"),
        digestSecond
            .replace(/轮\d+/, "轮N")
            .replace(/m\d+/, "mX")
            .replace(/任务\d+/, "任务N"),
    )
})

test("the compaction one-shot skip leaves the summarizer input untouched", () => {
    const messages = buildTurns(30, { toolOutputChars: 3000 })
    const before = deepCloneMessages(messages)
    const h = harness({ contextTokens: 100 })
    h.state.armCompactionSkip("ses_test")
    const skipped = h.run(messages)
    assert.equal(skipped.skipped, "compaction")
    assert.deepEqual(messages, before)
    // One-shot: the next transform folds normally.
    const next = h.run(messages)
    assert.notEqual(next.skipped, "compaction")
    assert.ok(next.level >= 1)
})

test("error-state tool parts are never folded in the protected tail", () => {
    const messages = buildTurns(30, { toolOutputChars: 10, textChars: 30 })
    const failed = toolPart({
        status: "error",
        error: ` boom line1\n${"stack ".repeat(200)}`,
        input: { filePath: "/src/tail.ts", oldString: "a".repeat(500) },
    })
    messages[messages.length - 1]!.parts!.push(failed)
    const h = harness({ contextTokens: 100 })
    h.run(messages)
    const state = failed.state!
    assert.equal(state.time?.compacted, undefined)
    assert.match(String(state.error), /^ boom line1\nstack/, "tail error text untouched")
    assert.equal((state.input as any).oldString.length, 500)
})

test("middle-zone bash commands keep a short first line only", () => {
    const messages = buildTurns(30, { toolOutputChars: 10, textChars: 30 })
    const mAssistant = messages[13]
    mAssistant!.parts = [
        toolPart({
            tool: "bash",
            output: "done",
            input: { command: `git status\n${"echo noise\n".repeat(100)}` },
        }),
    ]
    const h = harness({ contextTokens: 100 })
    h.run(messages)
    const input = mAssistant!.parts![0].state!.input as Record<string, unknown>
    assert.equal(input.command, "git status")
})

test("current-zone and distant-zone error handling respects the red lines", () => {
    const messages = buildTurns(30, { toolOutputChars: 10, textChars: 30 })
    // C zone turn (head ordinal 18 → messages[36]/[37]) keeps error payloads
    const cAssistant = messages[37]
    cAssistant!.parts = [
        toolPart({
            tool: "edit",
            status: "error",
            error: `c-zone failure\n${"x".repeat(1000)}`,
            input: { filePath: "/src/c.ts", oldString: "keepme".repeat(100) },
        }),
    ]
    // D zone turn (messages[1]) clears inputs and shortens errors hard
    const dAssistant = messages[1]
    dAssistant!.parts = [
        toolPart({
            tool: "edit",
            status: "error",
            error: `d-zone failure\n${"y".repeat(1000)}`,
            input: { filePath: "/src/d.ts", oldString: "gone".repeat(100) },
        }),
    ]
    const h = harness({ contextTokens: 100 })
    const stats = h.run(messages)
    assert.equal(stats.level, 3)

    const cState = cAssistant!.parts![0].state!
    assert.match(String(cState.error), /^c-zone failure\n/, "C-zone error untouched")
    assert.equal((cState.input as any).oldString.length, 600)

    const dState = dAssistant!.parts![0].state!
    assert.ok(String(dState.error).length <= 101)
    assert.deepEqual(dState.input, {})
})

test("folding a thousand-message session stays fast", () => {
    const messages = buildTurns(500, { toolOutputChars: 800, textChars: 300 })
    assert.ok(messages.length >= 1000)
    const h = harness({ contextTokens: 50_000 })
    const t0 = performance.now()
    const stats = h.run(messages)
    const elapsed = performance.now() - t0
    assert.ok(stats.level >= 1)
    assert.ok(elapsed < 250, `transform took ${elapsed.toFixed(1)}ms, expected < 250ms`)
})

test("transform tolerates malformed messages without throwing", () => {
    const messages: MessageLike[] = [
        {},
        { info: { role: "user" } },
        { info: { role: "user", sessionID: "ses_test" }, parts: [textPart("正常"), null as any] },
        assistantMessage([reasoningPart("r"), textPart("ok")]),
        ...buildTurns(6, { toolOutputChars: 500 }),
    ]
    const h = harness({ contextTokens: 100 })
    assert.doesNotThrow(() => h.run(messages))
})

test("user messages without text still digest safely", () => {
    const messages = buildTurns(30, { toolOutputChars: 500, textChars: 200 })
    messages[0]!.parts = [{ type: "file" as any, id: "p_file" } as any]
    const h = harness({ contextTokens: 100 })
    assert.doesNotThrow(() => h.run(messages))
})

test("fork-shape payloads without sessionID fold via chat.params correlation", () => {
    // 30 turns → head 26 → D = [0,6), M = [6,18); tiny window forces the full
    // escalation, so a resolved session must digest the distant zone.
    const messages = toForkShape(buildTurns(30, { toolOutputChars: 200, textChars: 100 }))
    const h = harness({ contextTokens: 1_000 })
    // The host fired chat.params on the previous request with the turn-29
    // user message (created 29000); the newest user turn (30000) has no
    // record yet, so resolution must scan back and hit 29000.
    h.state.recordParamsSession("ses_test", 29 * 1000)
    const stats = h.run(messages)
    assert.notEqual(stats.skipped, "unknown-context")
    assert.equal(stats.level, 3)
    assert.ok(stats.digestedTurns >= 6, "distant zone digests under fork-shape payloads")
    assert.ok(stats.foldedTools > 0)
})

test("fork-shape first request (nothing correlated yet) fails open untouched", () => {
    const messages = toForkShape(buildTurns(30, { toolOutputChars: 200, textChars: 100 }))
    const before = deepCloneMessages(messages)
    const h = harness({ contextTokens: 1_000 })
    const stats = h.run(messages)
    assert.equal(stats.skipped, "unknown-context")
    assert.deepEqual(messages, before)
})
