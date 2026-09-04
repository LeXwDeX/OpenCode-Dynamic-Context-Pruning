import assert from "node:assert/strict"
import { DTC_DEFAULTS, estimateMessages, projectMessages } from "../../lib/dtc/engine.ts"

// Offline policy comparison only. Neither prototype is imported by the plugin.
const inputBudget = 40_000
const now = 1_700_000_000_000
const batchMinimum = 512
const png = {
    id: "user_image",
    type: "file",
    mime: "image/png",
    filename: "retained.png",
    url: "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=",
}
const tools = (messages) =>
    messages.flatMap((message) => message.parts).filter((part) => part.type === "tool")

function readPart(index, chars) {
    return {
        id: `tool_${index}`,
        type: "tool",
        callID: `call_${index}`,
        tool: "read",
        state: {
            status: "completed",
            input: { filePath: `/project/evidence-${index}.txt`, offset: 1, limit: 2000 },
            output: "x".repeat(chars),
            metadata: { loaded: [] },
            time: { start: index * 100 + 1, end: index * 100 + 50 },
        },
    }
}

function history(sizes, image = false) {
    return [
        {
            info: { id: "user", role: "user", sessionID: "ses_policy" },
            parts: [
                { id: "user_text", type: "text", text: "Keep the original task constraints." },
                ...(image ? [structuredClone(png)] : []),
            ],
        },
        ...sizes.map((size, index) => ({
            info: { id: `message_${index}`, role: "assistant", sessionID: "ses_policy" },
            parts: [
                { id: `start_${index}`, type: "step-start" },
                { id: `reasoning_${index}`, type: "reasoning", text: `Reasoning ${index}` },
                readPart(index, size),
                { id: `text_${index}`, type: "text", text: `Recorded result ${index}` },
                { id: `finish_${index}`, type: "step-finish", reason: "tool-calls" },
            ],
        })),
    ]
}

function options(force, minimumSavingsTokens = 512, protectedTools = []) {
    return {
        inputBudget,
        now,
        force,
        config: { ...DTC_DEFAULTS, minimumSavingsTokens, protectedTools },
    }
}

function aggregate(source, force, protectedTools = []) {
    const proposal = projectMessages(source, options(force, 1, protectedTools))
    const before = proposal.stats.estimatedBefore
    const after = proposal.stats.estimatedAfter
    if (before !== undefined && after !== undefined && before - after >= batchMinimum) {
        return proposal
    }
    return {
        messages: structuredClone(source),
        stats: {
            ...proposal.stats,
            foldedTools: 0,
            estimatedAfter: before,
            overBudget: before === undefined || before > proposal.stats.targetTokens,
        },
    }
}

const policies = [
    {
        name: "default-512",
        run: (source, force, protectedTools) =>
            projectMessages(source, options(force, 512, protectedTools)),
    },
    {
        name: "configured-128",
        run: (source, force, protectedTools) =>
            projectMessages(source, options(force, 128, protectedTools)),
    },
    { name: "aggregate-512-prototype", run: aggregate },
]

function imageTextPrototype(source, force, protectedTools = []) {
    const planning = structuredClone(source)
    let recognizedImages = 0
    for (const message of planning) {
        if (message.info.role !== "user") continue
        message.parts = message.parts.map((part) => {
            if (part.type !== "file" || part.mime !== "image/png") return part
            recognizedImages++
            // This view ranks known text only. It is never published or used
            // as the total request estimate; the original PNG remains intact.
            return { id: part.id, type: "text", text: "" }
        })
    }
    assert.ok(recognizedImages > 0, "the prototype is scoped to an identifiable user PNG")
    const proposal = projectMessages(planning, options(force, 512, protectedTools))
    const projected = structuredClone(source)
    for (let message = 0; message < projected.length; message++) {
        for (let part = 0; part < projected[message].parts.length; part++) {
            const chosen = proposal.messages[message].parts[part]
            const original = source[message].parts[part]
            if (
                chosen.type === "tool" &&
                chosen.state.time?.compacted === now &&
                original.state.time?.compacted === undefined
            ) {
                projected[message].parts[part].state.time.compacted = now
            }
        }
    }
    assert.equal(estimateMessages(source), undefined)
    assert.equal(estimateMessages(projected), undefined)
    return {
        messages: projected,
        stats: {
            ...proposal.stats,
            estimatedBefore: undefined,
            estimatedAfter: undefined,
            overBudget: true,
            skipped: "unknown-content",
        },
        textOnly: {
            before: proposal.stats.estimatedBefore ?? null,
            after: proposal.stats.estimatedAfter ?? null,
            saved:
                proposal.stats.estimatedBefore === undefined ||
                proposal.stats.estimatedAfter === undefined
                    ? null
                    : proposal.stats.estimatedBefore - proposal.stats.estimatedAfter,
            planningSkipped: proposal.stats.skipped ?? null,
        },
    }
}

// Fixtures use one native step per assistant message, with parallel siblings
// added to the last step in protection controls. Count the entire step when
// checking both the four-step floor and the 16K recent-text floor.
function recentSteps(source) {
    const steps = source.filter((message) => message.info.role === "assistant")
    let count = 0
    let tokens = 0
    for (let index = steps.length - 1; index >= 0; index--) {
        if (count >= DTC_DEFAULTS.protectRecentSteps && tokens >= DTC_DEFAULTS.protectRecentTokens)
            break
        const estimate = estimateMessages([steps[index]])
        assert.notEqual(estimate, undefined, "the control tail must have a known text cost")
        tokens += estimate
        count++
    }
    return count
}

let verifiedProjections = 0
function verify(source, storage, projected, protectedIDs = []) {
    assert.deepEqual(source, storage, "request planning must leave storage unchanged")
    assert.notEqual(projected.messages, source)
    assert.equal(projected.messages.length, storage.length)
    const normalized = structuredClone(projected.messages)
    let added = 0
    for (let message = 0; message < storage.length; message++) {
        assert.equal(normalized[message].parts.length, storage[message].parts.length)
        for (let part = 0; part < storage[message].parts.length; part++) {
            const original = storage[message].parts[part]
            const changed = normalized[message].parts[part]
            if (changed.type !== "tool") continue
            if (changed.state.time?.compacted !== original.state.time?.compacted) {
                assert.equal(original.state.time?.compacted, undefined)
                assert.equal(changed.state.time.compacted, now)
                assert.equal(changed.state.status, "completed")
                assert.ok(!protectedIDs.includes(changed.id), `protected ${changed.id} was folded`)
                delete changed.state.time.compacted
                added++
            }
        }
    }
    assert.equal(added, projected.stats.foldedTools)
    assert.deepEqual(normalized, storage, "only new compacted markers may differ in any field")
    const recent = recentSteps(source)
    assert.deepEqual(
        projected.messages.slice(-recent),
        storage.slice(-recent),
        "complete recent steps and siblings stay intact",
    )
    const projectedTools = tools(projected.messages)
    for (const id of protectedIDs) {
        assert.deepEqual(
            projectedTools.find((part) => part.id === id),
            tools(storage).find((part) => part.id === id),
        )
    }
    verifiedProjections++
    return recent
}

function row(source, policy, force, details, protectedIDs = [], protectedTools = []) {
    const storage = structuredClone(source)
    const projection = policy.run(source, force, protectedTools)
    const verifiedRecentSteps = verify(source, storage, projection, protectedIDs)
    const stats = projection.stats
    const value = {
        ...details,
        mode: force ? "force" : "normal",
        policy: policy.name,
        estimatedBefore: stats.estimatedBefore ?? null,
        estimatedAfter: stats.estimatedAfter ?? null,
        savedTokens:
            stats.estimatedBefore === undefined || stats.estimatedAfter === undefined
                ? null
                : stats.estimatedBefore - stats.estimatedAfter,
        foldedTools: stats.foldedTools,
        protectedSteps: stats.protectedSteps,
        verifiedRecentSteps,
        targetTokens: stats.targetTokens,
        overBudget: stats.overBudget,
        skipped: stats.skipped ?? null,
        invariantsPassed: true,
        ...(projection.textOnly ? { knownTextOnly: projection.textOnly } : {}),
    }
    if (stats.estimatedAfter !== undefined)
        assert.equal(stats.overBudget, stats.estimatedAfter > stats.targetTokens)
    return value
}

const smallOutputs = []
for (const count of [20, 100, 300]) {
    for (const workload of ["small-2000", "mixed-2000-12000"]) {
        const source = history(
            Array.from({ length: count }, (_, index) =>
                workload === "mixed-2000-12000" && (index + 1) % 10 === 0 ? 12000 : 2000,
            ),
        )
        for (const force of [false, true])
            for (const policy of policies) {
                smallOutputs.push(row(source, policy, force, { workload, nativeSteps: count }))
            }
    }
}

const mediaPolicies = [policies[0], { name: "known-text-only-prototype", run: imageTextPrototype }]
const media = []
for (const count of [20, 100, 300]) {
    const source = history(Array(count).fill(8000), true)
    for (const force of [false, true])
        for (const policy of mediaPolicies) {
            const result = row(source, policy, force, {
                workload: "png-and-8000",
                nativeSteps: count,
            })
            assert.equal(result.estimatedBefore, null)
            assert.equal(result.estimatedAfter, null)
            assert.equal(result.savedTokens, null)
            assert.equal(result.overBudget, true)
            if (policy.name === "default-512") assert.equal(result.foldedTools, 0)
            media.push(result)
        }
}

// The aggregate gate is not equivalent to simply lowering a per-output value.
// One 491-token saving is rejected by a 512-token batch gate; two are accepted.
// Many tiny results show the tradeoff in deleting many outputs for little gain.
const batchGate = []
for (const [name, oldSizes] of [
    ["one-2000", [2000]],
    ["two-2000", [2000, 2000]],
    ["many-tiny-120", Array(64).fill(120)],
]) {
    const source = history([...oldSizes, ...Array(8).fill(8000)])
    for (const policy of [
        ...policies,
        {
            name: "configured-1",
            run: (input, force, protectedTools) =>
                projectMessages(input, options(force, 1, protectedTools)),
        },
    ])
        batchGate.push(
            row(source, policy, true, { workload: name, nativeSteps: oldSizes.length + 8 }),
        )
}

function protectionHistory(image = false) {
    const source = history(Array(80).fill(8000), image)
    const parts = tools(source)
    const ids = []
    const protect = (index, change) => {
        change(parts[index])
        ids.push(parts[index].id)
    }
    for (const [index, path] of [
        "/repo/CONTEXT.md",
        "C:\\repo\\AGENTS.md",
        "/repo/CLAUDE.md",
        "/repo/.agents/demo/SKILL.md",
    ].entries()) {
        protect(index, (part) => (part.state.input.filePath = path))
    }
    protect(4, (part) => (part.state.metadata.loaded = ["/repo/AGENTS.md"]))
    for (const [offset, tool] of ["skill", "task", "dcp_prune", "unknown_tool"].entries())
        protect(offset + 5, (part) => (part.tool = tool))
    protect(9, (part) => {
        part.tool = "bash"
        part.state.metadata.exit = 1
    })
    protect(10, (part) => {
        part.tool = "bash"
    })
    protect(11, (part) => {
        part.state.status = "error"
        part.state.error = "Exact failed tool evidence"
    })
    protect(12, (part) => {
        part.state.status = "running"
    })
    protect(13, (part) => {
        part.state.status = "pending"
    })
    protect(14, (part) => {
        part.state.error = "Inconsistent completed tool error"
    })
    protect(15, (part) => {
        part.tool = "grep"
    })
    protect(16, (part) => {
        part.state.time.compacted = 99
    })
    const sibling = readPart(80, 8000)
    source.at(-1).parts.splice(-1, 0, sibling)
    ids.push(sibling.id)
    return { source, ids }
}

const protections = []
for (const image of [false, true]) {
    const { source, ids } = protectionHistory(image)
    for (const force of [false, true])
        for (const policy of image ? mediaPolicies : policies) {
            protections.push(
                row(
                    source,
                    policy,
                    force,
                    {
                        workload: image ? "image-protections" : "text-protections",
                        protectedControlParts: ids.length,
                    },
                    ids,
                    ["grep"],
                ),
            )
        }
}
for (const location of ["state", "part", "metadata"]) {
    const source = history(Array(80).fill(8000), true)
    const attached = tools(source)[0]
    const target =
        location === "state"
            ? attached.state
            : location === "part"
              ? attached
              : attached.state.metadata
    target.attachments = [structuredClone(png)]
    for (const force of [false, true])
        for (const policy of mediaPolicies) {
            const result = row(source, policy, force, {
                workload: `unknown-${location}-attachment`,
            })
            assert.equal(
                result.foldedTools,
                0,
                "the image prototype cannot bypass unknown tool attachments",
            )
            assert.equal(result.estimatedAfter, null)
            protections.push(result)
        }
}

process.stdout.write(
    JSON.stringify(
        {
            experimentVersion: 1,
            source: "lib/dtc/engine.ts; no production changes",
            inputBudget,
            targetTokens: inputBudget * DTC_DEFAULTS.targetRatio,
            defaults: DTC_DEFAULTS,
            estimator:
                "production estimateTokens; synthetic ASCII payloads; not a provider tokenizer",
            scope: "offline projected message copies only; no host dispatch, media token pricing, or model quality measurement",
            smallOutputs,
            media,
            batchGate,
            protections,
            verification: {
                verifiedProjections,
                inputStorageUnchanged: true,
                onlyNewCompactedMarkers: true,
                completeRecentStepsRetained: true,
                protectedControlPartsRetained: true,
            },
        },
        null,
        2,
    ) + "\n",
)
