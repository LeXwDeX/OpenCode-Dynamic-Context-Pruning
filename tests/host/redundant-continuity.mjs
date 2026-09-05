import assert from "node:assert/strict"
import { readFile, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { cleared, isSummary, sse, startPublicHost, toolParts } from "./public-fixture.mjs"

const scenario = process.argv[2]
assert.ok(["redundant-continuity-sdk", "redundant-continuity-native"].includes(scenario))
const steps = 32
const slowStep = 25
const unique = "UNIQUE_REQUIREMENT\n" + "retain unique evidence\n".repeat(240)
const repeated = "REPEATED_EVIDENCE\n" + "same complete evidence\n".repeat(240)
let emitted = 0
let redundantAt
let summaries = 0
let summaryAfterSlow = false
let slowIssuedAt
let slowSettledAfterMs
let sessionID
let host

host = await startPublicHost({
    name: scenario,
    native: scenario.endsWith("native"),
    // The fixture supplies no DTC policy and leaves native compaction enabled.
    onCompletion: async (body) => {
        if (JSON.stringify(body).includes("Generate a title for this conversation"))
            return sse(body.model, { content: "Continuous task" })
        const usage = Math.ceil(JSON.stringify(body).length / 4)
        if (isSummary(body)) {
            summaries++
            assert.ok(!JSON.stringify(body.messages).includes(cleared))
            const status = await host.api("/session/status")
            assert.equal(status[sessionID]?.type, "busy", "compaction must not idle the task")
            if (emitted > slowStep) {
                const history = await host.api(`/session/${sessionID}/message`)
                const slow = toolParts(history).find((part) => part.callID === `call_${slowStep}`)
                assert.equal(slow?.state.status, "completed")
                assert.equal(slow.state.metadata.exit, 0, "slow tool must settle before summary")
                assert.equal(await readFile(join(host.project, "ledger.txt"), "utf8"), "once\n")
                slowSettledAfterMs ??= Date.now() - slowIssuedAt
                assert.ok(
                    slowSettledAfterMs >= 900,
                    "summary must wait for the actual slow command",
                )
                summaryAfterSlow = true
            }
            return sse(
                body.model,
                {
                    content: `DCP_CONTINUOUS_TASK: ${emitted} tools completed; continue to ${steps}.`,
                },
                "stop",
                usage,
            )
        }
        const results = body.messages.filter((message) => message.role === "tool")
        const oldCopy = results.find((message) => message.tool_call_id === "call_1")
        const onlyCopy = results.find((message) => message.tool_call_id === "call_0")
        if (
            redundantAt === undefined &&
            JSON.stringify(oldCopy?.content ?? "").includes(cleared) &&
            JSON.stringify(onlyCopy?.content ?? "").includes("UNIQUE_REQUIREMENT") &&
            results.some((message) => JSON.stringify(message.content).includes("REPEATED_EVIDENCE"))
        ) {
            redundantAt = emitted
        }
        if (emitted === steps)
            return sse(body.model, { content: "DCP_CONTINUOUS_TASK completed." }, "stop", usage)
        const step = emitted++
        const slow = step === slowStep
        if (slow) slowIssuedAt = Date.now()
        return sse(
            body.model,
            {
                tool_calls: [
                    {
                        index: 0,
                        id: `call_${step}`,
                        type: "function",
                        function: {
                            name: slow ? "bash" : "read",
                            arguments: JSON.stringify(
                                slow
                                    ? {
                                          command:
                                              "sleep 1; printf 'once\\n' >> ledger.txt; printf 'slow tool completed'",
                                          description: "Continuous task side-effect ledger",
                                      }
                                    : {
                                          filePath: join(
                                              host.project,
                                              step === 0 ? "unique.txt" : "repeated.txt",
                                          ),
                                      },
                            ),
                        },
                    },
                ],
            },
            "tool_calls",
            slow ? 62_000 : usage,
        )
    },
})

try {
    await writeFile(join(host.project, "unique.txt"), unique)
    await writeFile(join(host.project, "repeated.txt"), repeated)
    const session = await host.api("/session", { title: scenario })
    sessionID = session.id
    const completed = await host.api(`/session/${sessionID}/message`, {
        model: { providerID: "test", modelID: "small" },
        agent: "build",
        parts: [{ type: "text", text: `DCP_CONTINUOUS_TASK: execute all ${steps} tools.` }],
    })
    assert.ok(
        redundantAt > 1 && redundantAt < slowStep,
        "default policy must prune duplicates before the slow tool",
    )
    assert.ok(summaries > 0 && summaryAfterSlow, "the loop must resume after native compaction")
    assert.equal(completed.info.error, undefined)
    assert.ok(completed.parts.some((part) => part.text === "DCP_CONTINUOUS_TASK completed."))
    const parts = toolParts(await host.api(`/session/${sessionID}/message`))
    assert.equal(parts.length, steps, "no tool may disappear, replay or be skipped")
    for (const [index, part] of parts.entries()) {
        assert.equal(part.callID, `call_${index}`)
        assert.equal(part.state.status, "completed", JSON.stringify(part.state))
        assert.equal(part.state.time.compacted, undefined, "stored history must stay intact")
        if (index === slowStep) {
            assert.equal(part.state.metadata.exit, 0)
            assert.ok(part.state.output.includes("slow tool completed"))
        } else {
            assert.equal(
                part.state.input.filePath,
                join(host.project, index === 0 ? "unique.txt" : "repeated.txt"),
            )
            assert.ok(
                part.state.output.includes(
                    index === 0 ? "UNIQUE_REQUIREMENT" : "REPEATED_EVIDENCE",
                ),
            )
            assert.equal(
                part.state.output.match(
                    index === 0 ? /retain unique evidence/g : /same complete evidence/g,
                )?.length,
                240,
            )
        }
    }
    assert.equal(await readFile(join(host.project, "ledger.txt"), "utf8"), "once\n")
    for (const request of host.captures) {
        assert.deepEqual(
            request.messages.flatMap((message) => message.tool_calls ?? []).map((call) => call.id),
            request.messages
                .filter((message) => message.role === "tool")
                .map((message) => message.tool_call_id),
        )
    }
    const status = await host.api("/session/status")
    assert.equal(status[sessionID]?.type ?? "idle", "idle", "idle only after the task finishes")
    process.stdout.write(
        JSON.stringify({
            scenario,
            ok: true,
            metrics: {
                tools: parts.length,
                redundantAt,
                summaries,
                summaryAfterSlow,
                slowSettledAfterMs,
            },
        }) + "\n",
    )
} finally {
    await host.close()
}
