import assert from "node:assert/strict"
import test from "node:test"
import { DTC_DEFAULTS, estimateMessages, projectMessages } from "../lib/dtc/engine"
import type { MessageLike, PartLike } from "../lib/dtc/types"

function result(index: number, overrides: Partial<PartLike> = {}): PartLike {
    return {
        id: `part_${index}`,
        sessionID: "ses_projection",
        messageID: `msg_${index}`,
        type: "tool",
        callID: `call_${index}`,
        tool: "read",
        state: {
            status: "completed",
            input: { filePath: `/src/file-${index}.ts` },
            output: `output ${index}\n${"x".repeat(4000)}`,
            title: `Read file ${index}`,
            metadata: {},
            time: { start: index * 100, end: index * 100 + 50 },
        },
        ...overrides,
    }
}

function conversation(count = 10): MessageLike[] {
    return [
        {
            info: { id: "user", role: "user", sessionID: "ses_projection" },
            parts: [{ id: "user_text", type: "text", text: "Keep every requirement exactly." }],
        },
        ...Array.from({ length: count }, (_, index) => ({
            info: { id: `msg_${index}`, role: "assistant", sessionID: "ses_projection" },
            parts: [
                { id: `start_${index}`, type: "step-start" },
                {
                    id: `reasoning_${index}`,
                    type: "reasoning",
                    text: `Reasoning for step ${index}`,
                    metadata: { anthropic: { signature: `signature_${index}` } },
                },
                result(index),
                { id: `text_${index}`, type: "text", text: `Recorded result ${index}` },
                { id: `finish_${index}`, type: "step-finish", reason: "tool-calls" },
            ],
        })),
    ]
}

function tools(messages: readonly MessageLike[]): PartLike[] {
    return messages.flatMap((message) => message.parts ?? []).filter((part) => part.type === "tool")
}

function run(messages: MessageLike[], options: { force?: boolean; inputBudget?: number } = {}) {
    return projectMessages(messages, {
        inputBudget: options.inputBudget ?? 1000,
        config: { ...DTC_DEFAULTS, protectRecentSteps: 1, protectRecentTokens: 0 },
        now: 123456,
        ...options,
    })
}

test("one user turn with 100 tool steps folds old outputs while preserving exact source", () => {
    const source = conversation(100)
    const before = structuredClone(source)
    const projected = projectMessages(source, {
        inputBudget: 40000,
        config: DTC_DEFAULTS,
        now: 123456,
    })
    assert.ok(projected.stats.foldedTools > 0)
    assert.ok(projected.stats.protectedSteps >= 4)
    assert.ok(projected.stats.estimatedAfter! <= projected.stats.targetTokens)
    assert.deepEqual(source, before)
    assert.notEqual(projected.messages, source)
    assert.deepEqual(projected.messages.slice(-4), source.slice(-4))
    const normalized = structuredClone(projected.messages)
    for (const part of tools(normalized)) delete part.state!.time!.compacted
    assert.deepEqual(normalized, before, "only native compacted markers may differ")
})

test("under budget leaves every output intact and force still protects recent steps", () => {
    const source = conversation(4)
    assert.deepEqual(run(source, { inputBudget: 1000000 }).messages, source)
    const forced = run(source, { inputBudget: 1000000, force: true })
    assert.equal(forced.stats.foldedTools, 3)
    assert.deepEqual(forced.messages.at(-1), source.at(-1))
})

test("native steps keep parallel sibling tool results together", () => {
    const source = conversation(1)
    source[1]!.parts!.push({ type: "step-start", id: "second-step" }, result(10), result(11), {
        type: "step-finish",
        id: "second-finish",
    })
    const projected = run(source)
    assert.equal(projected.stats.foldedTools, 1)
    assert.deepEqual(tools(projected.messages).slice(-2), tools(source).slice(-2))
})

test("recent token protection expands across complete steps even beyond the target", () => {
    const source = conversation(6)
    const projected = projectMessages(source, {
        inputBudget: 1000,
        config: { ...DTC_DEFAULTS, protectRecentSteps: 1, protectRecentTokens: 2500 },
    })
    assert.equal(projected.stats.protectedSteps, 3)
    assert.deepEqual(projected.messages.slice(-3), source.slice(-3))
    assert.equal(projected.stats.overBudget, true)
})

test("compacted output estimation still includes the complete tool input", () => {
    const source = conversation(1)
    const part = tools(source)[0]!
    part.state!.input = { filePath: "/src/a.ts", content: "i".repeat(40000) }
    part.state!.time!.compacted = 1
    const compacted = estimateMessages(source)!
    assert.ok(compacted > 10000, "large input still goes to the model")
    part.state!.output = "o".repeat(400000)
    assert.equal(estimateMessages(source), compacted, "stored compacted output is not sent")
})

test("only verified successful output contracts are eligible", () => {
    const source = conversation(18)
    const parts = tools(source)
    parts[0]!.tool = "grep"
    parts[1]!.tool = "glob"
    parts[2]!.tool = "bash"
    parts[2]!.state!.metadata = { exit: 0 }
    parts[3]!.tool = "bash"
    parts[3]!.state!.metadata = { exit: 1 }
    parts[4]!.tool = "bash"
    parts[4]!.state!.metadata = {}
    parts[5]!.tool = "skill"
    parts[6]!.tool = "task"
    parts[7]!.tool = "dcp_prune"
    parts[8]!.tool = "custom_tool"
    parts[9]!.state!.status = "running"
    parts[10]!.state!.status = "pending"
    parts[11]!.state!.status = "error"
    parts[11]!.state!.error = "Precise failure evidence\nMore evidence"
    parts[12]!.state!.error = "Failure despite inconsistent completed state"
    parts[13]!.state!.attachments = [{ type: "file", url: "data:image/png;base64,AAAA" }]
    parts[14]!.state!.input = { filePath: "/repo/.agents/skills/demo/SKILL.md" }
    parts[15]!.state!.input = { filePath: "C:\\repo\\AGENTS.md" }
    parts[16]!.state!.input = { filePath: "/repo/CLAUDE.md" }
    // Attachments make the whole request's token estimate uncertain: verify
    // the candidate protections separately without that attachment first.
    const attachment = parts[13]!.state!.attachments
    parts[13]!.state!.attachments = []
    parts[13]!.tool = "unknown_attachment_tool"
    const projected = run(source, { force: true })
    assert.equal(projected.stats.foldedTools, 3)
    assert.deepEqual(tools(projected.messages).slice(3), parts.slice(3))
    parts[13]!.state!.attachments = attachment
    const uncertain = run(source, { force: true })
    assert.equal(uncertain.stats.foldedTools, 0)
    assert.equal(uncertain.stats.overBudget, true)
    assert.equal(uncertain.stats.skipped, "unknown-content")
})

test("configured protection only narrows the built-in candidate set", () => {
    const source = conversation(5)
    const projected = projectMessages(source, {
        inputBudget: 1,
        config: {
            ...DTC_DEFAULTS,
            protectRecentSteps: 1,
            protectRecentTokens: 0,
            protectedTools: ["read"],
        },
        force: true,
    })
    assert.deepEqual(projected.messages, source)
    assert.equal(projected.stats.overBudget, true)
})

test("file media and unfamiliar parts do not produce a false budget success", () => {
    for (const part of [
        { type: "file", url: "https://example.com/image.png", mime: "image/png" },
        { type: "future-host-content", payload: "opaque" },
    ]) {
        const source = conversation(8)
        source[0]!.parts!.push(part)
        const projected = run(source, { force: true })
        assert.deepEqual(projected.messages, source)
        assert.equal(projected.stats.estimatedBefore, undefined)
        assert.equal(projected.stats.overBudget, true)
        assert.equal(projected.stats.skipped, "unknown-content")
    }
})

test("small outputs and existing native markers remain unchanged", () => {
    const source = conversation(3)
    const parts = tools(source)
    parts[0]!.state!.output = "Tests passed. Keep this small result."
    parts[1]!.state!.time!.compacted = 999
    assert.deepEqual(run(source, { force: true }).messages, source)
})

test("same-input calls, hash collisions, and read pages keep independent identities", () => {
    const source = conversation(6)
    const parts = tools(source)
    parts[0]!.state!.input = { filePath: "/src/paged.ts", offset: 1, limit: 100 }
    parts[1]!.state!.input = { filePath: "/src/paged.ts", offset: 101, limit: 100 }
    for (const [index, command] of ["npm test", "npm test", "echo Aa", "echo B@"].entries()) {
        parts[index + 2]!.tool = "bash"
        parts[index + 2]!.state!.input = { command }
        parts[index + 2]!.state!.metadata = { exit: 0 }
    }
    const projected = run(source, { force: true })
    assert.equal(tools(projected.messages).length, parts.length)
    for (const [index, part] of tools(projected.messages).entries()) {
        assert.equal(part.id, parts[index]!.id)
        assert.equal(part.callID, parts[index]!.callID)
        assert.deepEqual(part.state!.input, parts[index]!.state!.input)
        assert.equal(part.state!.output, parts[index]!.state!.output)
    }
})

test("successful projection is independent of caller objects even when nothing folds", () => {
    const source = conversation(1)
    const projected = run(source, { inputBudget: 100000 })
    tools(projected.messages)[0]!.state!.input!.filePath = "/changed-only-in-copy.ts"
    assert.equal(tools(source)[0]!.state!.input!.filePath, "/src/file-0.ts")
})

test("an unsatisfiable input-heavy budget preserves all source and reports overage", () => {
    const source = conversation(3)
    for (const part of tools(source)) part.state!.input!.content = "x".repeat(80000)
    const before = structuredClone(source)
    const projected = run(source)
    assert.equal(projected.stats.overBudget, true)
    assert.ok(projected.stats.estimatedAfter! > 60000)
    assert.deepEqual(source, before)
})

test("invalid budget or policy cannot turn into unbounded compression", () => {
    const source = conversation(8)
    for (const inputBudget of [0, -1, NaN, Infinity]) {
        const projected = run(source, { inputBudget, force: true })
        assert.deepEqual(projected.messages, source)
        assert.equal(projected.stats.skipped, "invalid-budget")
    }
    assert.throws(() =>
        projectMessages(source, {
            inputBudget: 1000,
            config: { ...DTC_DEFAULTS, protectRecentSteps: -1 },
        }),
    )
})

test("native compaction history remains intact while subsequent tool steps can fold", () => {
    const source = conversation(100)
    const nativePrefix: MessageLike[] = [
        {
            info: { id: "compact_user", role: "user", sessionID: "ses_projection" },
            parts: [{ id: "compact_part", type: "compaction", auto: true }],
        },
        {
            info: {
                id: "native_summary",
                role: "assistant",
                sessionID: "ses_projection",
                summary: true,
            },
            parts: [{ id: "summary_text", type: "text", text: "Complete native checkpoint." }],
        },
        {
            info: { id: "subtask_user", role: "user", sessionID: "ses_projection" },
            parts: [{ id: "subtask_part", type: "subtask", prompt: "Delegated work" }],
        },
    ]
    source.unshift(...nativePrefix)
    const projected = projectMessages(source, {
        inputBudget: 40000,
        config: DTC_DEFAULTS,
    })
    assert.equal(projected.stats.skipped, undefined)
    assert.ok(projected.stats.foldedTools > 0)
    assert.deepEqual(projected.messages.slice(0, 3), nativePrefix)
    assert.ok(estimateMessages(nativePrefix)! > 0)
})

test("policy counts are safe integers and protected tools have nonempty names", () => {
    const source = conversation(3)
    for (const invalid of [
        { protectRecentSteps: 1.5 },
        { protectRecentSteps: Number.MAX_SAFE_INTEGER + 1 },
        { protectRecentTokens: 0.5 },
        { protectRecentTokens: Number.MAX_SAFE_INTEGER + 1 },
        { minimumSavingsTokens: 0 },
        { minimumSavingsTokens: 0.5 },
        { minimumSavingsTokens: Number.MAX_SAFE_INTEGER + 1 },
        { protectedTools: [""] },
        { protectedTools: ["   "] },
    ]) {
        assert.throws(() =>
            projectMessages(source, {
                inputBudget: 1000,
                config: { ...DTC_DEFAULTS, ...invalid },
            }),
        )
    }
})

test("a failed independent clone cannot leave partially folded source", () => {
    const source = conversation(4)
    source[3]!.parts![1]!.metadata = { unsupported: () => "not host JSON" }
    const before = JSON.stringify(source)
    assert.throws(() => run(source, { force: true }))
    assert.equal(JSON.stringify(source), before)
    assert.equal(
        tools(source).some((part) => part.state?.time?.compacted),
        false,
    )
})

test("interrupted errors count the metadata output that the host actually sends", () => {
    const source = conversation(3)
    const interrupted = tools(source)[0]!
    interrupted.tool = "bash"
    interrupted.state!.status = "error"
    interrupted.state!.error = "Tool execution aborted"
    interrupted.state!.metadata = {
        interrupted: true,
        output: "partial logs\n" + "x".repeat(80000),
    }
    assert.ok(estimateMessages(source)! > 22000)
    const projected = run(source)
    assert.deepEqual(tools(projected.messages)[0], interrupted)
    assert.equal(projected.stats.overBudget, true)
})

test("read outputs carrying dynamically loaded instructions remain intact under force", () => {
    for (const loaded of [["/repo/AGENTS.md"], "unknown-host-shape", null]) {
        const source = conversation(3)
        const read = tools(source)[0]!
        read.state!.input = { filePath: "/repo/src/ordinary.ts" }
        read.state!.metadata = { loaded }
        const projected = run(source, { force: true })
        assert.deepEqual(tools(projected.messages)[0], read)
        assert.equal(projected.stats.foldedTools, 1)
    }
})
