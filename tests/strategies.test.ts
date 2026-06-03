import assert from "node:assert/strict"
import test from "node:test"
import { deduplicate } from "../lib/strategies/deduplication"
import { purgeErrors } from "../lib/strategies/purge-errors"
import { createSessionState } from "../lib/state"
import { Logger } from "../lib/logger"
import type { PluginConfig } from "../lib/config"
import type { WithParts } from "../lib/state"

function buildConfig(overrides: Partial<PluginConfig["strategies"]> = {}): PluginConfig {
    return {
        enabled: true,
        debug: false,
        autoUpdate: false,
        protectedFilePatterns: [],
        strategies: {
            deduplication: {
                enabled: true,
                protectedTools: [],
                ...(overrides.deduplication || {}),
            },
            purgeErrors: {
                enabled: true,
                turns: 2,
                protectedTools: [],
                ...(overrides.purgeErrors || {}),
            },
        },
        compress: {
            mode: "range",
            permission: "auto",
            protectedTools: [],
        },
        manualMode: {
            enabled: false,
            automaticStrategies: false,
        },
        commands: { enabled: true },
        experimental: {
            allowSubAgents: false,
            customPrompts: false,
        },
    } as any
}

function buildMessages(): WithParts[] {
    return []
}

test("deduplicate does nothing when disabled", () => {
    const state = createSessionState()
    const logger = new Logger(false)
    const config = buildConfig({ deduplication: { enabled: false, protectedTools: [] } })

    state.toolIdList = ["call1"]
    state.toolParameters.set("call1", {
        tool: "bash",
        parameters: { command: "ls" },
        turn: 1,
        status: "success",
    } as any)

    deduplicate(state, logger, config, buildMessages())
    assert.equal(state.prune.tools.size, 0)
})

test("deduplicate does nothing when toolIdList is empty", () => {
    const state = createSessionState()
    const logger = new Logger(false)
    const config = buildConfig()

    state.toolIdList = []
    deduplicate(state, logger, config, buildMessages())
    assert.equal(state.prune.tools.size, 0)
})

test("deduplicate does nothing when all tools already pruned", () => {
    const state = createSessionState()
    const logger = new Logger(false)
    const config = buildConfig()

    state.toolIdList = ["call1"]
    state.prune.tools.set("call1", 100)
    deduplicate(state, logger, config, buildMessages())
    assert.equal(state.prune.tools.size, 1)
})

test("deduplicate prunes duplicate tool calls keeping the most recent", () => {
    const state = createSessionState()
    const logger = new Logger(false)
    const config = buildConfig()

    state.toolIdList = ["call1", "call2", "call3"]
    state.toolParameters.set("call1", {
        tool: "read",
        parameters: { filePath: "src/index.ts" },
        turn: 1,
        status: "success",
        tokenCount: 50,
    } as any)
    state.toolParameters.set("call2", {
        tool: "read",
        parameters: { filePath: "src/index.ts" },
        turn: 2,
        status: "success",
        tokenCount: 50,
    } as any)
    state.toolParameters.set("call3", {
        tool: "bash",
        parameters: { command: "ls" },
        turn: 3,
        status: "success",
        tokenCount: 30,
    } as any)

    deduplicate(state, logger, config, buildMessages())

    // call1 should be pruned (older duplicate of call2)
    assert.ok(state.prune.tools.has("call1"))
    // call2 should be kept (most recent duplicate)
    assert.ok(!state.prune.tools.has("call2"))
    // call3 is unique, should be kept
    assert.ok(!state.prune.tools.has("call3"))
})

test("deduplicate skips protected tools", () => {
    const state = createSessionState()
    const logger = new Logger(false)
    const config = buildConfig({ deduplication: { enabled: true, protectedTools: ["bash"] } })

    state.toolIdList = ["call1", "call2"]
    state.toolParameters.set("call1", {
        tool: "bash",
        parameters: { command: "ls" },
        turn: 1,
        status: "success",
        tokenCount: 30,
    } as any)
    state.toolParameters.set("call2", {
        tool: "bash",
        parameters: { command: "ls" },
        turn: 2,
        status: "success",
        tokenCount: 30,
    } as any)

    deduplicate(state, logger, config, buildMessages())
    assert.equal(state.prune.tools.size, 0)
})

test("deduplicate skips tools with protected file paths", () => {
    const state = createSessionState()
    const logger = new Logger(false)
    const config = buildConfig()
    config.protectedFilePatterns = ["*.env"]

    state.toolIdList = ["call1", "call2"]
    state.toolParameters.set("call1", {
        tool: "read",
        parameters: { filePath: "config.env" },
        turn: 1,
        status: "success",
        tokenCount: 30,
    } as any)
    state.toolParameters.set("call2", {
        tool: "read",
        parameters: { filePath: "config.env" },
        turn: 2,
        status: "success",
        tokenCount: 30,
    } as any)

    deduplicate(state, logger, config, buildMessages())
    assert.equal(state.prune.tools.size, 0)
})

test("deduplicate skips when in manual mode with automaticStrategies disabled", () => {
    const state = createSessionState()
    const logger = new Logger(false)
    const config = buildConfig()
    config.manualMode.automaticStrategies = false

    state.manualMode = "active"
    state.toolIdList = ["call1", "call2"]
    state.toolParameters.set("call1", {
        tool: "read",
        parameters: { filePath: "src/a.ts" },
        turn: 1,
        status: "success",
        tokenCount: 30,
    } as any)
    state.toolParameters.set("call2", {
        tool: "read",
        parameters: { filePath: "src/a.ts" },
        turn: 2,
        status: "success",
        tokenCount: 30,
    } as any)

    deduplicate(state, logger, config, buildMessages())
    assert.equal(state.prune.tools.size, 0)
})

test("deduplicate handles tools without metadata", () => {
    const state = createSessionState()
    const logger = new Logger(false)
    const config = buildConfig()

    state.toolIdList = ["call1", "call2"]
    // call1 has no metadata
    state.toolParameters.set("call2", {
        tool: "read",
        parameters: { filePath: "src/a.ts" },
        turn: 2,
        status: "success",
        tokenCount: 30,
    } as any)

    deduplicate(state, logger, config, buildMessages())
    assert.equal(state.prune.tools.size, 0)
})

test("deduplicate normalizes parameters for comparison (ignores null/undefined)", () => {
    const state = createSessionState()
    const logger = new Logger(false)
    const config = buildConfig()

    state.toolIdList = ["call1", "call2"]
    state.toolParameters.set("call1", {
        tool: "read",
        parameters: { filePath: "src/a.ts", extra: null },
        turn: 1,
        status: "success",
        tokenCount: 30,
    } as any)
    state.toolParameters.set("call2", {
        tool: "read",
        parameters: { filePath: "src/a.ts", extra: undefined },
        turn: 2,
        status: "success",
        tokenCount: 30,
    } as any)

    deduplicate(state, logger, config, buildMessages())
    // Both should normalize to same signature -> call1 pruned
    assert.ok(state.prune.tools.has("call1"))
})

// purgeErrors tests

test("purgeErrors does nothing when disabled", () => {
    const state = createSessionState()
    const logger = new Logger(false)
    const config = buildConfig({ purgeErrors: { enabled: false, turns: 2, protectedTools: [] } })

    state.toolIdList = ["call1"]
    state.currentTurn = 5
    state.toolParameters.set("call1", {
        tool: "bash",
        parameters: { command: "ls" },
        turn: 1,
        status: "error",
        tokenCount: 100,
    } as any)

    purgeErrors(state, logger, config, buildMessages())
    assert.equal(state.prune.tools.size, 0)
})

test("purgeErrors does nothing when toolIdList is empty", () => {
    const state = createSessionState()
    const logger = new Logger(false)
    const config = buildConfig()

    state.toolIdList = []
    state.currentTurn = 5
    purgeErrors(state, logger, config, buildMessages())
    assert.equal(state.prune.tools.size, 0)
})

test("purgeErrors does nothing when all tools already pruned", () => {
    const state = createSessionState()
    const logger = new Logger(false)
    const config = buildConfig()

    state.toolIdList = ["call1"]
    state.currentTurn = 5
    state.prune.tools.set("call1", 100)
    purgeErrors(state, logger, config, buildMessages())
    assert.equal(state.prune.tools.size, 1)
})

test("purgeErrors prunes errored tools older than threshold", () => {
    const state = createSessionState()
    const logger = new Logger(false)
    const config = buildConfig({ purgeErrors: { enabled: true, turns: 2, protectedTools: [] } })

    state.toolIdList = ["call1", "call2"]
    state.currentTurn = 5
    state.toolParameters.set("call1", {
        tool: "bash",
        parameters: { command: "bad_command" },
        turn: 2,
        status: "error",
        tokenCount: 100,
    } as any)
    state.toolParameters.set("call2", {
        tool: "bash",
        parameters: { command: "other" },
        turn: 4,
        status: "error",
        tokenCount: 50,
    } as any)

    purgeErrors(state, logger, config, buildMessages())

    // call1: turnAge = 5-2 = 3 >= 2, should be pruned
    assert.ok(state.prune.tools.has("call1"))
    // call2: turnAge = 5-4 = 1 < 2, should not be pruned
    assert.ok(!state.prune.tools.has("call2"))
})

test("purgeErrors skips non-error tools", () => {
    const state = createSessionState()
    const logger = new Logger(false)
    const config = buildConfig({ purgeErrors: { enabled: true, turns: 1, protectedTools: [] } })

    state.toolIdList = ["call1"]
    state.currentTurn = 10
    state.toolParameters.set("call1", {
        tool: "bash",
        parameters: { command: "ls" },
        turn: 1,
        status: "success",
        tokenCount: 100,
    } as any)

    purgeErrors(state, logger, config, buildMessages())
    assert.equal(state.prune.tools.size, 0)
})

test("purgeErrors skips protected tools", () => {
    const state = createSessionState()
    const logger = new Logger(false)
    const config = buildConfig({ purgeErrors: { enabled: true, turns: 1, protectedTools: ["bash"] } })

    state.toolIdList = ["call1"]
    state.currentTurn = 10
    state.toolParameters.set("call1", {
        tool: "bash",
        parameters: { command: "fail" },
        turn: 1,
        status: "error",
        tokenCount: 100,
    } as any)

    purgeErrors(state, logger, config, buildMessages())
    assert.equal(state.prune.tools.size, 0)
})

test("purgeErrors skips tools with protected file paths", () => {
    const state = createSessionState()
    const logger = new Logger(false)
    const config = buildConfig({ purgeErrors: { enabled: true, turns: 1, protectedTools: [] } })
    config.protectedFilePatterns = ["*.env"]

    state.toolIdList = ["call1"]
    state.currentTurn = 10
    state.toolParameters.set("call1", {
        tool: "read",
        parameters: { filePath: "secrets.env" },
        turn: 1,
        status: "error",
        tokenCount: 100,
    } as any)

    purgeErrors(state, logger, config, buildMessages())
    assert.equal(state.prune.tools.size, 0)
})

test("purgeErrors skips when in manual mode with automaticStrategies disabled", () => {
    const state = createSessionState()
    const logger = new Logger(false)
    const config = buildConfig()
    config.manualMode.automaticStrategies = false

    state.manualMode = "active"
    state.toolIdList = ["call1"]
    state.currentTurn = 10
    state.toolParameters.set("call1", {
        tool: "bash",
        parameters: { command: "fail" },
        turn: 1,
        status: "error",
        tokenCount: 100,
    } as any)

    purgeErrors(state, logger, config, buildMessages())
    assert.equal(state.prune.tools.size, 0)
})
