import assert from "node:assert/strict"
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import test from "node:test"

const configHome = mkdtempSync(join(tmpdir(), "opencode-dcp-surface-config-"))
process.env.XDG_CONFIG_HOME = configHome
mkdirSync(join(configHome, "opencode"), { recursive: true })
writeFileSync(
    join(configHome, "opencode", "dcp.jsonc"),
    JSON.stringify({ enabled: true, autoUpdate: false }),
    "utf-8",
)

function buildCtx() {
    return {
        directory: mkdtempSync(join(tmpdir(), "opencode-dcp-surface-")),
        client: {
            session: {
                get: async () => ({ data: {} }),
                messages: async () => ({ data: [] }),
                summarize: async () => ({ data: true }),
            },
            tui: { showToast: async () => {} },
        },
    } as any
}

async function loadPlugin() {
    const { default: server } = await import("../index")
    return server(buildCtx())
}

test("plugin registers the native session compacting hook", async () => {
    const hooks = await loadPlugin()
    assert.equal(typeof hooks["experimental.session.compacting"], "function")
})

test("plugin registers the heuristic chat.message observer by default", async () => {
    const hooks = await loadPlugin()
    assert.equal(typeof hooks["chat.message"], "function")
})

test("plugin registers the event handler for idle-triggered auto prune", async () => {
    const hooks = await loadPlugin()
    assert.equal(typeof hooks.event, "function")
})

test("plugin registers the model-invokable dcp_prune tool by default", async () => {
    const hooks = await loadPlugin()
    const definition = hooks.tool?.dcp_prune as
        | { description: string; args: Record<string, unknown> }
        | undefined
    assert.ok(definition, "dcp_prune tool should be registered")
    assert.match(definition.description, /话题.*变更/)
    assert.equal(Object.keys(definition.args).length, 0)
})

test("plugin no longer registers a system prompt transform hook", async () => {
    const hooks = await loadPlugin()
    assert.equal(hooks["experimental.chat.system.transform"], undefined)
})

test("plugin no longer registers a text.complete hook", async () => {
    const hooks = await loadPlugin()
    assert.equal(hooks["experimental.text.complete"], undefined)
})

test("autoPrune and tool can be disabled independently via config", async () => {
    writeFileSync(
        join(configHome, "opencode", "dcp.jsonc"),
        JSON.stringify({
            enabled: true,
            autoUpdate: false,
            autoPrune: { enabled: false },
            tool: { enabled: false },
        }),
        "utf-8",
    )
    try {
        const hooks = await loadPlugin()
        assert.equal(hooks["chat.message"], undefined)
        assert.equal(hooks.event, undefined)
        assert.equal(hooks.tool, undefined)
        assert.equal(typeof hooks["experimental.session.compacting"], "function")
    } finally {
        writeFileSync(
            join(configHome, "opencode", "dcp.jsonc"),
            JSON.stringify({ enabled: true, autoUpdate: false }),
            "utf-8",
        )
    }
})

test("the event hook stays registered with only the tool enabled (deferred prunes)", async () => {
    writeFileSync(
        join(configHome, "opencode", "dcp.jsonc"),
        JSON.stringify({
            enabled: true,
            autoUpdate: false,
            autoPrune: { enabled: false },
        }),
        "utf-8",
    )
    try {
        const hooks = await loadPlugin()
        assert.equal(hooks["chat.message"], undefined)
        assert.equal(typeof hooks.event, "function")
        assert.ok(hooks.tool?.dcp_prune, "dcp_prune tool should stay registered")
    } finally {
        writeFileSync(
            join(configHome, "opencode", "dcp.jsonc"),
            JSON.stringify({ enabled: true, autoUpdate: false }),
            "utf-8",
        )
    }
})

test("config hook never registers compress permissions or primary tools", async () => {
    const hooks = await loadPlugin()
    assert.equal(typeof hooks.config, "function")

    const opencodeConfig: any = {}
    await hooks.config(opencodeConfig)

    assert.equal(opencodeConfig.permission?.compress, undefined)
    const primaryTools = opencodeConfig.experimental?.primary_tools ?? []
    assert.equal(primaryTools.includes("compress"), false)
})

test("config hook still registers the /dcp command when commands are enabled", async () => {
    const hooks = await loadPlugin()

    const opencodeConfig: any = {}
    await hooks.config(opencodeConfig)

    assert.ok(opencodeConfig.command?.dcp, "dcp command should stay registered")
})

test("language accepts only zh or en", async () => {
    const { getInvalidConfigKeys, validateConfigTypes } = await import("../lib/config")
    assert.deepEqual(validateConfigTypes({ language: "en" }), [])
    assert.equal(validateConfigTypes({ language: "fr" }).length, 1)
    assert.deepEqual(getInvalidConfigKeys({ language: "zh" }), [])
})

test("language config switches the bundled compaction prompt to English", async () => {
    writeFileSync(
        join(configHome, "opencode", "dcp.jsonc"),
        JSON.stringify({ enabled: true, autoUpdate: false, language: "en" }),
        "utf-8",
    )
    try {
        const hooks = await loadPlugin()
        const handler = hooks["experimental.session.compacting"] as (
            input: { sessionID: string },
            output: { context: string[]; prompt?: string },
        ) => Promise<void>
        const output = { context: [] as string[], prompt: undefined as string | undefined }
        await handler({ sessionID: "ses_lang_en" }, output)
        assert.match(output.prompt ?? "", /## History Overview/)
        assert.doesNotMatch(output.prompt ?? "", /## 历史概要/)
    } finally {
        writeFileSync(
            join(configHome, "opencode", "dcp.jsonc"),
            JSON.stringify({ enabled: true, autoUpdate: false }),
            "utf-8",
        )
    }
})

test("removed legacy /dcp subcommands fall through to help", async () => {
    const hooks = await loadPlugin()
    const handler = hooks["command.execute.before"]
    assert.equal(typeof handler, "function")

    for (const sub of ["compress", "decompress 1", "recompress 1", "manual on"]) {
        const output = { parts: [] as any[] }
        await assert.rejects(
            handler({ command: "dcp", sessionID: "ses_surface", arguments: sub }, output),
            /__DCP_HELP_HANDLED__/,
            `legacy subcommand "${sub}" must not be handled`,
        )
    }
})
