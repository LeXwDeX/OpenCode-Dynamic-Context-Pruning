import assert from "node:assert/strict"
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { createRequire } from "node:module"
import { pathToFileURL, fileURLToPath } from "node:url"

// A host-runtime worker, invoked by Node's test runner. Bun does not run any
// node:test tests; it runs the actual Bun host and returns the scenario result.
const scenarios = new Map()
const scenario = (name, run) => scenarios.set(name, run)

// Import the pinned host's real database, plugin dispatcher, serializer and
// provider adapters. No host function is copied into this test suite.
const hostRoot = process.env.DCP_HOST_ROOT
assert.ok(hostRoot, "run this suite with npm run test:host")
const hostPackage = join(hostRoot, "packages/opencode")
const requireHost = createRequire(join(hostPackage, "package.json"))
const hostImport = (path) => import(pathToFileURL(join(hostPackage, path)).href)
const dependency = (name) => import(pathToFileURL(requireHost.resolve(name)).href)
const root = resolve(fileURLToPath(new URL("../..", import.meta.url)))
const scratch = await mkdtemp(join(tmpdir(), "dcp-host-contract-"))
for (const key of [
    "XDG_DATA_HOME",
    "XDG_CACHE_HOME",
    "XDG_CONFIG_HOME",
    "XDG_STATE_HOME",
    "OPENCODE_TEST_HOME",
    "OPENCODE_TEST_MANAGED_CONFIG_DIR",
]) {
    process.env[key] = join(scratch, key)
}
process.env.OPENCODE_DB = ":memory:"
process.env.OPENCODE_CONFIG_DIR = join(scratch, "opencode-config")
process.env.OPENCODE_DISABLE_MODELS_FETCH = "true"
process.env.OPENCODE_MODELS_PATH = join(hostPackage, "test/tool/fixtures/models-api.json")
for (const key of [
    "OPENCODE_CONFIG",
    "OPENCODE_CONFIG_CONTENT",
    "OPENCODE_SERVER_PASSWORD",
    "OPENCODE_SERVER_USERNAME",
]) {
    delete process.env[key]
}
await mkdir(join(process.env.XDG_CONFIG_HOME, "opencode"), { recursive: true })
await writeFile(
    join(process.env.XDG_CONFIG_HOME, "opencode/dcp.jsonc"),
    JSON.stringify({ enabled: true, autoUpdate: false }),
)

const [
    { MessageV2 },
    { ProviderTransform },
    { Plugin },
    { Config },
    { RuntimeFlags },
    { EventV2Bridge },
    { InstanceRef },
    { Database },
    { ProjectTable },
    { SessionTable, MessageTable, PartTable },
    { Effect, Layer },
    { createAnthropic },
    { generateText },
    { SessionCompaction },
    { Session },
    { Agent },
    { Provider },
    { SessionProcessor },
    { buildPrompt },
] = await Promise.all([
    hostImport("src/session/message-v2.ts"),
    hostImport("src/provider/transform.ts"),
    hostImport("src/plugin/index.ts"),
    hostImport("src/config/config.ts"),
    hostImport("src/effect/runtime-flags.ts"),
    hostImport("src/event-v2-bridge.ts"),
    hostImport("src/effect/instance-ref.ts"),
    dependency("@opencode-ai/core/database/database"),
    dependency("@opencode-ai/core/project/sql"),
    dependency("@opencode-ai/core/session/sql"),
    dependency("effect"),
    dependency("@ai-sdk/anthropic"),
    dependency("ai"),
    hostImport("src/session/compaction.ts"),
    hostImport("src/session/session.ts"),
    hostImport("src/agent/agent.ts"),
    hostImport("src/provider/provider.ts"),
    hostImport("src/session/processor.ts"),
    dependency("@opencode-ai/core/session/compaction"),
])

const smallModel = {
    id: "claude-sonnet-4-5",
    providerID: "anthropic",
    api: { id: "claude-sonnet-4-5", npm: "@ai-sdk/anthropic" },
    capabilities: { interleaved: false },
    limit: { context: 32_000, output: 4_000 },
}
const largeModel = {
    ...smallModel,
    id: "claude-large-test",
    api: { ...smallModel.api, id: "claude-large-test" },
    limit: { context: 2_000_000, output: 4_000 },
}
const registry = {
    data: {
        providers: [
            {
                id: "anthropic",
                models: { [smallModel.id]: smallModel, [largeModel.id]: largeModel },
            },
        ],
    },
}

function autonomousTask(model = smallModel, count = 100) {
    const sessionID = "ses_host_test"
    const userID = "msg_user"
    const messages = [
        {
            info: {
                id: userID,
                sessionID,
                role: "user",
                time: { created: 1 },
                agent: "build",
                model: { providerID: model.providerID, modelID: model.id },
            },
            parts: [
                {
                    id: "prt_user",
                    sessionID,
                    messageID: userID,
                    type: "text",
                    text: "Complete all steps. Keep the original constraints and report failures.",
                },
            ],
        },
    ]
    for (let i = 0; i < count; i++) {
        const id = `msg_step_${String(i).padStart(3, "0")}`
        const error = i === 10
        const tool = {
            id: `prt_tool_${i}`,
            sessionID,
            messageID: id,
            type: "tool",
            tool: "read",
            callID: `call_${i}`,
            state: {
                status: error ? "error" : "completed",
                input: { filePath: `/src/module-${i}.ts` },
                ...(error
                    ? { error: "Permission denied: preserve this exact failure evidence" }
                    : { output: `RESULT-${i}: ${"unique evidence ".repeat(600)}` }),
                title: "Read module",
                metadata: {},
                time: { start: i * 10 + 2, end: i * 10 + 3 },
            },
        }
        messages.push({
            info: {
                id,
                sessionID,
                role: "assistant",
                time: { created: i + 2 },
                parentID: userID,
                modelID: model.id,
                providerID: model.providerID,
                agent: "build",
                mode: "build",
                path: { cwd: scratch, root: scratch },
                tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
                cost: 0,
            },
            parts: [
                ...(i === 0
                    ? [
                          {
                              id: "prt_reasoning",
                              sessionID,
                              messageID: id,
                              type: "reasoning",
                              text: "Signed reasoning must survive byte for byte.",
                              metadata: { anthropic: { signature: "test-signature" } },
                          },
                      ]
                    : []),
                tool,
            ],
        })
    }
    return messages
}

async function withDatabase(messages, run) {
    const fx = Effect.gen(function* () {
        const { db } = yield* Database.Service
        yield* db
            .insert(ProjectTable)
            .values({ id: "global", worktree: scratch, sandboxes: [] })
            .run()
        yield* db
            .insert(SessionTable)
            .values({
                id: messages[0].info.sessionID,
                project_id: "global",
                slug: "test",
                directory: scratch,
                title: "Host contract",
                version: "1",
            })
            .run()
        for (const message of messages) {
            const { id, sessionID, ...data } = message.info
            yield* db
                .insert(MessageTable)
                .values({ id, session_id: sessionID, time_created: data.time.created, data })
                .run()
            for (const p of message.parts) {
                const { id: partID, sessionID: _, messageID: __, ...data } = p
                yield* db
                    .insert(PartTable)
                    .values({ id: partID, message_id: id, session_id: sessionID, data })
                    .run()
            }
        }
        const snapshot = Effect.gen(function* () {
            return JSON.stringify([
                yield* db.select().from(MessageTable).all(),
                yield* db.select().from(PartTable).all(),
            ])
        })
        const before = yield* snapshot
        const loaded = yield* MessageV2.page({
            sessionID: messages[0].info.sessionID,
            limit: 500,
        })
        assert.equal(loaded.items[0].info.id, messages[0].info.id)
        assert.equal(loaded.items[0].info.sessionID, messages[0].info.sessionID)
        assert.equal(loaded.items[1].parts.at(-1).callID, "call_0")
        yield* Effect.promise(() => run(loaded.items))
        assert.equal(yield* snapshot, before, "request transforms must not alter stored history")
    })
    await Effect.runPromise(fx.pipe(Effect.provide(Database.layerFromPath(":memory:"))))
}

async function withPlugin(run, providers = registry) {
    const directory = await mkdtemp(join(scratch, "project-"))
    const errors = []
    // This component fixture supplies config and a read-only catalog through
    // an adapter. The loader, dispatcher and plugin entry are real host code;
    // public-loop.mjs separately covers the complete default host service graph.
    const wrapper = join(directory, "plugin.mjs")
    await writeFile(
        wrapper,
        `import plugin from ${JSON.stringify(pathToFileURL(join(root, "dist/index.js")).href)}
export default (ctx) => plugin({ ...ctx, client: {
    config: { providers: async () => (${JSON.stringify(providers)}) },
    tui: { showToast: async () => {} },
} })
`,
    )
    const config = {
        plugin_origins: [
            {
                spec: pathToFileURL(wrapper).href,
                source: join(directory, "opencode.json"),
                scope: "local",
            },
        ],
    }
    const pluginLayer = Plugin.layer.pipe(
        Layer.provide(RuntimeFlags.layer({ disableDefaultPlugins: true })),
        Layer.provide(
            Layer.succeed(Config.Service, {
                get: () => Effect.succeed(config),
                directories: () => Effect.succeed([directory]),
                waitForDependencies: () => Effect.void,
            }),
        ),
        Layer.provide(
            Layer.succeed(EventV2Bridge.Service, {
                publish: (_event, value) => Effect.sync(() => errors.push(value)),
                listen: () => Effect.succeed(Effect.void),
            }),
        ),
    )
    await Effect.runPromise(
        Effect.gen(function* () {
            const host = yield* Plugin.Service
            const hooks = yield* host.list()
            assert.equal(
                hooks.length,
                1,
                `the real host loader must load the DCP entry: ${JSON.stringify(errors)}`,
            )
            yield* run(host, hooks[0])
        }).pipe(
            Effect.provide(pluginLayer),
            Effect.provideService(InstanceRef, {
                directory,
                worktree: directory,
                project: {
                    id: "global",
                    worktree: directory,
                    time: { created: 0, updated: 0 },
                    sandboxes: [],
                },
            }),
        ),
    )
}

async function wire(messages, model = smallModel) {
    const converted = ProviderTransform.message(
        await MessageV2.toModelMessages(messages, model),
        model,
        {},
    )
    let request
    const provider = createAnthropic({
        apiKey: "local-test-only",
        fetch: async (_url, options) => {
            request = JSON.parse(options.body)
            return new Response(
                JSON.stringify({
                    id: "msg_reply",
                    type: "message",
                    role: "assistant",
                    model: model.id,
                    content: [{ type: "text", text: "ok" }],
                    stop_reason: "end_turn",
                    stop_sequence: null,
                    usage: { input_tokens: 10, output_tokens: 1 },
                }),
                { headers: { "Content-Type": "application/json" } },
            )
        },
    })
    await generateText({ model: provider(model.id), messages: converted })
    assert.ok(request)
    return request.messages.flatMap((message) => message.content)
}

scenario("compaction-guard", async () => {
    await withPlugin((host) =>
        Effect.gen(function* () {
            const output = { context: ["host context"], prompt: "host prompt" }
            yield* host.trigger(
                "experimental.session.compacting",
                { sessionID: "ses_host_test" },
                output,
            )
            assert.deepEqual(output, { context: ["host context"], prompt: "host prompt" })
        }),
    )
})

scenario("autonomous-task-wire", async () => {
    await withDatabase(autonomousTask(), async (messages) => {
        const before = structuredClone(messages)
        await withPlugin((host) =>
            Effect.gen(function* () {
                yield* host.trigger("experimental.chat.messages.transform", {}, { messages })
            }),
        )
        const blocks = await wire(messages)
        assert.ok(
            blocks.some(
                (block) =>
                    block.type === "tool_result" &&
                    block.content === "[Old tool result content cleared]",
            ),
        )
        const calls = blocks.filter((block) => block.type === "tool_use")
        const results = blocks.filter((block) => block.type === "tool_result")
        assert.equal(calls.length, 100)
        assert.deepEqual(
            calls.map((block) => block.id),
            results.map((block) => block.tool_use_id),
        )
        assert.deepEqual(messages[0], before[0], "user requirements remain verbatim")
        assert.deepEqual(
            messages[1].parts[0],
            before[1].parts[0],
            "signed reasoning remains verbatim",
        )
        assert.ok(
            blocks.some(
                (block) => block.type === "thinking" && block.signature === "test-signature",
            ),
        )
        assert.ok(
            results.some((block) => block.is_error && block.content.includes("Permission denied")),
        )
        assert.deepEqual(messages.at(-1), before.at(-1), "the latest tool result remains verbatim")
        for (let i = 1; i < messages.length; i++) {
            assert.deepEqual(
                messages[i].parts.at(-1).state.input,
                before[i].parts.at(-1).state.input,
            )
        }
    })
})

scenario("model-switch", async () => {
    await withDatabase(autonomousTask(largeModel), async (messages) => {
        const before = structuredClone(messages)
        await withPlugin((host) =>
            Effect.gen(function* () {
                yield* host.trigger("experimental.chat.messages.transform", {}, { messages })
                assert.deepEqual(messages, before, "the large model needs no projection")
                messages[0].info.model = {
                    providerID: smallModel.providerID,
                    modelID: smallModel.id,
                }
                yield* host.trigger("experimental.chat.messages.transform", {}, { messages })
                assert.ok(messages.some((m) => m.parts.some((p) => p.state?.time.compacted)))
                const largeAgain = structuredClone(before)
                yield* host.trigger(
                    "experimental.chat.messages.transform",
                    {},
                    { messages: largeAgain },
                )
                assert.deepEqual(
                    largeAgain,
                    before,
                    "a small-model request must not poison the next budget",
                )
            }),
        )
    })
})

scenario("redundant-read-wire", async () => {
    const { estimateMessages } = await import(pathToFileURL(join(root, "lib/dtc/engine.ts")).href)
    await writeFile(
        join(process.env.XDG_CONFIG_HOME, "opencode/dcp.jsonc"),
        JSON.stringify({
            enabled: true,
            autoUpdate: false,
            dtc: { protectRecentSteps: 1, protectRecentTokens: 0, targetRatio: 1 },
        }),
    )
    const source = autonomousTask(smallModel, 5)
    for (const index of [2, 3, 4]) {
        const state = source[index].parts.at(-1).state
        state.input = { filePath: "/src/repeated.ts", offset: 1, limit: 100 }
        state.output = "REPEATED-EVIDENCE: " + "same complete content ".repeat(500)
    }
    const budget = estimateMessages(source) - 2000
    const model = { ...smallModel, limit: { context: budget + 4000, output: 4000 } }
    const providers = {
        data: { providers: [{ id: "anthropic", models: { [model.id]: model } }] },
    }
    await withDatabase(source, async (messages) => {
        const before = structuredClone(messages)
        await withPlugin(
            (host) =>
                Effect.gen(function* () {
                    yield* host.trigger("experimental.chat.messages.transform", {}, { messages })
                }),
            providers,
        )
        const blocks = await wire(messages, model)
        const calls = blocks.filter((block) => block.type === "tool_use")
        const results = blocks.filter((block) => block.type === "tool_result")
        assert.deepEqual(
            calls.map((block) => block.id),
            results.map((block) => block.tool_use_id),
        )
        assert.equal(calls.length, 5)
        assert.deepEqual(
            results.map((block) => block.content === "[Old tool result content cleared]"),
            [false, true, false, false, false],
        )
        assert.equal(results[0].content, before[1].parts.at(-1).state.output)
        assert.equal(results[3].content, before[4].parts.at(-1).state.output)
        assert.deepEqual(
            calls.map((block) => block.input),
            before.slice(1).map((m) => m.parts.at(-1).state.input),
        )
        for (const message of messages) {
            for (const part of message.parts) {
                if (part.type === "tool") delete part.state.time.compacted
            }
        }
        assert.deepEqual(messages, before)
    })
})

scenario("native-compaction-order", async () => {
    await withDatabase(autonomousTask(), async (messages) => {
        const before = structuredClone(messages)
        await withPlugin((host, hooks) =>
            Effect.gen(function* () {
                const order = []
                let compactionProjection
                for (const name of [
                    "experimental.session.compacting",
                    "experimental.chat.messages.transform",
                ]) {
                    const hook = hooks[name]
                    hooks[name] = async (input, output) => {
                        order.push(name)
                        await hook(input, output)
                        if (name === "experimental.chat.messages.transform") {
                            compactionProjection = structuredClone(output.messages)
                        }
                    }
                }
                let processorInput
                let summaryMessage
                // These are the host's persistence/model-I/O boundaries. The
                // compaction algorithm and its plugin calls are the real host.
                const compactionLayer = SessionCompaction.layer.pipe(
                    Layer.provide(Layer.succeed(Plugin.Service, host)),
                    Layer.provide(RuntimeFlags.layer()),
                    Layer.provide(
                        Layer.succeed(Config.Service, {
                            get: () => Effect.succeed({ compaction: { tail_turns: 0 } }),
                        }),
                    ),
                    Layer.provide(
                        Layer.succeed(Session.Service, {
                            updateMessage: (message) =>
                                Effect.sync(() => {
                                    summaryMessage = message
                                    return message
                                }),
                            messages: () =>
                                Effect.succeed([
                                    ...messages,
                                    {
                                        info: summaryMessage,
                                        parts: [{ type: "text", text: "Native checkpoint" }],
                                    },
                                ]),
                        }),
                    ),
                    Layer.provide(
                        Layer.succeed(Agent.Service, {
                            get: () => Effect.succeed({ name: "compaction" }),
                        }),
                    ),
                    Layer.provide(
                        Layer.succeed(Provider.Service, {
                            getModel: () => Effect.succeed(smallModel),
                        }),
                    ),
                    Layer.provide(
                        Layer.succeed(SessionProcessor.Service, {
                            create: ({ assistantMessage }) =>
                                Effect.succeed({
                                    message: assistantMessage,
                                    process: (input) =>
                                        Effect.sync(() => {
                                            processorInput = input
                                            return "continue"
                                        }),
                                }),
                        }),
                    ),
                    Layer.provide(
                        Layer.succeed(EventV2Bridge.Service, {
                            publish: () => Effect.void,
                        }),
                    ),
                )
                yield* SessionCompaction.Service.use((compaction) =>
                    compaction.process({
                        sessionID: messages[0].info.sessionID,
                        parentID: messages[0].info.id,
                        messages,
                        auto: false,
                    }),
                ).pipe(Effect.provide(compactionLayer))
                assert.deepEqual(order, [
                    "experimental.session.compacting",
                    "experimental.chat.messages.transform",
                ])
                assert.deepEqual(
                    compactionProjection,
                    before,
                    "the summarizer gets the original request content",
                )
                assert.equal(
                    processorInput.messages.at(-1).content[0].text,
                    buildPrompt({ context: [] }),
                )
                assert.ok(
                    !JSON.stringify(processorInput.messages).includes(
                        "[Old tool result content cleared]",
                    ),
                )
                yield* host.trigger("experimental.chat.messages.transform", {}, { messages })
                assert.ok(
                    messages.some((m) => m.parts.some((p) => p.state?.time.compacted)),
                    "normal requests resume projection after compaction",
                )
            }),
        )
    })
})

scenario("post-compaction-prefix", async () => {
    const input = autonomousTask()
    const sourceUser = input[0]
    const compaction = {
        info: { ...sourceUser.info, id: "msg_compaction", time: { created: 1_000 } },
        parts: [
            {
                id: "prt_compaction",
                messageID: "msg_compaction",
                sessionID: sourceUser.info.sessionID,
                type: "compaction",
                auto: false,
                tail_start_id: sourceUser.info.id,
            },
        ],
    }
    const summary = {
        info: {
            ...input[1].info,
            id: "msg_summary",
            parentID: compaction.info.id,
            summary: true,
            finish: "stop",
            time: { created: 1_001 },
        },
        parts: [
            {
                id: "prt_summary",
                sessionID: sourceUser.info.sessionID,
                messageID: "msg_summary",
                type: "text",
                text: "Native checkpoint: preserve the current requirements and unresolved work.",
            },
        ],
    }
    input.push(compaction, summary)
    await withDatabase(input, async (stored) => {
        const messages = MessageV2.filterCompacted([...stored].reverse())
        assert.deepEqual(
            messages.slice(0, 2).map((m) => m.info.id),
            ["msg_compaction", "msg_summary"],
        )
        const prefix = structuredClone(messages.slice(0, 2))
        await withPlugin((host) =>
            Effect.gen(function* () {
                yield* host.trigger("experimental.chat.messages.transform", {}, { messages })
            }),
        )
        assert.deepEqual(messages.slice(0, 2), prefix)
        const blocks = await wire(messages)
        assert.ok(
            blocks.some(
                (block) =>
                    block.type === "tool_result" &&
                    block.content === "[Old tool result content cleared]",
            ),
        )
        assert.ok(
            blocks.some((block) => block.type === "text" && block.text === summary.parts[0].text),
        )
    })
})

try {
    const selected = process.argv[2]
    assert.ok(scenarios.has(selected), `Unknown host scenario: ${selected}`)
    await scenarios.get(selected)()
    process.stdout.write(JSON.stringify({ scenario: selected, ok: true }) + "\n")
} finally {
    await rm(scratch, { recursive: true, force: true })
}
