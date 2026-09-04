import assert from "node:assert/strict"
import { mkdtemp, mkdir, writeFile, rm, symlink } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { pathToFileURL, fileURLToPath } from "node:url"
import { createServer } from "node:net"
import { binaryEnvironment, binarySettingsFrom, startBinaryHost } from "./binary-runtime.mjs"

// A separate Bun process runs the complete host HTTP server with its default
// service graph. All mutations below go through the public session API.
const scenario = process.argv[2] ?? "public-host-loop"
const settings = {
    "public-host-loop": { steps: 100, context: 32_000, tags: ["A", "B"] },
    "automatic-64k": { steps: 56, context: 64_000, tags: ["A", "B"] },
    "automatic-32k": { steps: 40, context: 32_000, tags: ["A"] },
    "native-slow-tool": { steps: 6, context: 32_000, tags: ["A", "B"] },
}[scenario]
assert.ok(settings, `unknown public host scenario: ${scenario}`)
const automatic = scenario !== "public-host-loop"
const native = scenario === "native-slow-tool"
const binarySettings = binarySettingsFrom(process.env)
assert.ok(!binarySettings || native, "binary matrix uses the slow-tool lifecycle scenario")
const hostRoot = process.env.DCP_HOST_ROOT
assert.ok(binarySettings || hostRoot, "run this suite with a host test runner")
const scratch = await mkdtemp(join(binarySettings?.output ?? tmpdir(), "dcp-public-loop-"))
const project = join(scratch, "project")
await mkdir(project)
for (const key of [
    "XDG_DATA_HOME",
    "XDG_CACHE_HOME",
    "XDG_CONFIG_HOME",
    "XDG_STATE_HOME",
    "OPENCODE_TEST_HOME",
    "OPENCODE_TEST_MANAGED_CONFIG_DIR",
    "OPENCODE_CONFIG_DIR",
]) {
    process.env[key] = join(scratch, key)
    await mkdir(process.env[key], { recursive: true })
}
for (const key of [
    "OPENCODE_CONFIG",
    "OPENCODE_CONFIG_CONTENT",
    "OPENCODE_SERVER_PASSWORD",
    "OPENCODE_SERVER_USERNAME",
])
    delete process.env[key]
process.env.OPENCODE_DB = join(scratch, "host.sqlite")
process.env.OPENCODE_DISABLE_MODELS_FETCH = "true"
process.env.OPENCODE_MODELS_PATH = binarySettings
    ? join(scratch, "models-api.json")
    : join(hostRoot, "packages/opencode/test/tool/fixtures/models-api.json")
if (binarySettings) await writeFile(process.env.OPENCODE_MODELS_PATH, "{}")
process.env.OPENCODE_DISABLE_DEFAULT_PLUGINS = "true"
process.env.OPENCODE_DISABLE_LSP_DOWNLOAD = "true"
process.env.OPENCODE_EXPERIMENTAL_EVENT_SYSTEM = "true"
process.env.OPENCODE_EXPERIMENTAL_NATIVE_LLM = String(binarySettings?.native ?? native)
process.env.OPENCODE_PRINT_LOGS = "1"
process.env.OPENCODE_LOG_LEVEL = "ERROR"

const captures = []
const binaryObservations = []
const cleared = "[Old tool result content cleared]"
const steps = settings.steps
// The model's progress survives native summaries, which deliberately remove old
// tool calls from later requests. Each session has a distinct task tag.
const emitted = { A: 0, B: 0 }
const isSummary = (body) =>
    [
        "Create a new anchored summary from the conversation history.",
        "Update the anchored summary below using the conversation history above.",
    ].some((text) => JSON.stringify(body.messages).includes(text))
// Larger late files make the protected recent steps eventually cross the
// native context boundary, after earlier ordinary outputs were DCP candidates.
const evidenceLines = (step) => (scenario === "automatic-64k" && step >= 32 ? 1_600 : 240)
const evidence = (tag, step) =>
    `EVIDENCE_${tag}_${step}_START\n${"original tool evidence\n".repeat(evidenceLines(step))}EVIDENCE_${tag}_${step}_END`
const evidencePath = (tag, step) =>
    !automatic && step === 1
        ? join(project, tag, "CONTEXT.md")
        : join(project, `${tag}-${step}.txt`)
for (const tag of settings.tags) {
    if (!automatic) await mkdir(join(project, tag))
    for (let step = 0; step < steps; step++)
        await writeFile(evidencePath(tag, step), evidence(tag, step))
}

function sse(model, delta, finish = "stop", usage = 10) {
    const chunk = (value, reason = null) => ({
        id: "chatcmpl-local",
        object: "chat.completion.chunk",
        created: 1,
        model,
        choices: [{ index: 0, delta: value, finish_reason: reason }],
    })
    return new Response(
        [
            chunk({ role: "assistant" }),
            chunk(delta),
            {
                ...chunk({}, finish),
                usage: { prompt_tokens: usage, completion_tokens: 1, total_tokens: usage + 1 },
            },
        ]
            .map((item) => `data: ${JSON.stringify(item)}\n\n`)
            .join("") + "data: [DONE]\n\n",
        {
            headers: { "Content-Type": "text/event-stream" },
        },
    )
}

// Only the external model endpoint is replaced. The host config/provider
// catalog, plugin loader, prompt loop, tools, processor and storage stay real.
const modelServer = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
        assert.equal(new URL(request.url).pathname, "/v1/chat/completions")
        const body = await request.json()
        const serialized = JSON.stringify(body.messages)
        const tag = settings.tags.find((value) => serialized.includes(`DCP_CASE_${value}`))
        let usage = automatic ? Math.ceil(JSON.stringify(body).length / 4) : 10
        // This completed model response already exceeds a 32K input budget.
        // Its pending slow tool must settle before automatic compaction begins.
        if (native && tag === "A" && emitted.A === 0 && !isSummary(body)) usage = 30_000
        captures.push({ ...body, auditUsage: usage, auditEmitted: tag ? emitted[tag] : 0 })
        const respond = (delta, finish = "stop") => sse(body.model, delta, finish, usage)
        if (JSON.stringify(body).includes("Generate a title for this conversation"))
            return respond({ content: "Host integration test" })
        if (isSummary(body)) {
            assert.ok(tag, "the native summary must preserve the originating task")
            return respond({
                content: automatic
                    ? `## Goal\nPreserve DCP_CASE_${tag} requirements.\n## Progress\nExecuted ${emitted[tag]} tools.\n## Next Steps\nContinue through tool ${steps}, then report complete.`
                    : "## Goal\nPreserve DCP_CASE_A requirements.\n## Progress\nRead all 100 files.\n## Next Steps\nReport complete.",
            })
        }
        if (serialized.includes("DCP_RESUME")) return respond({ content: "DCP_RESUME complete." })
        if (!tag) return respond({ content: "Host integration test" })
        if (emitted[tag] < steps) {
            const step = emitted[tag]++
            if (step % 25 === 0)
                process.stdout.write(
                    `host ${scenario}/${tag}: starting tool ${step + 1}/${steps}\n`,
                )
            const slow = native && step === 0
            return respond(
                {
                    tool_calls: [
                        {
                            index: 0,
                            id: `call_${tag}_${step}`,
                            type: "function",
                            function: {
                                name: slow ? "bash" : "read",
                                arguments: JSON.stringify(
                                    slow
                                        ? {
                                              command:
                                                  tag === "A"
                                                      ? "sleep 2"
                                                      : "sleep 30; printf DCP_CANCEL_MISSED",
                                              description: "Isolated slow tool regression",
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
        return respond({ content: `DCP_CASE_${tag} completed all ${steps} tools.` })
    },
})

const model = (id, context) => ({
    id,
    name: id,
    attachment: false,
    reasoning: false,
    temperature: false,
    tool_call: true,
    release_date: "2025-01-01",
    limit: { context, output: 4_000 },
    cost: { input: 0, output: 0 },
    options: {},
})
await writeFile(
    join(project, "opencode.json"),
    JSON.stringify({
        $schema: "https://opencode.ai/config.json",
        plugin: [
            pathToFileURL(fileURLToPath(new URL("../../dist/index.js", import.meta.url))).href,
        ],
        model: "test/small",
        small_model: "test/large",
        permission: "allow",
        lsp: false,
        ...(!automatic ? { compaction: { auto: false, prune: false, tail_turns: 0 } } : {}),
        provider: {
            test: {
                name: "Local test",
                id: "test",
                env: [],
                npm: "@ai-sdk/openai-compatible",
                options: { apiKey: "local-test-only", baseURL: `${modelServer.url.origin}/v1` },
                models: {
                    small: model("small", settings.context),
                    large: model("large", 2_000_000),
                },
            },
        },
    }),
)
await mkdir(join(process.env.XDG_CONFIG_HOME, "opencode"), { recursive: true })
// Install the selected peer locally in each fresh config directory.
// This avoids unrelated registry downloads during host bootstrap without
// replacing the loader, config service or any host implementation.
for (const directory of [
    join(process.env.XDG_CONFIG_HOME, "opencode"),
    process.env.OPENCODE_CONFIG_DIR,
]) {
    const scope = join(directory, "node_modules/@opencode-ai")
    await mkdir(scope, { recursive: true })
    const peer = binarySettings
        ? fileURLToPath(new URL("../../node_modules/@opencode-ai/plugin", import.meta.url))
        : join(hostRoot, "packages/plugin")
    await symlink(peer, join(scope, "plugin"), "dir")
}
await writeFile(
    join(process.env.XDG_CONFIG_HOME, "opencode/dcp.jsonc"),
    JSON.stringify({
        enabled: binarySettings?.enabled ?? true,
        autoUpdate: false,
    }),
)

const reservation = createServer()
await new Promise((resolve) => reservation.listen(0, "127.0.0.1", resolve))
const port = reservation.address().port
await new Promise((resolve) => reservation.close(resolve))
let listener
async function api(path, body) {
    listener.assertRunning?.()
    const response = await fetch(new URL(path, listener.url), {
        method: body === undefined ? "GET" : "POST",
        headers: { "Content-Type": "application/json", "x-opencode-directory": project },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(150_000),
    })
    const text = await response.text()
    assert.ok(response.ok, `${path}: ${response.status}: ${text}`)
    return text ? JSON.parse(text) : undefined
}
const prompt = (sessionID, tag, modelID) =>
    api(`/session/${sessionID}/message`, {
        model: { providerID: "test", modelID },
        agent: "build",
        parts: [
            {
                type: "text",
                text: `DCP_CASE_${tag}: Execute all ${steps} tools in order and preserve the original constraints.`,
            },
            ...(scenario === "automatic-64k" && tag === "B"
                ? [
                      {
                          type: "file",
                          mime: "text/plain",
                          filename: "B-0.txt",
                          url: pathToFileURL(join(project, "B-0.txt")).href,
                      },
                  ]
                : []),
        ],
    })
const toolParts = (messages) =>
    messages.flatMap((message) => message.parts).filter((part) => part.type === "tool")
const requestsFor = (tag) =>
    captures.filter((body) => JSON.stringify(body.messages).includes(`DCP_CASE_${tag}`))

async function automaticPressure() {
    const metrics = []
    const tags = native ? ["A"] : settings.tags
    for (const tag of tags) {
        const session = await api("/session", { title: `${scenario} ${tag}` })
        const completed = await prompt(session.id, tag, "small")
        const history = await api(`/session/${session.id}/message`)
        if (binarySettings)
            await writeFile(
                join(binarySettings.output, `history-${tag}.json`),
                JSON.stringify(history, null, 2),
            )
        const parts = toolParts(history)
        const requests = requestsFor(tag)
        const summaries = requests.filter(isSummary)
        const ordinary = requests.filter((body) => !isSummary(body))
        const firstSummary = requests.findIndex(isSummary)
        const beforeSummary = requests.slice(0, firstSummary < 0 ? undefined : firstSummary)
        const prunedBeforeSummary = beforeSummary.filter((body) =>
            JSON.stringify(body.messages).includes(cleared),
        ).length
        for (const request of requests) {
            assert.deepEqual(
                request.messages
                    .flatMap((message) => message.tool_calls ?? [])
                    .map((call) => call.id),
                request.messages
                    .filter((message) => message.role === "tool")
                    .map((message) => message.tool_call_id),
                "every ordinary and summary request keeps tool calls paired with their results",
            )
        }
        const metric = {
            tag,
            context: settings.context,
            tools: parts.length,
            completed: parts.filter((part) => part.state.status === "completed").length,
            summaries: summaries.length,
            prunedBeforeSummary,
            prunedRequests: ordinary.filter((body) =>
                JSON.stringify(body.messages).includes(cleared),
            ).length,
            highestUsage: Math.max(...ordinary.map((body) => body.auditUsage)),
            ...(binarySettings
                ? {
                      pluginToolObserved: ordinary.some((body) =>
                          body.tools?.some((tool) => tool.function?.name === "dcp_prune"),
                      ),
                      successfulTools: parts.filter(
                          (part) =>
                              part.state.status === "completed" &&
                              (part.tool !== "bash" || part.state.metadata?.exit === 0),
                      ).length,
                      firstTool: {
                          tool: parts[0]?.tool,
                          status: parts[0]?.state.status,
                          exit: parts[0]?.state.metadata?.exit ?? null,
                          error: parts[0]?.state.error,
                          durationMs: parts[0]?.state.time?.end - parts[0]?.state.time?.start,
                      },
                  }
                : {}),
        }
        metrics.push(metric)
        if (binarySettings) {
            binaryObservations.push(metric)
            assert.equal(
                metric.pluginToolObserved,
                binarySettings.enabled,
                "DCP tool presence must match its configured switch",
            )
        }
        process.stdout.write(JSON.stringify(metric) + "\n")
        assert.equal(
            parts.length,
            steps,
            "the real host must execute every planned tool exactly once",
        )
        assert.equal(emitted[tag], steps)
        for (let step = 0; step < steps; step++) {
            const part = parts[step]
            assert.equal(part.callID, `call_${tag}_${step}`)
            assert.equal(part.state.status, "completed", JSON.stringify(part.state))
            assert.equal(
                part.state.time.compacted,
                undefined,
                "request projection must not persist",
            )
            if (native && step === 0) {
                assert.equal(part.tool, "bash")
                assert.equal(
                    part.state.metadata.exit,
                    0,
                    "automatic compaction must let slow bash exit successfully",
                )
                assert.ok(part.state.time.end - part.state.time.start >= 1_900)
            } else {
                assert.equal(part.tool, "read")
                assert.ok(part.state.output.includes(`EVIDENCE_${tag}_${step}_START`))
                assert.ok(part.state.output.includes(`EVIDENCE_${tag}_${step}_END`))
                assert.equal(
                    part.state.output.match(/original tool evidence/g)?.length,
                    evidenceLines(step),
                    "full tool output remains in storage",
                )
            }
        }
        assert.ok(
            completed.parts.some(
                (part) =>
                    part.type === "text" &&
                    part.text === `DCP_CASE_${tag} completed all ${steps} tools.`,
            ),
            "the public prompt must complete after automatic continuation",
        )
        assert.ok(
            summaries.length >= (scenario === "automatic-32k" ? 2 : 1),
            "growing reported usage must trigger real native compaction",
        )
        assert.ok(summaries[0].auditEmitted < steps, "native summary occurs before task completion")
        for (const summary of summaries) {
            assert.ok(
                !JSON.stringify(summary.messages).includes(cleared),
                "native summary must never receive DCP markers",
            )
            assert.ok(
                summary.messages.some((message) => message.role === "tool"),
                "native summary includes actual tool history",
            )
        }
        assert.ok(
            history.some((message) => message.info.summary === true),
            "native summaries are persisted",
        )
        assert.equal(
            ordinary.some((body) => body.tools.some((tool) => tool.function?.name === "dcp_prune")),
            binarySettings?.enabled ?? true,
            "the built plugin must match its configured switch",
        )
        if (scenario === "automatic-64k") {
            assert.ok(
                prunedBeforeSummary > 0,
                `${tag}: DCP must prune before the first native summary`,
            )
            const clearedResult = beforeSummary
                .flatMap((body) => body.messages)
                .find(
                    (message) =>
                        message.role === "tool" &&
                        JSON.stringify(message.content).includes(cleared),
                )
            assert.ok(clearedResult)
            const originalResult = summaries[0].messages.find(
                (message) =>
                    message.role === "tool" && message.tool_call_id === clearedResult.tool_call_id,
            )
            assert.ok(
                originalResult,
                "summary must contain the same previously cleared tool result",
            )
            assert.ok(
                JSON.stringify(originalResult.content).includes(`EVIDENCE_${tag}_`),
                "summary receives original output that DCP previously cleared on the ordinary wire",
            )
            if (tag === "B")
                assert.ok(
                    history[0].parts.some((part) => part.type === "file"),
                    "the legal file reference must survive host persistence",
                )
        }
    }
    return metrics
}

async function explicitCancellation() {
    const session = await api("/session", { title: "Explicit cancellation" })
    const cancelStarted = Date.now()
    const pending = prompt(session.id, "B", "small")
    void pending.catch(() => undefined)
    let settled = false
    try {
        let running = false
        for (let attempt = 0; attempt < 100; attempt++) {
            const history = await api(`/session/${session.id}/message`)
            if (toolParts(history).some((part) => part.state.status === "running")) {
                running = true
                break
            }
            await new Promise((resolve) => setTimeout(resolve, 25))
        }
        assert.ok(running, "explicit cancellation must target an actually running tool")
        await api(`/session/${session.id}/abort`, {})
        await pending
        settled = true
        const history = await api(`/session/${session.id}/message`)
        if (binarySettings)
            await writeFile(
                join(binarySettings.output, "history-cancel.json"),
                JSON.stringify(history, null, 2),
            )
        const cancelled = toolParts(history)
        assert.equal(cancelled.length, 1)
        // The real shell returns a settled result on cancellation. Its null
        // exit status and explicit abort note distinguish it from success.
        assert.equal(cancelled[0].state.status, "completed")
        assert.equal(cancelled[0].state.metadata.exit, null)
        assert.ok(cancelled[0].state.output.includes("aborted before completion"))
        assert.ok(!cancelled[0].state.output.includes("DCP_CANCEL_MISSED"))
        assert.ok(
            Date.now() - cancelStarted < 15_000,
            "explicit abort must stop the 30-second shell promptly",
        )
        assert.equal(emitted.B, 1, "cancelled session must not automatically continue")
        return { tag: "B", explicitlyCancelled: true }
    } finally {
        if (!settled) {
            await api(`/session/${session.id}/abort`, {}).catch(() => undefined)
            await pending.catch(() => undefined)
        }
    }
}

async function baselineScenario() {
    const a = await api("/session", { title: "DCP public loop A" })
    const b = await api("/session", { title: "DCP public loop B" })
    process.stdout.write("host: isolated sessions created\n")
    // Concurrent sessions take different current-model budgets through the
    // unmodified SDK catalog endpoint and actual host prompt loop.
    await Promise.all([prompt(a.id, "A", "small"), prompt(b.id, "B", "large")])
    const aHistory = await api(`/session/${a.id}/message`)
    const bHistory = await api(`/session/${b.id}/message`)
    for (const [tag, history] of [
        ["A", aHistory],
        ["B", bHistory],
    ]) {
        const parts = toolParts(history)
        assert.equal(parts.length, steps, `${tag}: the host must execute all 100 tools`)
        for (let step = 0; step < steps; step++) {
            assert.equal(parts[step].state.status, "completed")
            assert.ok(parts[step].state.output.includes(`EVIDENCE_${tag}_${step}_START`))
            assert.ok(parts[step].state.output.includes(`EVIDENCE_${tag}_${step}_END`))
            assert.equal(
                parts[step].state.time.compacted,
                undefined,
                "DCP must never persist its marker",
            )
        }
        const final = requestsFor(tag)
            .filter((body) => body.messages.some((m) => m.role === "tool"))
            .at(-1)
        const calls = final.messages.flatMap((message) => message.tool_calls ?? [])
        const results = final.messages.filter((message) => message.role === "tool")
        assert.equal(parts[1].state.input.filePath, evidencePath(tag, 1))
        assert.deepEqual(
            parts[1].state.metadata.loaded,
            [],
            "direct CONTEXT.md reads do not mark themselves as dynamically loaded instructions",
        )
        assert.equal(
            results.find((result) => result.tool_call_id === `call_${tag}_1`)?.content,
            parts[1].state.output,
            "the model receives the full old CONTEXT.md output even under pruning pressure",
        )
        if (tag === "A")
            assert.equal(
                results.find((result) => result.tool_call_id === `call_${tag}_0`)?.content,
                cleared,
                "an ordinary old read still prunes alongside the protected instructions",
            )
        assert.equal(calls.length, steps)
        assert.deepEqual(
            calls.map((call) => call.id),
            results.map((result) => result.tool_call_id),
        )
        assert.ok(
            final.tools.some((tool) => tool.function?.name === "dcp_prune"),
            "the built plugin is actually loaded",
        )
        assert.equal(
            JSON.stringify(final).includes(cleared),
            tag === "A",
            "concurrent budgets stay isolated",
        )
    }
    const savedTools = structuredClone(toolParts(aHistory))
    const beforeSwitch = captures.length
    await prompt(a.id, "A", "large")
    const switched = captures
        .slice(beforeSwitch)
        .find((body) => JSON.stringify(body.messages).includes("DCP_CASE_A"))
    assert.equal(switched.model, "large")
    assert.ok(
        !JSON.stringify(switched).includes(cleared),
        "the first switched request uses the large budget",
    )
    assert.deepEqual(toolParts(await api(`/session/${a.id}/message`)), savedTools)

    const beforeSwitchBack = captures.length
    await prompt(a.id, "A", "small")
    const smallAgain = captures
        .slice(beforeSwitchBack)
        .find((body) => JSON.stringify(body.messages).includes("DCP_CASE_A"))
    assert.equal(smallAgain.model, "small")
    assert.ok(
        JSON.stringify(smallAgain).includes(cleared),
        "switching back immediately restores the small budget",
    )

    const beforeCompaction = captures.length
    assert.equal(
        await api(`/session/${a.id}/summarize`, {
            providerID: "test",
            modelID: "small",
            auto: false,
        }),
        true,
    )
    const summaryRequest = captures
        .slice(beforeCompaction)
        .find((body) =>
            JSON.stringify(body.messages).includes(
                "Create a new anchored summary from the conversation history.",
            ),
        )
    assert.ok(summaryRequest, "native compaction must reach the real model HTTP endpoint")
    assert.equal(summaryRequest.model, "small")
    assert.ok(
        !JSON.stringify(summaryRequest).includes(cleared),
        "native summary sees full original outputs",
    )
    assert.ok(JSON.stringify(summaryRequest).includes("EVIDENCE_A_0_START"))
    const compactedHistory = await api(`/session/${a.id}/message`)
    assert.ok(
        compactedHistory.some((message) => message.info.summary === true),
        "the host persists its native summary",
    )
    assert.deepEqual(toolParts(compactedHistory).slice(0, steps), savedTools)
    const beforeResume = captures.length
    const resumed = await api(`/session/${a.id}/message`, {
        model: { providerID: "test", modelID: "small" },
        agent: "build",
        parts: [
            { type: "text", text: "DCP_RESUME: report completion from the native checkpoint." },
        ],
    })
    assert.ok(
        resumed.parts.some((part) => part.type === "text" && part.text === "DCP_RESUME complete."),
    )
    const resumedRequest = captures
        .slice(beforeResume)
        .find((body) => JSON.stringify(body.messages).includes("DCP_RESUME"))
    assert.ok(resumedRequest, "continuation must reach the model endpoint")
    assert.ok(
        resumedRequest.messages.some(
            (message) =>
                typeof message.content === "string" &&
                message.content.includes(
                    "## Progress\nRead all 100 files.\n## Next Steps\nReport complete.",
                ),
        ),
        "the persisted native checkpoint must enter the continuation request",
    )
    process.stdout.write(JSON.stringify({ scenario, ok: true }) + "\n")
}

const binaryReport = binarySettings
    ? {
          scenario,
          runtime: binarySettings.native ? "native" : "ai-sdk",
          dcpEnabled: binarySettings.enabled,
          ok: false,
          scratch,
          checks: [],
          observations: binaryObservations,
      }
    : undefined
async function binaryCheck(name, run) {
    try {
        const evidence = await run()
        binaryReport.checks.push({ name, status: "passed", evidence })
    } catch (error) {
        binaryReport.checks.push({ name, status: "failed", error: String(error).slice(0, 2000) })
    }
}

try {
    if (binarySettings) {
        const environment = binaryEnvironment(scratch, binarySettings.native, process.env.PATH)
        await writeFile(
            join(binarySettings.output, "isolation.json"),
            JSON.stringify(
                {
                    binary: binarySettings.path,
                    project,
                    environment,
                },
                null,
                2,
            ),
        )
        listener = await startBinaryHost({
            binary: binarySettings.path,
            project,
            port,
            environment,
            output: binarySettings.output,
        })
    } else {
        const { Server } = await import(
            pathToFileURL(join(hostRoot, "packages/opencode/src/server/server.ts")).href
        )
        listener = await Server.listen({ hostname: "127.0.0.1", port })
    }
    process.stdout.write("host: HTTP listener ready\n")
    if (binarySettings) {
        await binaryCheck("automatic-compaction-settles-slow-tool", automaticPressure)
        await binaryCheck("explicit-cancellation", explicitCancellation)
        binaryReport.ok = binaryReport.checks.every((check) => check.status === "passed")
        process.exitCode = binaryReport.ok ? 0 : 1
    } else if (automatic) {
        const metrics = await automaticPressure()
        if (native) metrics.push(await explicitCancellation())
        process.stdout.write(JSON.stringify({ scenario, ok: true, metrics }) + "\n")
    } else {
        await baselineScenario()
    }
} finally {
    await listener?.stop()
    modelServer.stop(true)
    if (binarySettings) {
        await writeFile(
            join(binarySettings.output, "captures.json"),
            JSON.stringify(captures, null, 2),
        )
        await writeFile(
            join(binarySettings.output, "result.json"),
            JSON.stringify(binaryReport, null, 2) + "\n",
        )
        process.stdout.write(JSON.stringify(binaryReport) + "\n")
    } else {
        await rm(scratch, { recursive: true, force: true })
    }
}
