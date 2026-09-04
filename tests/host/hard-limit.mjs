import assert from "node:assert/strict"
import { mkdir, readFile, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { startPublicHost, sse, isSummary, toolParts, cleared } from "./public-fixture.mjs"

const scenario = process.argv[2] ?? "hard-input-limit"
assert.equal(scenario, "hard-input-limit")
const inputCap = 60_000
const readCount = 12
const tags = ["ordinary", "protected", "terminal"]
const emitted = { ordinary: 0, protected: 0, terminal: 0 }
const requests = []
const marker = (tag) => `DCP_LIMIT_${tag}`
const evidenceLine = "original hard limit evidence 0123456789abcdef"
const evidence = (tag, step) =>
    `EVIDENCE_${tag}_${step}_START\n${`${evidenceLine}\n`.repeat(700)}EVIDENCE_${tag}_${step}_END`
let fixture
const evidencePath = (tag, step) =>
    tag === "protected"
        ? join(fixture.project, tag, `step-${step}`, "CONTEXT.md")
        : join(fixture.project, tag, `step-${step}.txt`)
const ledgerPath = (tag) => join(fixture.project, `${tag}-executions.txt`)

// A deterministic input accounting rule for this HTTP provider, not a claim
// about a production tokenizer. The same cap applies to ordinary requests,
// title generation and native summaries, including their tool definitions.
const inputTokens = (body) =>
    Math.ceil(
        Buffer.byteLength(JSON.stringify({ messages: body.messages, tools: body.tools ?? [] })) / 4,
    )

fixture = await startPublicHost({
    name: "hard-input-limit",
    context: 64_000,
    output: 4_000,
    onCompletion(body) {
        const serialized = JSON.stringify(body.messages)
        const tag = tags.find((value) => serialized.includes(marker(value)))
        const kind = isSummary(body)
            ? "summary"
            : serialized.includes("Generate a title for this conversation")
              ? "title"
              : "ordinary"
        const usage = inputTokens(body)
        const accepted = usage <= inputCap
        requests.push({ tag, kind, usage, accepted, emitted: emitted[tag] ?? 0, body })
        if (!accepted) {
            process.stdout.write(
                `hard limit: rejected ${tag}/${kind} at ${usage}/${inputCap} input units\n`,
            )
            return Response.json(
                {
                    error: {
                        type: "invalid_request_error",
                        code: "context_length_exceeded",
                        message: `Input has ${usage} tokens, exceeding the ${inputCap} token context limit`,
                    },
                },
                { status: 400 },
            )
        }

        const respond = (delta, finish = "stop") => sse(body.model, delta, finish, usage)
        if (kind === "title") return respond({ content: "Hard context limit test" })
        if (kind === "summary") {
            assert.ok(tag, "native summary must identify its originating task")
            return respond({
                content: `## Goal\nFinish ${marker(tag)}.\n## Progress\nIssued ${emitted[tag]} tools including the one-time ledger append.\n## Next Steps\nContinue the remaining reads through ${readCount}; never repeat the ledger append.`,
            })
        }
        assert.ok(tag, "ordinary model requests must retain their task marker")
        assert.notEqual(tag, "terminal", "the deliberately oversized prompt cannot be accepted")
        if (emitted[tag] <= readCount) {
            const step = emitted[tag]++
            return respond(
                {
                    tool_calls: [
                        {
                            index: 0,
                            id: `call_${tag}_${step}`,
                            type: "function",
                            function: {
                                name: step === 0 ? "bash" : "read",
                                arguments: JSON.stringify(
                                    step === 0
                                        ? {
                                              command: `printf '%s\\n' '${tag}' >> '${ledgerPath(tag)}'`,
                                              description:
                                                  "Append exactly one isolated execution record",
                                          }
                                        : { filePath: evidencePath(tag, step) },
                                ),
                            },
                        },
                    ],
                },
                "tool_calls",
            )
        }
        return respond({ content: `${marker(tag)} completed all ${readCount} reads.` })
    },
})

const prompt = (sessionID, text) =>
    fixture.api(`/session/${sessionID}/message`, {
        model: { providerID: "test", modelID: "small" },
        agent: "build",
        parts: [{ type: "text", text }],
    })

async function assertIdle(sessionID) {
    const status = await fixture.api("/session/status")
    assert.ok(!status[sessionID] || status[sessionID].type === "idle", JSON.stringify(status))
}

async function completedCase(tag) {
    for (let step = 1; step <= readCount; step++) {
        const path = evidencePath(tag, step)
        await mkdir(join(path, ".."), { recursive: true })
        await writeFile(path, evidence(tag, step))
    }
    const session = await fixture.api("/session", { title: `Hard limit ${tag}` })
    const completed = await prompt(
        session.id,
        `${marker(tag)}: Append the execution ledger once, then read all ${readCount} files in order. Preserve the original requirements.`,
    )
    const history = await fixture.api(`/session/${session.id}/message`)
    const parts = toolParts(history)
    const wire = requests.filter((request) => request.tag === tag)
    assert.equal(parts.length, readCount + 1, "every planned tool must settle exactly once")
    assert.equal(emitted[tag], readCount + 1)
    assert.equal(new Set(parts.map((part) => part.callID)).size, parts.length)
    assert.deepEqual((await readFile(ledgerPath(tag), "utf8")).trim().split("\n"), [tag])
    for (let step = 0; step <= readCount; step++) {
        const part = parts[step]
        assert.equal(part.callID, `call_${tag}_${step}`)
        assert.equal(part.state.status, "completed", JSON.stringify(part.state))
        assert.equal(part.state.time.compacted, undefined, "DCP projection cannot persist")
        if (step === 0) {
            assert.equal(part.tool, "bash")
            assert.equal(part.state.metadata.exit, 0)
            continue
        }
        assert.equal(part.tool, "read")
        assert.equal(
            part.state.metadata.truncated,
            false,
            "pressure must use complete read results",
        )
        assert.ok(part.state.output.includes(`EVIDENCE_${tag}_${step}_START`))
        assert.ok(part.state.output.includes(`EVIDENCE_${tag}_${step}_END`))
        assert.equal(part.state.output.match(/original hard limit evidence/g)?.length, 700)
    }
    for (const request of wire) {
        const calls = request.body.messages.flatMap((message) => message.tool_calls ?? [])
        const results = request.body.messages.filter((message) => message.role === "tool")
        assert.deepEqual(
            calls.map((call) => call.id),
            results.map((result) => result.tool_call_id),
            "accepted and rejected requests retain tool call/result pairing",
        )
        if (request.kind === "summary") {
            assert.ok(
                !JSON.stringify(request.body.messages).includes(cleared),
                "native summaries must not receive DCP clearing markers",
            )
        }
    }
    assert.ok(
        wire.some((request) =>
            request.body.tools?.some((tool) => tool.function?.name === "dcp_prune"),
        ),
        "the tested request must load the real DCP plugin",
    )
    assert.ok(
        completed.parts.some(
            (part) =>
                part.type === "text" &&
                part.text === `${marker(tag)} completed all ${readCount} reads.`,
        ),
        JSON.stringify(completed),
    )
    await assertIdle(session.id)
    const rejected = wire.filter((request) => !request.accepted)
    const summaries = wire.filter((request) => request.kind === "summary")
    const pruned = wire.filter((request) => JSON.stringify(request.body.messages).includes(cleared))
    if (tag === "ordinary") {
        assert.equal(rejected.length, 0, "the under-limit control must never be rejected")
        assert.ok(pruned.length > 0, "DCP must make ordinary old read results fit")
    } else {
        assert.ok(rejected.length > 0, "protected history must receive a real HTTP 400")
        assert.ok(rejected.some((request) => request.kind === "ordinary"))
        assert.ok(
            summaries.some((request) => request.accepted),
            "native summary must fit the same cap",
        )
        assert.equal(pruned.length, 0, "instruction-bearing results must remain protected")
        const firstRejected = wire.findIndex((request) => !request.accepted)
        assert.ok(
            wire
                .slice(firstRejected + 1)
                .some((request) => request.kind === "ordinary" && request.accepted),
            "an ordinary request must resume after the rejected request",
        )
    }
    assert.ok(wire.length <= 40, "continuation must be bounded")
    return {
        tag,
        tools: parts.length,
        completed: parts.filter((part) => part.state.status === "completed").length,
        rejected: rejected.length,
        summaries: summaries.length,
        prunedRequests: pruned.length,
        ledgerExecutions: 1,
        inputCap,
        highestAccepted: Math.max(
            ...wire.filter((request) => request.accepted).map((request) => request.usage),
        ),
        lowestRejected: rejected.length
            ? Math.min(...rejected.map((request) => request.usage))
            : null,
    }
}

try {
    const metrics = [await completedCase("ordinary"), await completedCase("protected")]
    const terminal = await fixture.api("/session", { title: "Uncompactable hard limit" })
    const stopped = await prompt(
        terminal.id,
        `${marker("terminal")}: ${"uncompactable original user text ".repeat(10_000)}`,
    )
    const terminalHistory = await fixture.api(`/session/${terminal.id}/message`)
    const terminalWire = requests.filter((request) => request.tag === "terminal")
    assert.equal(stopped.info.finish, "error", JSON.stringify(stopped.info))
    assert.equal(stopped.info.error?.name, "ContextOverflowError", JSON.stringify(stopped.info))
    assert.equal(toolParts(terminalHistory).length, 0)
    assert.equal(emitted.terminal, 0)
    assert.ok(terminalWire.some((request) => request.kind === "ordinary" && !request.accepted))
    assert.ok(terminalWire.some((request) => request.kind === "summary" && !request.accepted))
    assert.ok(terminalWire.length <= 4, "uncompactable input must terminate without retry loops")
    assert.ok(
        terminalHistory.some((message) => message.info.error?.name === "ContextOverflowError"),
    )
    await assertIdle(terminal.id)
    metrics.push({
        tag: "terminal",
        rejected: terminalWire.filter((request) => !request.accepted).length,
        terminalError: stopped.info.error.name,
    })
    assert.ok(requests.every((request) => request.accepted === request.usage <= inputCap))
    process.stdout.write(JSON.stringify({ scenario, ok: true, metrics }) + "\n")
} catch (error) {
    process.stderr.write(
        JSON.stringify({
            scenario,
            requests: requests.map(({ body, ...request }) => request),
            emitted,
        }) + "\n",
    )
    throw error
} finally {
    await fixture.close()
}
