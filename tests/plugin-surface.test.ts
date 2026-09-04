import assert from "node:assert/strict"
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import test from "node:test"

const configHome = mkdtempSync(join(tmpdir(), "opencode-dcp-surface-config-"))
process.env.XDG_CONFIG_HOME = configHome
mkdirSync(join(configHome, "opencode"), { recursive: true })
const configPath = join(configHome, "opencode", "dcp.jsonc")
writeFileSync(configPath, JSON.stringify({ enabled: true, autoUpdate: false }))

async function loadPlugin(config: Record<string, unknown> = {}) {
    writeFileSync(configPath, JSON.stringify({ enabled: true, autoUpdate: false, ...config }))
    const { default: server } = await import("../index")
    // No mutable session API, config writer, or provider lookup is available at
    // initialization. Provider resolution belongs to the actual transform call.
    return server({
        directory: mkdtempSync(join(tmpdir(), "opencode-dcp-surface-")),
        client: {},
    } as any)
}

test("the default surface contains only request projection, fidelity guard, cleanup and tool", async () => {
    const hooks = await loadPlugin()
    assert.deepEqual(Object.keys(hooks).sort(), [
        "chat.params",
        "event",
        "experimental.chat.messages.transform",
        "experimental.session.compacting",
        "tool",
    ])
    assert.deepEqual(Object.keys(hooks.tool ?? {}), ["dcp_prune"])
})

test("disabling DTC removes its controls instead of exposing a tool that cannot work", async () => {
    assert.deepEqual(await loadPlugin({ dtc: { enabled: false } }), {})
    assert.deepEqual(await loadPlugin({ enabled: false }), {})
})

test("the tool can be disabled while automatic request projection remains enabled", async () => {
    const hooks = await loadPlugin({ tool: { enabled: false } })
    assert.equal(hooks.tool, undefined)
    assert.equal(typeof hooks["experimental.chat.messages.transform"], "function")
})

test("commands and all host compaction configuration are untouched", async () => {
    const hooks = await loadPlugin({ commands: { enabled: true } })
    assert.equal(hooks.config, undefined)
    assert.equal(hooks["command.execute.before"], undefined)
    assert.equal(hooks["experimental.chat.system.transform"], undefined)
    assert.equal(hooks["experimental.text.complete"], undefined)
})

test("the native summary prompt, params output and lifecycle remain unmodified", async () => {
    const hooks = await loadPlugin()
    const summary = { context: ["native"], prompt: "host-owned prompt" }
    await hooks["experimental.session.compacting"]!({ sessionID: "ses_a" }, summary)
    assert.deepEqual(summary, { context: ["native"], prompt: "host-owned prompt" })
    await hooks["experimental.chat.messages.transform"]!({}, { messages: [] })
    const params = { temperature: 0.5, topP: 0.9, topK: 50, maxOutputTokens: 8000, options: {} }
    await (hooks["chat.params"] as any)({ sessionID: "ses_a", agent: "compaction" }, params)
    assert.deepEqual(params, {
        temperature: 0.5,
        topP: 0.9,
        topK: 50,
        maxOutputTokens: 8000,
        options: {},
    })
    await (hooks.event as any)({
        event: { type: "session.deleted", properties: { info: { id: "ses_a" } } },
    })
})
