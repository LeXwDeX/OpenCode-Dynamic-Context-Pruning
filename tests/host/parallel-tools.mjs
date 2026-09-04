import assert from "node:assert/strict"
import { writeFile } from "node:fs/promises"
import { join } from "node:path"
import { cleared, isSummary, sse, startPublicHost, toolParts } from "./public-fixture.mjs"

const scenario = process.argv[2] ?? "parallel-success"
assert.ok(
    ["parallel-success", "parallel-mixed", "parallel-pressure", "parallel-cancel"].includes(
        scenario,
    ),
    `unknown parallel tool scenario: ${scenario}`,
)
const pressure = scenario === "parallel-pressure"
const cancel = scenario === "parallel-cancel"
const mixed = scenario === "parallel-mixed"
const tag = `DCP_${scenario.replaceAll("-", "_").toUpperCase()}`
const warmupCount = pressure || cancel ? 0 : 10
const emissions = []
const summaryTimes = []
const call = (id, name, input) => ({ id, name, input })
const quote = (value) => `'${value.replaceAll("'", "'\\''")}'`
const resultMessages = (body) => body.messages.filter((message) => message.role === "tool")
let emittedWarmups = 0
let emittedParallel = false
let planned = []
let fixture

function onCompletion(body) {
    const serialized = JSON.stringify(body.messages)
    if (isSummary(body)) {
        summaryTimes.push(Date.now())
        return sse(body.model, {
            content: `## Goal\nPreserve ${tag}.\n## Progress\nThe parallel tool round ran.\n## Next Steps\nReport the settled results.`,
        })
    }
    if (!serialized.includes(tag)) return sse(body.model, { content: "Parallel host test" })
    let batch
    if (emittedWarmups < warmupCount) {
        const index = emittedWarmups++
        batch = [
            call(`warmup_${index}`, "read", { filePath: join(fixture.project, `${index}.txt`) }),
        ]
    } else if (!emittedParallel) {
        emittedParallel = true
        batch = planned
    } else {
        return sse(body.model, { content: `${tag} complete` })
    }
    emissions.push(batch.map((item) => item.id))
    return sse(
        body.model,
        {
            tool_calls: batch.map((item, index) => ({
                index,
                id: item.id,
                type: "function",
                function: { name: item.name, arguments: JSON.stringify(item.input) },
            })),
        },
        "tool_calls",
        pressure ? 30_000 : 10,
    )
}

function assertPairing(requests) {
    for (const body of requests) {
        const ids = body.messages
            .flatMap((message) => message.tool_calls ?? [])
            .map((item) => item.id)
        const results = resultMessages(body).map((item) => item.tool_call_id)
        assert.deepEqual(results, ids, "every request pairs all tool calls and results in order")
        assert.equal(new Set(ids).size, ids.length, "each tool call occurs once in a request")
    }
}

function assertOneStep(history, parts) {
    assert.equal(new Set(parts.map((part) => part.messageID)).size, 1)
    const message = history.find((item) => item.info.id === parts[0].messageID)
    let step = -1
    const toolSteps = new Map()
    for (const part of message.parts) {
        if (part.type === "step-start") step++
        if (part.type === "tool") toolSteps.set(part.callID, step)
    }
    assert.ok(step >= 0, "the real host persists native step markers")
    assert.equal(new Set(parts.map((part) => toolSteps.get(part.callID))).size, 1)
    assert.deepEqual(
        emissions.filter((batch) => batch.length > 1),
        [planned.map((item) => item.id)],
        "the fake model emits all siblings together in exactly one response",
    )
}

async function waitForParts(sessionID, predicate) {
    const deadline = Date.now() + 30_000
    let parts = []
    while (Date.now() < deadline) {
        parts = toolParts(await fixture.api(`/session/${sessionID}/message`))
        if (predicate(parts)) return parts
        await new Promise((resolve) => setTimeout(resolve, 25))
    }
    assert.fail(
        `expected live tool states were not observed: ${JSON.stringify(parts.map((part) => ({ callID: part.callID, state: part.state.status })))}`,
    )
}

async function assertIdle(sessionID) {
    const status = await fixture.api("/session/status")
    assert.ok(!status[sessionID] || status[sessionID].type === "idle", JSON.stringify(status))
}

function assertStored(history) {
    const all = toolParts(history)
    assert.equal(all.length, warmupCount + planned.length, "no planned tool is lost or duplicated")
    assert.equal(new Set(all.map((part) => part.callID)).size, all.length)
    for (const part of all) {
        assert.equal(
            part.state.time.compacted,
            undefined,
            "DCP must not persist projection markers",
        )
        assert.ok(["completed", "error"].includes(part.state.status), JSON.stringify(part.state))
    }
    for (let index = 0; index < warmupCount; index++) {
        const part = all.find((item) => item.callID === `warmup_${index}`)
        assert.equal(part.state.status, "completed")
        assert.equal(part.state.input.filePath, join(fixture.project, `${index}.txt`))
        assert.ok(part.state.output.includes(`WARMUP_${index}_START`))
        assert.ok(part.state.output.includes(`WARMUP_${index}_END`))
        assert.equal(part.state.output.match(/ordinary evidence remains stored/g)?.length, 700)
    }
    const parts = planned.map((item) => {
        const part = all.find((part) => part.callID === item.id)
        assert.equal(part.tool, item.name)
        assert.deepEqual(part.state.input, item.input)
        return part
    })
    assertOneStep(history, parts)
    return parts
}

function assertRecentWire(history, parts) {
    const requests = fixture.captures.filter(
        (body) => !isSummary(body) && JSON.stringify(body.messages).includes(tag),
    )
    const last = requests.at(-1)
    const results = resultMessages(last)
    assert.ok(
        last.tools.some((tool) => tool.function?.name === "dcp_prune"),
        "the real host loads the built DCP plugin",
    )
    for (const part of parts) {
        const result = results.find((item) => item.tool_call_id === part.callID)
        assert.ok(result, `the next model request includes sibling ${part.callID}`)
        if (part.state.status === "completed") assert.equal(result.content, part.state.output)
        else assert.ok(result.content.includes(part.state.error))
        assert.ok(
            !result.content.includes(cleared),
            "every sibling in the protected step stays intact",
        )
        const modelCall = last.messages
            .flatMap((message) => message.tool_calls ?? [])
            .find((item) => item.id === part.callID)
        assert.equal(modelCall.function.name, part.tool)
        assert.deepEqual(JSON.parse(modelCall.function.arguments), part.state.input)
    }
    if (warmupCount > 0) {
        const old = results.find((item) => item.tool_call_id === "warmup_0")
        assert.equal(
            old.content,
            cleared,
            "old ordinary results still prune beside the protected parallel step",
        )
        assert.ok(toolParts(history)[0].state.output.includes("WARMUP_0_START"))
    }
    assertPairing(fixture.captures)
}

try {
    fixture = await startPublicHost({
        name: scenario,
        context: pressure ? 32_000 : 64_000,
        native: pressure,
        ...(pressure ? {} : { compaction: { auto: false, prune: false, tail_turns: 0 } }),
        onCompletion,
    })
    for (let index = 0; index < warmupCount; index++) {
        await writeFile(
            join(fixture.project, `${index}.txt`),
            `WARMUP_${index}_START\n${"ordinary evidence remains stored\n".repeat(700)}WARMUP_${index}_END`,
        )
    }
    const outputs = new Map()
    for (const id of ["short", "left", "right"]) {
        // Reported usage drives this pressure case. Keep its actual results
        // below the host's separate per-tool summary truncation limit.
        const output = `PARALLEL_${id}_START\n${`original ${id} evidence\n`.repeat(pressure ? 20 : 240)}PARALLEL_${id}_END\n`
        outputs.set(id, output)
        await writeFile(join(fixture.project, `${id}.txt`), output)
    }
    const shell = (id, seconds) =>
        call(id, "bash", {
            command: `sleep ${seconds}; cat ${quote(join(fixture.project, `${id}.txt`))}`,
            description: `Isolated parallel ${id} result`,
        })
    if (cancel) {
        planned = [
            call("short", "read", { filePath: join(fixture.project, "short.txt") }),
            ...["left", "right"].map((id) =>
                call(id, "bash", {
                    command: `printf 'CANCEL_${id}_START\\n'; sleep 30; printf 'CANCEL_${id}_MISSED\\n'`,
                    description: `Isolated cancellation ${id}`,
                }),
            ),
        ]
    } else if (mixed) {
        planned = [
            call("missing", "read", { filePath: join(fixture.project, "missing.txt") }),
            call("nonzero", "bash", {
                command: "printf 'EXPECTED_NONZERO_RESULT\\n'; exit 7",
                description: "Expected unsuccessful command",
            }),
            shell("left", 2),
        ]
    } else {
        planned = [shell("left", 2), shell("right", 1)]
        if (pressure)
            planned.unshift(call("short", "read", { filePath: join(fixture.project, "short.txt") }))
    }
    const session = await fixture.api("/session", { title: scenario })
    const prompt = () =>
        fixture.api(`/session/${session.id}/message`, {
            model: { providerID: "test", modelID: "small" },
            agent: "build",
            parts: [
                {
                    type: "text",
                    text: `${tag}: Execute the requested parallel tools and report their actual outcomes.`,
                },
            ],
        })
    const pending = prompt()
    // Attach a rejection handler while the public history is being observed.
    pending.catch(() => undefined)
    let live
    let abortElapsed
    if (mixed) {
        live = await waitForParts(
            session.id,
            (parts) =>
                parts.some((part) => part.callID === "missing" && part.state.status === "error") &&
                parts.some(
                    (part) => part.callID === "nonzero" && part.state.status === "completed",
                ) &&
                parts.some((part) => part.callID === "left" && part.state.status === "running"),
        )
    } else {
        live = await waitForParts(
            session.id,
            (parts) =>
                ["left", "right"].every((id) =>
                    parts.some(
                        (part) =>
                            part.callID === id &&
                            part.state.status === "running" &&
                            (!cancel ||
                                part.state.metadata?.output?.includes(`CANCEL_${id}_START`)),
                    ),
                ) &&
                (!cancel ||
                    parts.some(
                        (part) => part.callID === "short" && part.state.status === "completed",
                    )),
        )
    }
    if (cancel) {
        const start = Date.now()
        await fixture.api(`/session/${session.id}/abort`, {})
        await pending
        abortElapsed = Date.now() - start
        assert.ok(abortElapsed < 15_000, "explicit abort stops both 30-second shells promptly")
    } else {
        const completed = await pending
        assert.ok(
            completed.parts.some((part) => part.type === "text" && part.text === `${tag} complete`),
        )
    }
    const history = await fixture.api(`/session/${session.id}/message`)
    const parts = assertStored(history)
    if (cancel) {
        const shortBefore = live.find((part) => part.callID === "short")
        assert.deepEqual(
            parts[0],
            shortBefore,
            "aborting siblings must not rewrite an already completed tool",
        )
        for (const part of parts.slice(1)) {
            const output = part.state.output ?? part.state.metadata?.output ?? ""
            assert.ok(!output.includes(`CANCEL_${part.callID}_MISSED`))
            assert.ok(
                output.includes(`CANCEL_${part.callID}_START`),
                "already produced output survives cancellation",
            )
            if (part.state.status === "completed") {
                assert.equal(part.state.metadata.exit, null)
                assert.ok(output.includes("aborted before completion"))
            } else {
                assert.equal(part.state.metadata?.interrupted, true)
                assert.match(part.state.error, /aborted/i)
            }
        }
        assert.equal(
            emissions.length,
            1,
            "explicit cancellation must not automatically execute a new round",
        )
        assert.equal(
            fixture.captures.filter(
                (body) =>
                    body.model === "small" &&
                    !isSummary(body) &&
                    JSON.stringify(body.messages).includes(tag),
            ).length,
            1,
            "the cancelled prompt must not automatically make another model request",
        )
        await assertIdle(session.id)
        await prompt()
        assert.deepEqual(
            toolParts(await fixture.api(`/session/${session.id}/message`)),
            toolParts(history),
        )
        assertRecentWire(history, parts)
        for (const id of ["left", "right"]) {
            const result = resultMessages(fixture.captures.at(-1)).find(
                (item) => item.tool_call_id === id,
            )
            assert.ok(
                result.content.includes(`CANCEL_${id}_START`),
                "explicit continuation receives partial tool output",
            )
        }
    } else if (mixed) {
        assert.equal(parts[0].state.status, "error")
        assert.match(parts[0].state.error, /not found/i)
        assert.equal(parts[1].state.status, "completed")
        assert.equal(parts[1].state.metadata.exit, 7)
        assert.equal(parts[1].state.output, "EXPECTED_NONZERO_RESULT\n")
        assert.equal(parts[2].state.status, "completed")
        assert.equal(parts[2].state.metadata.exit, 0)
        assert.equal(parts[2].state.output, outputs.get("left"))
        const running = live.find((part) => part.callID === "left")
        assert.ok(parts[2].state.time.end - running.state.time.start >= 1_900)
        assertRecentWire(history, parts)
    } else {
        for (const part of parts) {
            assert.equal(part.state.status, "completed")
            if (part.tool === "bash") {
                assert.equal(part.state.metadata.exit, 0)
                assert.equal(part.state.output, outputs.get(part.callID))
            } else {
                assert.ok(part.state.output.includes("PARALLEL_short_START"))
                assert.ok(part.state.output.includes("PARALLEL_short_END"))
            }
        }
        const left = parts.find((part) => part.callID === "left")
        const right = parts.find((part) => part.callID === "right")
        // Host metadata updates may reset the persisted start at settlement.
        // Use the public running snapshot captured while both calls were active.
        const leftStart = live.find((part) => part.callID === "left").state.time.start
        const rightStart = live.find((part) => part.callID === "right").state.time.start
        assert.ok(
            Math.max(leftStart, rightStart) < Math.min(left.state.time.end, right.state.time.end),
            "successful sibling execution intervals overlap",
        )
        assert.ok(left.state.time.end - leftStart >= 1_900)
        if (pressure) {
            const summaries = fixture.captures.filter(isSummary)
            assert.ok(summaries.length > 0, "high reported usage triggers real native compaction")
            for (const part of parts) {
                assert.ok(
                    part.state.time.end <= summaryTimes[0],
                    "every tool settles before the first native summary request",
                )
                const result = resultMessages(summaries[0]).find(
                    (item) => item.tool_call_id === part.callID,
                )
                assert.equal(
                    result?.content,
                    part.state.output,
                    "the native summary receives every original sibling result",
                )
            }
            for (const summary of summaries)
                assert.ok(!JSON.stringify(summary.messages).includes(cleared))
            assert.ok(history.some((message) => message.info.summary === true))
            assertPairing(fixture.captures)
        } else assertRecentWire(history, parts)
    }
    await assertIdle(session.id)
    process.stdout.write(
        JSON.stringify({
            scenario,
            ok: true,
            metrics: {
                runtime: pressure ? "native" : "ai-sdk",
                parallelCalls: planned.length,
                warmupCalls: warmupCount,
                outcomes: parts.map((part) => ({
                    callID: part.callID,
                    status: part.state.status,
                    exit: part.state.metadata?.exit,
                })),
                summaries: summaryTimes.length,
                prunedRequests: fixture.captures.filter(
                    (body) => !isSummary(body) && JSON.stringify(body.messages).includes(cleared),
                ).length,
                ...(cancel ? { explicitlyCancelled: true, abortElapsed } : {}),
            },
        }) + "\n",
    )
} finally {
    await fixture?.close()
}
