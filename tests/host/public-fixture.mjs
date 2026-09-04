import assert from "node:assert/strict"
import { mkdtemp, mkdir, writeFile, rm, symlink } from "node:fs/promises"
import { createServer } from "node:net"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"

export const cleared = "[Old tool result content cleared]"
export const toolParts = (messages) =>
    messages.flatMap((message) => message.parts).filter((part) => part.type === "tool")
export const isSummary = (body) =>
    [
        "Create a new anchored summary from the conversation history.",
        "Update the anchored summary below using the conversation history above.",
    ].some((text) => JSON.stringify(body.messages).includes(text))

export function sse(model, delta, finish = "stop", usage = 10) {
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
        { headers: { "Content-Type": "text/event-stream" } },
    )
}

let started = false

// Host environment and module-level services are process-wide. The Node runner
// gives each scenario its own Bun process; sessions within a scenario share it.
export async function startPublicHost({
    name,
    context = 64_000,
    output = 4_000,
    native = false,
    compaction,
    onCompletion,
}) {
    assert.equal(started, false, "start one isolated host per process")
    started = true
    const hostRoot = process.env.DCP_HOST_ROOT
    assert.ok(hostRoot, "run this suite with npm run test:host")
    const scratch = await mkdtemp(join(tmpdir(), `dcp-${name}-`))
    const project = join(scratch, "project")
    let listener
    let modelServer
    const close = async () => {
        try {
            await listener?.stop()
        } finally {
            modelServer?.stop(true)
            await rm(scratch, { recursive: true, force: true })
        }
    }
    try {
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
        process.env.OPENCODE_EXPERIMENTAL_NATIVE_LLM = String(native)
        process.env.OPENCODE_PRINT_LOGS = "1"
        process.env.OPENCODE_LOG_LEVEL = "ERROR"

        const captures = []
        modelServer = Bun.serve({
            hostname: "127.0.0.1",
            port: 0,
            async fetch(request) {
                assert.equal(new URL(request.url).pathname, "/v1/chat/completions")
                const body = await request.json()
                captures.push(body)
                return onCompletion(body)
            },
        })
        const model = (id, limit) => ({
            id,
            name: id,
            attachment: false,
            reasoning: false,
            temperature: false,
            tool_call: true,
            release_date: "2025-01-01",
            limit: { context: limit, output },
            cost: { input: 0, output: 0 },
            options: {},
        })
        await writeFile(
            join(project, "opencode.json"),
            JSON.stringify({
                $schema: "https://opencode.ai/config.json",
                plugin: [
                    pathToFileURL(fileURLToPath(new URL("../../dist/index.js", import.meta.url)))
                        .href,
                ],
                model: "test/small",
                small_model: "test/large",
                permission: "allow",
                lsp: false,
                ...(compaction === undefined ? {} : { compaction }),
                provider: {
                    test: {
                        name: "Local test",
                        id: "test",
                        env: [],
                        npm: "@ai-sdk/openai-compatible",
                        options: {
                            apiKey: "local-test-only",
                            baseURL: `${modelServer.url.origin}/v1`,
                        },
                        models: {
                            small: model("small", context),
                            large: model("large", 2_000_000),
                        },
                    },
                },
            }),
        )
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
            JSON.stringify({ enabled: true, autoUpdate: false }),
        )
        const reservation = createServer()
        await new Promise((resolve) => reservation.listen(0, "127.0.0.1", resolve))
        const port = reservation.address().port
        await new Promise((resolve) => reservation.close(resolve))
        const { Server } = await import(
            pathToFileURL(join(hostRoot, "packages/opencode/src/server/server.ts")).href
        )
        listener = await Server.listen({ hostname: "127.0.0.1", port })
        const api = async (path, body) => {
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
        return { project, api, captures, close }
    } catch (error) {
        await close()
        throw error
    }
}
