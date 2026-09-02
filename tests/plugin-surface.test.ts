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
            },
            tui: { showToast: async () => {} },
        },
    } as any
}

async function loadPlugin() {
    const { default: server } = await import("../index")
    return server(buildCtx())
}

async function withConfig(config: Record<string, unknown>, run: () => Promise<void>) {
    writeFileSync(join(configHome, "opencode", "dcp.jsonc"), JSON.stringify(config), "utf-8")
    try {
        await run()
    } finally {
        writeFileSync(
            join(configHome, "opencode", "dcp.jsonc"),
            JSON.stringify({ enabled: true, autoUpdate: false }),
            "utf-8",
        )
    }
}

test("plugin registers the DTC transform and its chat.params feed by default", async () => {
    const hooks = await loadPlugin()
    assert.equal(typeof hooks["experimental.chat.messages.transform"], "function")
    assert.equal(typeof hooks["chat.params"], "function")
})

test("plugin registers the native session compacting hook (checkpoint quality layer)", async () => {
    const hooks = await loadPlugin()
    assert.equal(typeof hooks["experimental.session.compacting"], "function")
})

test("plugin registers the lifecycle event handler and the dcp_prune tool by default", async () => {
    const hooks = await loadPlugin()
    assert.equal(typeof hooks.event, "function")
    const definition = hooks.tool?.dcp_prune as
        | { description: string; args: Record<string, unknown> }
        | undefined
    assert.ok(definition, "dcp_prune tool should be registered")
    assert.match(definition.description, /话题.*变更/)
    assert.equal(Object.keys(definition.args).length, 0)
})

test("disabling dtc removes the transform and params feed but keeps the rest", async () => {
    await withConfig({ enabled: true, autoUpdate: false, dtc: { enabled: false } }, async () => {
        const hooks = await loadPlugin()
        assert.equal(hooks["experimental.chat.messages.transform"], undefined)
        assert.equal(hooks["chat.params"], undefined)
        assert.equal(typeof hooks["experimental.session.compacting"], "function")
        assert.ok(hooks.tool?.dcp_prune)
    })
})

test("autoPrune and tool can be disabled independently via config", async () => {
    await withConfig({ enabled: true, autoUpdate: false, tool: { enabled: false } }, async () => {
        const hooks = await loadPlugin()
        assert.equal(hooks.tool, undefined)
        assert.equal(typeof hooks["experimental.chat.messages.transform"], "function")
        assert.equal(typeof hooks["experimental.session.compacting"], "function")
    })
})

test("plugin registers no system prompt or text.complete hooks", async () => {
    const hooks = await loadPlugin()
    assert.equal(hooks["experimental.chat.system.transform"], undefined)
    assert.equal(hooks["experimental.text.complete"], undefined)
})

test("config hook never registers compress permissions or primary tools", async () => {
    const hooks = await loadPlugin()
    assert.equal(typeof hooks.config, "function")

    const opencodeConfig: any = {}
    await hooks.config!(opencodeConfig)

    assert.equal(opencodeConfig.permission?.compress, undefined)
    const primaryTools = opencodeConfig.experimental?.primary_tools ?? []
    assert.equal(primaryTools.includes("compress"), false)
})

test("config hook still registers the /dcp command when commands are enabled", async () => {
    const hooks = await loadPlugin()

    const opencodeConfig: any = {}
    await hooks.config!(opencodeConfig)

    assert.ok(opencodeConfig.command?.dcp, "dcp command should stay registered")
})

test("config hook raises the host compaction tail protection to DCP defaults", async () => {
    const hooks = await loadPlugin()

    const opencodeConfig: any = {}
    await hooks.config!(opencodeConfig)

    assert.equal(opencodeConfig.compaction?.tail_turns, 4)
    assert.equal(opencodeConfig.compaction?.preserve_recent_tokens, 32000)
})

test("config hook never overrides explicit host compaction settings", async () => {
    const hooks = await loadPlugin()

    const opencodeConfig: any = {
        compaction: { tail_turns: 2, preserve_recent_tokens: 5000 },
    }
    await hooks.config!(opencodeConfig)

    assert.equal(opencodeConfig.compaction.tail_turns, 2)
    assert.equal(opencodeConfig.compaction.preserve_recent_tokens, 5000)
})

test("config hook stays registered (and skips the command) when commands are disabled", async () => {
    await withConfig(
        { enabled: true, autoUpdate: false, commands: { enabled: false } },
        async () => {
            const hooks = await loadPlugin()
            assert.equal(typeof hooks.config, "function")
            assert.equal(hooks["command.execute.before"], undefined)

            const opencodeConfig: any = {}
            await hooks.config!(opencodeConfig)

            assert.equal(opencodeConfig.command, undefined)
            assert.equal(opencodeConfig.compaction?.tail_turns, 4)
        },
    )
})

test("the plugin never exposes a summarize-based compression surface", async () => {
    // v4 invariant: DCP does not call session.summarize anywhere. The client
    // stub has no summarize method at all — if any code path reached for it,
    // plugin load or a hook call would throw.
    const hooks = await loadPlugin()
    const output = { messages: [] as unknown[] }
    await (hooks["experimental.chat.messages.transform"] as any)({}, output)
    await (hooks["chat.params"] as any)({ sessionID: "ses_x", model: { limit: { context: 8000 } } })
    await (hooks.event as any)({
        event: { type: "session.deleted", properties: { info: { id: "ses_x" } } },
    })
})

test("config defaults expose the dtc block with tiered defaults", async () => {
    const { DEFAULT_DTC } = await import("../lib/config")
    assert.equal(DEFAULT_DTC.enabled, true)
    assert.equal(DEFAULT_DTC.tailTurns, 4)
    assert.equal(DEFAULT_DTC.lowWatermarkRatio, 0.5)
    assert.equal(DEFAULT_DTC.targetRatio, 0.7)
    assert.equal(DEFAULT_DTC.driftThreshold, 0.18)
    assert.equal(DEFAULT_DTC.toolOutputKeepChars, 4000)
})
