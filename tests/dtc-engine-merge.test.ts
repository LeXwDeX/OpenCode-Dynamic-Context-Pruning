import assert from "node:assert/strict"
import test from "node:test"
import { DTC_DEFAULTS, transformMessages } from "../lib/dtc/engine"
import { DtcState } from "../lib/dtc/state"
import type { MessageLike, PartLike } from "../lib/dtc/types"
import {
    assistantMessage,
    buildTurns,
    deepCloneMessages,
    fakeLogger,
    reasoningPart,
    textPart,
    toolPart,
} from "./fixtures"

/**
 * Issue #25: the validity-axis merge phase wired into the engine. Same-target
 * artifact runs in the D/M zones collapse to one surviving tool part; whole
 * parts are excised; C/T zones and message structure stay inviolate.
 * Issue #26 wires the #24 error-run detector into the same seam: strictly
 * adjacent same-tool error chains merge under the same zone semantics, with
 * resolveRuns enforcing artifact > error mutual exclusion.
 */

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

/** Zones for a 30-turn buildTurns session: head 26, D=[0,6), M=[6,18),
 * C=[18,26). Turn t's user message sits at messages[2t-2], its assistant at
 * messages[2t-1] — so the first M-turn assistant is messages[13]. */
function threeDupEdits(): PartLike[] {
    return [
        toolPart({
            tool: "edit",
            status: "error",
            error: `oldString not found\n${"detail ".repeat(300)}`,
            input: {
                filePath: "/src/dup.ts",
                oldString: "o".repeat(2000),
                newString: "n".repeat(2000),
            },
        }),
        toolPart({
            tool: "edit",
            status: "error",
            error: `found multiple matches\n${"detail ".repeat(300)}`,
            input: {
                filePath: "/src/dup.ts",
                oldString: "p".repeat(2000),
                newString: "q".repeat(2000),
            },
        }),
        toolPart({
            tool: "edit",
            output: "edit applied",
            input: {
                filePath: "/src/dup.ts",
                oldString: "r".repeat(2000),
                newString: "s".repeat(2000),
            },
        }),
    ]
}

test("M-zone same-target edit chain merges to one surviving call with _merged meta", () => {
    const messages = buildTurns30()
    const mAssistant = messages[13]!
    mAssistant.parts = threeDupEdits()
    const h = harness({ contextTokens: 100 })
    const stats = h.run(messages)
    assert.ok(stats.level >= 2, "tiny window must escalate into the M band")
    assert.equal(stats.mergedRuns, 1)
    assert.equal(stats.excisedParts, 2)
    assert.equal(mAssistant.parts!.length, 1, "only the surviving call stays")
    const survivor = mAssistant.parts![0]!
    assert.equal(survivor.tool, "edit")
    assert.equal(survivor.state!.time?.compacted, 1_700_000_000_000, "host-native fold marker")
    assert.deepEqual(survivor.state!.input, {
        filePath: "/src/dup.ts",
        _merged: "edit×3 (2 err)",
    })
    const serialized = JSON.stringify(messages)
    assert.ok(!serialized.includes("detail detail"), "dropped members leave no payloads")
    assert.ok(!serialized.includes("oooo"))
})

test("mixed mergeable tools on one target form one ops run, survivor is the last call", () => {
    const messages = buildTurns30()
    const mAssistant = messages[13]!
    mAssistant.parts = [
        toolPart({ tool: "read", output: "v1", input: { filePath: "/src/x.ts" } }),
        toolPart({ tool: "edit", output: "ok", input: { filePath: "/src/x.ts" } }),
        toolPart({ tool: "read", output: "v2", input: { filePath: "/src/x.ts" } }),
    ]
    const h = harness({ contextTokens: 100 })
    const stats = h.run(messages)
    assert.equal(stats.mergedRuns, 1)
    assert.equal(stats.excisedParts, 2)
    assert.equal(mAssistant.parts!.length, 1)
    assert.deepEqual(mAssistant.parts![0]!.state!.input, {
        filePath: "/src/x.ts",
        _merged: "ops×3",
    })
})

test("a run spans messages within one turn and excises across them", () => {
    const messages = buildTurns30()
    const msgA = messages[13]!
    msgA.parts = [
        textPart("先改一下"),
        toolPart({ tool: "edit", output: "a", input: { filePath: "/src/multi.ts" } }),
    ]
    const msgB = assistantMessage([
        toolPart({ tool: "edit", output: "b", input: { filePath: "/src/multi.ts" } }),
        toolPart({ tool: "edit", output: "c", input: { filePath: "/src/multi.ts" } }),
    ])
    messages.splice(14, 0, msgB)
    const h = harness({ contextTokens: 100 })
    const stats = h.run(messages)
    assert.equal(stats.mergedRuns, 1)
    assert.equal(stats.excisedParts, 2)
    assert.deepEqual(
        msgA.parts!.map((p) => p.type),
        ["text"],
        "msg A keeps its text part only",
    )
    assert.equal(msgB.parts!.length, 1, "msg B keeps only the survivor")
    assert.deepEqual(msgB.parts![0]!.state!.input, {
        filePath: "/src/multi.ts",
        _merged: "edit×3",
    })
})

test("never-empty: a message whose only part is a dropped member keeps that part", () => {
    const messages = buildTurns30()
    const msgA = messages[13]!
    const loneEdit = toolPart({ tool: "edit", output: "a", input: { filePath: "/src/solo.ts" } })
    msgA.parts = [loneEdit]
    const msgB = assistantMessage([
        toolPart({ tool: "edit", output: "b", input: { filePath: "/src/solo.ts" } }),
        toolPart({ tool: "edit", output: "c", input: { filePath: "/src/solo.ts" } }),
    ])
    messages.splice(14, 0, msgB)
    const h = harness({ contextTokens: 100 })
    const stats = h.run(messages)
    assert.equal(stats.mergedRuns, 1)
    assert.equal(msgA.parts!.length, 1, "the message is never emptied")
    assert.equal(msgA.parts![0]!.id, loneEdit.id)
    assert.ok(msgA.parts![0]!.state!.time?.compacted, "the retained member folds normally")
    assert.deepEqual(msgA.parts![0]!.state!.input, { filePath: "/src/solo.ts" })
    assert.equal(msgB.parts!.length, 1)
    assert.deepEqual(msgB.parts![0]!.state!.input, {
        filePath: "/src/solo.ts",
        _merged: "edit×3",
    })
    assert.equal(stats.excisedParts, 1, "the fallback retention is not counted as excised")
})

test("C/T red line: same-target chains never reach or cross into the current zone", () => {
    const messages = buildTurns30()
    // Last M turn (messages[35]) and first C turn (messages[37]) share a
    // target across the boundary — D6 forbids a cross-turn run.
    messages[35]!.parts = [
        toolPart({ tool: "edit", output: "m-side", input: { filePath: "/src/boundary.ts" } }),
    ]
    messages[37]!.parts = [
        toolPart({ tool: "edit", output: "c-side", input: { filePath: "/src/boundary.ts" } }),
    ]
    // A full chain inside C is invisible to the detector by construction.
    messages[39]!.parts = [
        toolPart({ tool: "edit", output: "c1", input: { filePath: "/src/in-c.ts" } }),
        toolPart({ tool: "edit", output: "c2", input: { filePath: "/src/in-c.ts" } }),
    ]
    const cBefore = deepCloneMessages(messages.slice(36, 52))
    const h = harness({ contextTokens: 100 })
    const stats = h.run(messages)
    assert.equal(stats.level, 3)
    assert.equal(stats.mergedRuns, 0)
    assert.equal(stats.excisedParts, 0)
    assert.deepEqual(deepCloneMessages(messages.slice(36, 52)), cBefore)
    assert.equal(messages[35]!.parts!.length, 1, "the M-side single call stays")
})

test("mergeRuns: false pins the pre-merge skeleton behavior byte for byte", () => {
    const messages = buildTurns30()
    const mAssistant = messages[13]!
    mAssistant.parts = threeDupEdits()
    const h = harness({ contextTokens: 100, config: { mergeRuns: false } })
    const stats = h.run(messages)
    assert.ok(stats.level >= 2)
    assert.equal(stats.mergedRuns, 0)
    assert.equal(stats.excisedParts, 0)
    assert.equal(mAssistant.parts!.length, 3, "nothing is excised")
    const [err1, err2, ok] = mAssistant.parts!
    for (const part of [err1, err2]) {
        const state = part.state!
        assert.ok(String(state.error).length <= 201, "error folds to a short line")
        assert.ok(!String(state.error).includes("\n"), "error keeps only the first line")
        assert.deepEqual(state.input, { filePath: "/src/dup.ts" })
    }
    assert.ok(ok!.state!.time?.compacted, "completed edit gets the host fold marker")
    assert.deepEqual(ok!.state!.input, { filePath: "/src/dup.ts" })
    assert.ok(stats.reducedInputs >= 3)
    assert.ok(stats.foldedErrors >= 2)
    assert.ok(!JSON.stringify(mAssistant.parts).includes("_merged"), "no meta without merging")
})

test("the merge phase tolerates malformed parts without throwing", () => {
    const messages = buildTurns30()
    const mAssistant = messages[13]!
    mAssistant.parts = [
        null as any,
        { type: "tool", id: "p_stateless" } as any,
        { type: "tool", id: "p_noinput", state: { status: "completed", output: "x" } } as any,
        toolPart({ tool: "edit", output: "a", input: { filePath: "/src/junk.ts" } }),
        toolPart({ tool: "edit", output: "b", input: { filePath: "/src/junk.ts" } }),
    ]
    const h = harness({ contextTokens: 100 })
    let stats: any
    assert.doesNotThrow(() => {
        stats = h.run(messages)
    })
    assert.equal(stats.mergedRuns, 1, "the two well-formed edits still merge")
    assert.equal(stats.excisedParts, 1)
})

test("structural invariant under merging: only whole D/M tool parts disappear", () => {
    const messages = buildTurns30()
    messages[1]!.parts = [
        reasoningPart("d reasoning"),
        toolPart({ tool: "edit", output: "d1", input: { filePath: "/src/d.ts" } }),
        toolPart({
            tool: "edit",
            status: "error",
            error: "boom",
            input: { filePath: "/src/d.ts" },
        }),
        toolPart({ tool: "edit", output: "d2", input: { filePath: "/src/d.ts" } }),
    ]
    messages[13]!.parts = [
        textPart("m text"),
        toolPart({ tool: "read", output: "m1", input: { filePath: "/src/m.ts" } }),
        toolPart({ tool: "edit", output: "m2", input: { filePath: "/src/m.ts" } }),
    ]
    const before = messages.map((m) => ({
        id: m.info?.id,
        role: m.info?.role,
        parts: (m.parts ?? []).map((p) => ({ id: p?.id, type: p?.type })),
    }))
    const h = harness({ contextTokens: 100 })
    const stats = h.run(messages)
    assert.equal(stats.mergedRuns, 2)
    assert.equal(stats.excisedParts, 3)
    assert.equal(messages.length, before.length, "message count never changes")
    for (let i = 0; i < messages.length; i++) {
        const after = messages[i]!
        const b = before[i]!
        assert.equal(after.info?.id, b.id, "message IDs never change")
        assert.equal(after.info?.role, b.role, "roles never change")
        const afterIds = (after.parts ?? []).map((p) => p?.id)
        const surviving = b.parts.filter((bp) => afterIds.includes(bp.id))
        assert.deepEqual(
            surviving.map((p) => p.id),
            afterIds,
            "surviving parts keep their relative order",
        )
        for (const bp of b.parts) {
            if (afterIds.includes(bp.id!)) continue
            assert.equal(bp.type, "tool", "only whole tool parts are ever removed")
            assert.ok(i < 36, "removals only happen inside the D/M zones")
        }
        for (const bp of b.parts) {
            if (bp.type !== "tool") {
                assert.ok(afterIds.includes(bp.id!), "non-tool parts always survive")
            }
        }
        assert.ok((after.parts ?? []).length > 0, "no message is ever emptied")
    }
})

test("D-zone digests carry pre-excision counts and stay stable across requests", () => {
    const pristine = buildTurns30()
    pristine[1]!.parts = [
        toolPart({
            tool: "edit",
            status: "error",
            error: "boom one",
            input: { filePath: "/src/dig.ts" },
        }),
        toolPart({
            tool: "edit",
            status: "error",
            error: "boom two",
            input: { filePath: "/src/dig.ts" },
        }),
        toolPart({ tool: "edit", output: "done", input: { filePath: "/src/dig.ts" } }),
    ]
    const first = deepCloneMessages(pristine)
    const second = deepCloneMessages(pristine)
    const h = harness({ contextTokens: 100 })
    h.run(first)
    const digestFirst = String(first[0]!.parts![0].text)
    assert.match(digestFirst, /edit×3/, "the digest counts the pre-merge chain length")
    assert.match(digestFirst, /错误×2/)
    const cachedBefore = h.state.stats().digests
    h.run(second)
    const digestSecond = String(second[0]!.parts![0].text)
    const cachedAfter = h.state.stats().digests
    assert.equal(cachedAfter, cachedBefore, "identical pre-excision shape → same cache key")
    assert.equal(digestFirst, digestSecond)
})

test("merging satisfies the budget earlier: escalation stops at level 1 after excision", () => {
    const messages = buildTurns30({ toolOutputChars: 0, textChars: 0 })
    const mAssistant = messages[13]!
    mAssistant.parts = [
        toolPart({ tool: "read", output: "z".repeat(30_000), input: { filePath: "/src/big.ts" } }),
        toolPart({ tool: "read", output: "z".repeat(30_000), input: { filePath: "/src/big.ts" } }),
        toolPart({ tool: "read", output: "z".repeat(30_000), input: { filePath: "/src/big.ts" } }),
    ]
    const h = harness({ contextTokens: 30_000 })
    const stats = h.run(messages)
    assert.equal(stats.level, 1, "the merge saving keeps level 1 under the target")
    assert.equal(stats.mergedRuns, 1)
    assert.equal(stats.excisedParts, 2)
    assert.ok(stats.estimatedAfter <= 21_000)
    // Level 1: band 2 never runs — the survivor stays raw and meta-free
    // (validity axis ⊥ depth axis, accepted in the #25 design).
    const survivor = mAssistant.parts![0]!
    assert.equal(survivor.state!.time?.compacted, undefined)
    assert.equal(String(survivor.state!.output).length, 30_000)
    assert.equal((survivor.state!.input as any)._merged, undefined)
})

function fourBashErrors(): PartLike[] {
    return [1, 2, 3, 4].map((i) =>
        toolPart({
            tool: "bash",
            status: "error",
            error: `${i <= 2 ? "ECONNRESET: connection reset by peer" : "ETIMEDOUT: gateway timeout"}\n${"stack ".repeat(200)}`,
            input: { command: `npm test --run ${i}` },
        }),
    )
}

test("M-zone adjacent same-tool error chain merges to one survivor with the first error's line", () => {
    const messages = buildTurns30()
    const mAssistant = messages[13]!
    mAssistant.parts = fourBashErrors()
    const h = harness({ contextTokens: 100 })
    const stats = h.run(messages)
    assert.ok(stats.level >= 2, "tiny window must escalate into the M band")
    assert.equal(stats.mergedRuns, 1)
    assert.equal(stats.excisedParts, 3)
    assert.equal(mAssistant.parts!.length, 1, "only the surviving error stays")
    const survivor = mAssistant.parts![0]!
    assert.equal(survivor.tool, "bash")
    assert.ok(
        String(survivor.state!.error).startsWith("ETIMEDOUT: gateway timeout"),
        "the survivor is the LAST member (net state)",
    )
    assert.ok(!String(survivor.state!.error).includes("\n"), "error folds to its first line")
    assert.deepEqual(survivor.state!.input, {
        command: "npm test --run 4",
        _merged: "bash×4 (4 err), first: ECONNRESET: connection reset by peer",
    })
    const serialized = JSON.stringify(messages)
    assert.ok(!serialized.includes("stack stack"), "dropped members leave no payloads")
})

test("artifact priority: same-file failed edits ride the artifact run, the error run yields whole", () => {
    const messages = buildTurns30()
    const mAssistant = messages[13]!
    mAssistant.parts = [
        toolPart({
            tool: "edit",
            status: "error",
            error: `oldString not found\n${"detail ".repeat(200)}`,
            input: {
                filePath: "/src/prio.ts",
                oldString: "a".repeat(500),
                newString: "b".repeat(500),
            },
        }),
        toolPart({
            tool: "edit",
            status: "error",
            error: `oldString not found\n${"detail ".repeat(200)}`,
            input: {
                filePath: "/src/prio.ts",
                oldString: "c".repeat(500),
                newString: "d".repeat(500),
            },
        }),
        toolPart({
            tool: "edit",
            status: "error",
            error: `found multiple matches\n${"detail ".repeat(200)}`,
            input: {
                filePath: "/src/prio.ts",
                oldString: "e".repeat(500),
                newString: "f".repeat(500),
            },
        }),
        toolPart({
            tool: "bash",
            status: "error",
            error: `ENOENT: no such file or directory\n${"trace ".repeat(200)}`,
            input: { command: "cat /tmp/missing.log" },
        }),
        toolPart({
            tool: "bash",
            status: "error",
            error: `ENOENT: no such file or directory\n${"trace ".repeat(200)}`,
            input: { command: "cat /tmp/missing.log" },
        }),
    ]
    const h = harness({ contextTokens: 100 })
    const stats = h.run(messages)
    assert.ok(stats.level >= 2)
    assert.equal(stats.mergedRuns, 2, "the artifact run plus the surviving bash error run")
    assert.equal(stats.excisedParts, 3)
    assert.equal(mAssistant.parts!.length, 2)
    const [editSurvivor, bashSurvivor] = mAssistant.parts!
    assert.equal(editSurvivor!.tool, "edit")
    assert.deepEqual(editSurvivor!.state!.input, {
        filePath: "/src/prio.ts",
        _merged: "edit×3 (3 err)",
    })
    assert.equal(bashSurvivor!.tool, "bash")
    assert.deepEqual(bashSurvivor!.state!.input, {
        command: "cat /tmp/missing.log",
        _merged: "bash×2 (2 err), first: ENOENT: no such file or directory",
    })
})

test("a single error never merges and stays meta-free", () => {
    const messages = buildTurns30()
    const mAssistant = messages[13]!
    mAssistant.parts = [
        toolPart({ tool: "read", output: "v", input: { filePath: "/src/solo.ts" } }),
        toolPart({
            tool: "bash",
            status: "error",
            error: `EPERM: operation not permitted\n${"detail ".repeat(200)}`,
            input: { command: "chown x" },
        }),
    ]
    const h = harness({ contextTokens: 100 })
    const stats = h.run(messages)
    assert.ok(stats.level >= 2)
    assert.equal(stats.mergedRuns, 0)
    assert.equal(stats.excisedParts, 0)
    assert.equal(mAssistant.parts!.length, 2, "nothing is excised")
    const errPart = mAssistant.parts![1]!
    assert.ok(String(errPart.state!.error).startsWith("EPERM"), "the error still folds normally")
    assert.equal((errPart.state!.input as any)._merged, undefined, "no meta without a run")
})

test("C/T red line: error chains inside the current zone never merge", () => {
    const messages = buildTurns30()
    // A single bash error on the M side of the boundary and a full adjacent
    // chain inside C: the chain is invisible to the detector by construction.
    messages[35]!.parts = [
        toolPart({
            tool: "bash",
            status: "error",
            error: "m-side boom",
            input: { command: "make m" },
        }),
    ]
    messages[37]!.parts = [
        toolPart({
            tool: "bash",
            status: "error",
            error: "c-side boom",
            input: { command: "make c" },
        }),
    ]
    messages[39]!.parts = [
        toolPart({ tool: "bash", status: "error", error: "boom 1", input: { command: "c1" } }),
        toolPart({ tool: "bash", status: "error", error: "boom 2", input: { command: "c2" } }),
        toolPart({ tool: "bash", status: "error", error: "boom 3", input: { command: "c3" } }),
    ]
    const cBefore = deepCloneMessages(messages.slice(36, 52))
    const h = harness({ contextTokens: 100 })
    const stats = h.run(messages)
    assert.equal(stats.mergedRuns, 0)
    assert.equal(stats.excisedParts, 0)
    assert.deepEqual(deepCloneMessages(messages.slice(36, 52)), cBefore, "C bytes stay untouched")
    assert.equal(messages[35]!.parts!.length, 1, "the M-side single error stays")
})

test("D-zone error chains ride the pre-excision digest and stay meta-free", () => {
    const messages = buildTurns30()
    messages[1]!.parts = [
        reasoningPart("d reasoning"),
        toolPart({
            tool: "bash",
            status: "error",
            error: `boom one\n${"d ".repeat(200)}`,
            input: { command: "make one" },
        }),
        toolPart({
            tool: "bash",
            status: "error",
            error: `boom two\n${"d ".repeat(200)}`,
            input: { command: "make two" },
        }),
        toolPart({
            tool: "bash",
            status: "error",
            error: `boom three\n${"d ".repeat(200)}`,
            input: { command: "make three" },
        }),
        textPart("d text"),
    ]
    const h = harness({ contextTokens: 100 })
    const stats = h.run(messages)
    assert.equal(stats.mergedRuns, 1)
    assert.equal(stats.excisedParts, 2)
    const digest = String(messages[0]!.parts![0]!.text)
    assert.match(digest, /bash×3/, "the digest counts the pre-merge chain length")
    assert.match(digest, /错误×3/)
    const tools = (messages[1]!.parts ?? []).filter((p) => p?.type === "tool")
    assert.equal(tools.length, 1, "one surviving error stays")
    assert.deepEqual(tools[0]!.state!.input, {}, "distant inputs clear; no meta in D")
})

test("mergeRuns: false: error chains keep the pre-merge skeleton behavior byte for byte", () => {
    const messages = buildTurns30()
    const mAssistant = messages[13]!
    mAssistant.parts = fourBashErrors()
    const h = harness({ contextTokens: 100, config: { mergeRuns: false } })
    const stats = h.run(messages)
    assert.ok(stats.level >= 2)
    assert.equal(stats.mergedRuns, 0)
    assert.equal(stats.excisedParts, 0)
    assert.equal(mAssistant.parts!.length, 4, "nothing is excised")
    for (const part of mAssistant.parts!) {
        const state = part.state!
        assert.ok(String(state.error).length <= 201, "error folds to a short line")
        assert.ok(!String(state.error).includes("\n"), "error keeps only the first line")
        assert.ok(!JSON.stringify(state.input).includes("_merged"), "no meta without merging")
    }
    assert.ok(stats.foldedErrors >= 4)
})

function buildTurns30(
    options: { toolOutputChars?: number; textChars?: number } = {},
): MessageLike[] {
    return buildTurns(30, {
        toolOutputChars: options.toolOutputChars ?? 10,
        textChars: options.textChars ?? 30,
    })
}
