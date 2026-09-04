import assert from "node:assert/strict"
import { mkdtemp, mkdir, writeFile, rm, symlink } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { pathToFileURL, fileURLToPath } from "node:url"
import { createServer } from "node:net"

// A separate Bun process runs the complete host HTTP server with its default
// service graph. All mutations below go through the public session API.
const hostRoot = process.env.DCP_HOST_ROOT
assert.ok(hostRoot, "run this suite with npm run test:host")
const scratch = await mkdtemp(join(tmpdir(), "dcp-public-loop-"))
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
process.env.OPENCODE_MODELS_PATH = join(
    hostRoot,
    "packages/opencode/test/tool/fixtures/models-api.json",
)
process.env.OPENCODE_DISABLE_DEFAULT_PLUGINS = "true"
process.env.OPENCODE_DISABLE_LSP_DOWNLOAD = "true"
process.env.OPENCODE_EXPERIMENTAL_EVENT_SYSTEM = "true"
process.env.OPENCODE_PRINT_LOGS = "1"
process.env.OPENCODE_LOG_LEVEL = "ERROR"

const captures = []
const cleared = "[Old tool result content cleared]"
const steps = 100
const evidence = (tag, step) =>
    `EVIDENCE_${tag}_${step}_START\n${"original tool evidence\n".repeat(240)}EVIDENCE_${tag}_${step}_END`
for (const tag of ["A", "B"]) {
    for (let step = 0; step < steps; step++)
        await writeFile(join(project, `${tag}-${step}.txt`), evidence(tag, step))
}

function sse(model, delta, finish = "stop") {
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
                usage: { prompt_tokens: 10, completion_tokens: 1, total_tokens: 11 },
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
        captures.push(body)
        const serialized = JSON.stringify(body.messages)
        if (JSON.stringify(body).includes("Generate a title for this conversation"))
            return sse(body.model, { content: "Host integration test" })
        const summary = serialized.includes(
            "Create a new anchored summary from the conversation history.",
        )
        if (summary)
            return sse(body.model, {
                content:
                    "## Goal\nPreserve DCP_CASE_A requirements.\n## Progress\nRead all 100 files.\n## Next Steps\nReport complete.",
            })
        if (serialized.includes("DCP_RESUME"))
            return sse(body.model, { content: "DCP_RESUME complete." })
        const tag = serialized.includes("DCP_CASE_A")
            ? "A"
            : serialized.includes("DCP_CASE_B")
              ? "B"
              : undefined
        if (!tag) return sse(body.model, { content: "Host integration test" })
        const calls = body.messages.flatMap((message) => message.tool_calls ?? [])
        if (calls.length < steps) {
            const step = calls.length
            if (step % 25 === 0)
                process.stdout.write(`host ${tag}: starting tool ${step + 1}/${steps}\n`)
            return sse(
                body.model,
                {
                    tool_calls: [
                        {
                            index: 0,
                            id: `call_${tag}_${step}`,
                            type: "function",
                            function: {
                                name: "read",
                                arguments: JSON.stringify({
                                    filePath: join(project, `${tag}-${step}.txt`),
                                }),
                            },
                        },
                    ],
                },
                "tool_calls",
            )
        }
        return sse(body.model, { content: `DCP_CASE_${tag} completed all ${steps} reads.` })
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
        compaction: { auto: false, prune: false, tail_turns: 0 },
        provider: {
            test: {
                name: "Local test",
                id: "test",
                env: [],
                npm: "@ai-sdk/openai-compatible",
                options: { apiKey: "local-test-only", baseURL: `${modelServer.url.origin}/v1` },
                models: { small: model("small", 32_000), large: model("large", 2_000_000) },
            },
        },
    }),
)
await mkdir(join(process.env.XDG_CONFIG_HOME, "opencode"), { recursive: true })
// Install the actual pinned host peer locally in each fresh config directory.
// This avoids unrelated registry downloads during host bootstrap without
// replacing the loader, config service or any host implementation.
for (const directory of [
    join(process.env.XDG_CONFIG_HOME, "opencode"),
    process.env.OPENCODE_CONFIG_DIR,
]) {
    const scope = join(directory, "node_modules/@opencode-ai")
    await mkdir(scope, { recursive: true })
    await symlink(join(hostRoot, "packages/plugin"), join(scope, "plugin"), "dir")
}
await writeFile(
    join(process.env.XDG_CONFIG_HOME, "opencode/dcp.jsonc"),
    JSON.stringify({
        enabled: true,
        autoUpdate: false,
    }),
)

const reservation = createServer()
await new Promise((resolve) => reservation.listen(0, "127.0.0.1", resolve))
const port = reservation.address().port
await new Promise((resolve) => reservation.close(resolve))
let listener
async function api(path, body) {
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
                text: `DCP_CASE_${tag}: Read all 100 evidence files in order and preserve the original constraints.`,
            },
        ],
    })
const toolParts = (messages) =>
    messages.flatMap((message) => message.parts).filter((part) => part.type === "tool")
const requestsFor = (tag) =>
    captures.filter((body) => JSON.stringify(body.messages).includes(`DCP_CASE_${tag}`))

try {
    const { Server } = await import(
        pathToFileURL(join(hostRoot, "packages/opencode/src/server/server.ts")).href
    )
    listener = await Server.listen({ hostname: "127.0.0.1", port })
    process.stdout.write("host: HTTP listener ready\n")
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
    process.stdout.write(JSON.stringify({ scenario: "public-host-loop", ok: true }) + "\n")
} finally {
    await listener?.stop()
    modelServer.stop(true)
    await rm(scratch, { recursive: true, force: true })
}
