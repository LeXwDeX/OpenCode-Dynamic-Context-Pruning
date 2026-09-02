import assert from "node:assert/strict"
import test from "node:test"
import {
    ARTIFACT_MAX_GAP,
    exciseItems,
    extractTarget,
    findArtifactRuns,
    findDuplicateRuns,
    findErrorRuns,
    mergeMeta,
    resolveRuns,
    stableInputHash,
    type MergeItem,
} from "../lib/dtc/merge"
import { DEFAULT_DTC, VALID_CONFIG_KEYS, validateConfigTypes } from "../lib/config"

/** Contract pinned by the #23 grilling decisions D1–D8. */

function item(overrides: Partial<MergeItem> = {}): MergeItem {
    return {
        tool: "edit",
        status: "completed",
        target: "a.ts",
        inputHash: "h-default",
        turn: 0,
        isError: false,
        ...overrides,
    }
}

test("artifact: adjacent same-target chain is one run, survivor is the last member", () => {
    const seq = [item({ inputHash: "h1" }), item({ inputHash: "h2" }), item({ inputHash: "h3" })]
    const runs = findArtifactRuns(seq)
    assert.equal(runs.length, 1)
    assert.deepEqual(runs[0]!.members, [0, 1, 2])
    assert.equal(runs[0]!.survivor, 2)
    assert.equal(runs[0]!.kind, "artifact")
    assert.equal(runs[0]!.target, "a.ts")
})

test("artifact: mixed mergeable tools on one target form one run", () => {
    const seq = [item({ tool: "read" }), item({ tool: "edit" }), item({ tool: "read" })]
    const runs = findArtifactRuns(seq)
    assert.equal(runs.length, 1)
    assert.equal(runs[0]!.survivor, 2)
})

test("artifact: runs are per-target — interleaved other-target ops neither join nor break a run", () => {
    const seq = [item({ target: "a.ts" }), item({ target: "b.ts" }), item({ target: "a.ts" })]
    const runs = findArtifactRuns(seq)
    // a.ts merges across the b.ts edit (other-target ops don't consume the gap
    // budget — measured prototype semantics, #23 D3); b.ts appears once, no run
    assert.equal(runs.length, 1)
    assert.equal(runs[0]!.target, "a.ts")
    assert.deepEqual(runs[0]!.members, [0, 2])
})

test("artifact: bounded interleave bridges up to ARTIFACT_MAX_GAP other calls (D3)", () => {
    assert.equal(ARTIFACT_MAX_GAP, 2)
    // edit A, bash, grep, edit A — gap of exactly 2 bridges
    const bridged = [
        item({}),
        item({ tool: "bash", target: null }),
        item({ tool: "grep", target: null }),
        item({}),
    ]
    const runs = findArtifactRuns(bridged)
    assert.equal(runs.length, 1)
    assert.deepEqual(runs[0]!.members, [0, 3])
    // gap of 3 does not bridge
    const notBridged = [
        item({}),
        item({ tool: "bash", target: null }),
        item({ tool: "grep", target: null }),
        item({ tool: "glob", target: null }),
        item({}),
    ]
    assert.equal(findArtifactRuns(notBridged).length, 0)
})

test("artifact: a bridged same-target call is a member, not a gap", () => {
    // edit A, edit A, bash, edit A — the second edit resets the gap counter
    const seq = [item({}), item({}), item({ tool: "bash", target: null }), item({})]
    const runs = findArtifactRuns(seq)
    assert.equal(runs.length, 1)
    assert.deepEqual(runs[0]!.members, [0, 1, 3])
})

test("artifact: runs never cross user-turn boundaries (D6)", () => {
    const seq = [item({ turn: 0 }), item({ turn: 1 })]
    assert.equal(findArtifactRuns(seq).length, 0)
    // same turn still merges even when a turn change happened earlier in seq
    const mixed = [item({ turn: 0 }), item({ turn: 1 }), item({ turn: 1 })]
    const runs = findArtifactRuns(mixed)
    assert.equal(runs.length, 1)
    assert.deepEqual(runs[0]!.members, [1, 2])
})

test("artifact: single operations and non-mergeable tools never form runs", () => {
    assert.equal(findArtifactRuns([item()]).length, 0)
    const bashWithTarget = [
        item({ tool: "bash", target: "a.ts" }),
        item({ tool: "bash", target: "a.ts" }),
    ]
    assert.equal(findArtifactRuns(bashWithTarget).length, 0)
})

test("artifact: error members are counted in errCount", () => {
    const seq = [
        item({ isError: true, status: "error" }),
        item({ isError: true, status: "error" }),
        item({}),
    ]
    const runs = findArtifactRuns(seq)
    assert.equal(runs.length, 1)
    assert.equal(runs[0]!.errCount, 2)
})

test("error: adjacent same-tool error chain, survivor last, single errors are not runs", () => {
    const seq = [
        item({ tool: "bash", target: null, isError: true, status: "error", errLine: "boom root" }),
        item({ tool: "bash", target: null, isError: true, status: "error", errLine: "boom 2" }),
        item({ tool: "bash", target: null, isError: true, status: "error", errLine: "boom final" }),
    ]
    const runs = findErrorRuns(seq)
    assert.equal(runs.length, 1)
    assert.deepEqual(runs[0]!.members, [0, 1, 2])
    assert.equal(runs[0]!.survivor, 2)
    assert.equal(runs[0]!.errCount, 3)
    assert.equal(findErrorRuns([seq[0]!]).length, 0)
})

test("error: mixed tools, completed calls, and turn changes break the chain", () => {
    const mixedTools = [
        item({ tool: "bash", target: null, isError: true }),
        item({ tool: "grep", target: null, isError: true }),
    ]
    assert.equal(findErrorRuns(mixedTools).length, 0)
    const interrupted = [
        item({ tool: "bash", target: null, isError: true }),
        item({ tool: "bash", target: null, isError: false }),
        item({ tool: "bash", target: null, isError: true }),
    ]
    assert.equal(findErrorRuns(interrupted).length, 0)
    const crossTurn = [
        item({ tool: "bash", target: null, isError: true, turn: 0 }),
        item({ tool: "bash", target: null, isError: true, turn: 1 }),
    ]
    assert.equal(findErrorRuns(crossTurn).length, 0)
})

test("duplicate: identical (tool, input hash) groups keep the last occurrence, across turns (D8)", () => {
    const seq = [
        item({ tool: "grep", target: null, inputHash: "hx", turn: 0 }),
        item({ tool: "bash", target: null, inputHash: "hy", turn: 0 }),
        item({ tool: "grep", target: null, inputHash: "hx", turn: 3 }),
    ]
    const runs = findDuplicateRuns(seq)
    assert.equal(runs.length, 1)
    assert.deepEqual(runs[0]!.members, [0, 2])
    assert.equal(runs[0]!.survivor, 2)
    // different tool or different hash never group
    const noDup = [
        item({ tool: "grep", target: null, inputHash: "h1" }),
        item({ tool: "glob", target: null, inputHash: "h1" }),
        item({ tool: "grep", target: null, inputHash: "h2" }),
    ]
    assert.equal(findDuplicateRuns(noDup).length, 0)
})

test("resolveRuns: artifact outranks error and duplicate; overlap drops the whole lower run", () => {
    // two failed adjacent edits on a.ts: artifact run AND error run cover [0,1];
    // a duplicate run overlaps partially via index 2
    const seq = [
        item({ isError: true, status: "error", inputHash: "h1" }),
        item({ isError: true, status: "error", inputHash: "h2" }),
        item({ tool: "grep", target: null, inputHash: "hg" }),
        item({ tool: "grep", target: null, inputHash: "hg" }),
    ]
    const artifacts = findArtifactRuns(seq)
    const errors = findErrorRuns(seq)
    const duplicates = findDuplicateRuns(seq)
    assert.equal(artifacts.length, 1)
    assert.equal(errors.length, 1)
    const resolved = resolveRuns(seq, artifacts, errors, duplicates)
    assert.deepEqual(
        resolved.runs.map((run) => run.kind),
        ["artifact", "duplicate"],
    )
    assert.deepEqual([...resolved.drops].sort(), [0, 2])
    assert.equal(resolved.metas.get(1), "edit×2 (2 err)")
    assert.equal(resolved.metas.get(3), "grep×2")
})

test("mergeMeta: tool labels, error counts, and the first-error line (D5)", () => {
    const seq = [
        item({ tool: "bash", target: null, isError: true, errLine: "root cause line" }),
        item({ tool: "bash", target: null, isError: true, errLine: "final cascade" }),
    ]
    const run = findErrorRuns(seq)[0]!
    assert.equal(mergeMeta(run, seq), "bash×2 (2 err), first: root cause line")
    // mixed-tool artifact chains label as ops
    const mixed = [item({ tool: "read" }), item({ tool: "edit" })]
    const mixedRun = findArtifactRuns(mixed)[0]!
    assert.equal(mergeMeta(mixedRun, mixed), "ops×2")
    // first-error line is capped at 40 characters
    const long = "x".repeat(80)
    const longSeq = [
        item({ tool: "bash", target: null, isError: true, errLine: long }),
        item({ tool: "bash", target: null, isError: true, errLine: "y" }),
    ]
    const meta = mergeMeta(findErrorRuns(longSeq)[0]!, longSeq)
    assert.equal(meta, `bash×2 (2 err), first: ${"x".repeat(40)}`)
})

test("exciseItems: keeps order, never empties a non-empty list, ignores foreign indices", () => {
    const items = ["p0", "p1", "p2", "p3"]
    assert.deepEqual(exciseItems(items, new Set([1, 2])), ["p0", "p3"])
    assert.deepEqual(exciseItems(items, new Set()), items)
    // never-empty: dropping everything keeps the highest valid dropped item
    assert.deepEqual(exciseItems(items, new Set([0, 1, 2, 3])), ["p3"])
    // foreign indices (out of range) cannot empty the list either
    assert.deepEqual(exciseItems(items, new Set([0, 1, 2, 3, 99])), ["p3"])
    assert.deepEqual(exciseItems([], new Set([0])), [])
    // input is not mutated
    assert.deepEqual(items, ["p0", "p1", "p2", "p3"])
})

test("stableInputHash and extractTarget are deterministic and key-order independent", () => {
    assert.equal(
        stableInputHash({ a: 1, b: [2, { c: 3 }] }),
        stableInputHash({ b: [2, { c: 3 }], a: 1 }),
    )
    assert.notEqual(stableInputHash({ a: 1 }), stableInputHash({ a: 2 }))
    assert.equal(extractTarget({ filePath: "x.ts", path: "y.ts" }), "x.ts")
    assert.equal(extractTarget({ directory: "docs" }), "docs")
    assert.equal(extractTarget({ command: "ls" }), null)
    assert.equal(extractTarget(null), null)
    assert.equal(extractTarget("str"), null)
})

test("detectors are deterministic across repeated calls", () => {
    const seq = [
        item({ inputHash: "h1" }),
        item({ tool: "bash", target: null, isError: true }),
        item({ tool: "bash", target: null, isError: true }),
        item({ inputHash: "h2" }),
    ]
    const first = resolveRuns(
        seq,
        findArtifactRuns(seq),
        findErrorRuns(seq),
        findDuplicateRuns(seq),
    )
    const second = resolveRuns(
        seq,
        findArtifactRuns(seq),
        findErrorRuns(seq),
        findDuplicateRuns(seq),
    )
    assert.deepEqual(first, second)
})

test("config surface: mergeRuns defaults true, is a valid key, and rejects non-booleans", () => {
    assert.equal(DEFAULT_DTC.mergeRuns, true)
    assert.ok(VALID_CONFIG_KEYS.has("dtc.mergeRuns"))
    assert.deepEqual(validateConfigTypes({ dtc: { mergeRuns: true } }), [])
    const errors = validateConfigTypes({ dtc: { mergeRuns: "yes" } })
    assert.equal(errors.length, 1)
    assert.equal(errors[0]!.key, "dtc.mergeRuns")
})
