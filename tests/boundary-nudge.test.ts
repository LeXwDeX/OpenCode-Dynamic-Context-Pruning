import assert from "node:assert/strict"
import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import test from "node:test"
import type { PluginConfig } from "../lib/config"
import { resetOnCompaction } from "../lib/state/utils"
import { getInvalidConfigKeys, validateConfigTypes } from "../lib/config"
import { createEventHandler } from "../lib/hooks"
import { Logger } from "../lib/logger"
import { assignMessageRefs } from "../lib/message-ids"
import { injectCompressNudges } from "../lib/messages/inject/inject"
import {
    createSessionState,
    saveSessionState,
    loadSessionState,
    SessionStateStore,
    type WithParts,
} from "../lib/state"

process.env.XDG_DATA_HOME = mkdtempSync(join(tmpdir(), "opencode-dcp-boundary-"))

function buildConfig(overrides: Partial<PluginConfig["compress"]> = {}): PluginConfig {
    return {
        enabled: true,
        autoUpdate: false,
        debug: false,
        pruneNotification: "off",
        pruneNotificationType: "chat",
        commands: { enabled: true, protectedTools: [] },
        manualMode: { enabled: false, automaticStrategies: true },
        turnProtection: { enabled: false, turns: 4 },
        experimental: { allowSubAgents: false, customPrompts: false },
        protectedFilePatterns: [],
        compress: {
            mode: "message",
            permission: "allow",
            showCompression: false,
            summaryBuffer: true,
            maxContextLimit: 1000000,
            minContextLimit: 900000,
            nudgeFrequency: 2,
            iterationNudgeThreshold: 15,
            nudgeForce: "strong",
            protectedTools: [],
            protectTags: false,
            protectUserMessages: false,
            ...overrides,
        },
        strategies: {
            deduplication: { enabled: true, protectedTools: [] },
            purgeErrors: { enabled: true, turns: 4, protectedTools: [] },
        },
    }
}

function buildMessage(id: string, role: "user" | "assistant", text: string): WithParts {
    return {
        info: {
            id,
            role,
            sessionID: "session-1",
            agent: "assistant",
            time: { created: 1 },
            model: { providerID: "openai", modelID: "gpt-test" },
        } as WithParts["info"],
        parts: [
            {
                id: `${id}-part`,
                messageID: id,
                sessionID: "session-1",
                type: "text",
                text,
            },
        ],
    }
}

const TURN_NUDGE_TEXT = "<dcp-system-reminder>turn nudge</dcp-system-reminder>"

function buildPrompts() {
    return {
        system: "",
        compressRange: "",
        compressMessage: "",
        contextLimitNudge: "<dcp-system-reminder>context</dcp-system-reminder>",
        turnNudge: TURN_NUDGE_TEXT,
        iterationNudge: "<dcp-system-reminder>iteration</dcp-system-reminder>",
        manualExtension: "",
        subagentExtension: "",
    }
}

function buildLogger(): Logger {
    return {
        info() {},
        warn() {},
        error() {},
        debug() {},
        saveContext: async () => {},
    } as unknown as Logger
}

test("boundary nudge anchors a new user turn below minContextLimit when boundaryNudge is enabled", () => {
    const messages: WithParts[] = [
        buildMessage("msg-user-1", "user", "hello"),
        buildMessage("msg-assistant-1", "assistant", "done"),
        buildMessage("msg-user-2", "user", "next task"),
    ]
    const state = createSessionState()
    const config = buildConfig()
    const logger = buildLogger()

    injectCompressNudges(state, config, logger, messages, buildPrompts())

    assert.equal(state.nudges.turnNudgeAnchors.has("msg-user-2"), true)
    assert.equal(state.nudges.turnNudgeAnchors.has("msg-assistant-1"), true)
    assert.match(messages[2].parts[0].text as string, /turn nudge/)
})

test("boundary nudge respects nudgeFrequency throttling across consecutive user turns", () => {
    const state = createSessionState()
    const config = buildConfig({ nudgeFrequency: 2 })
    const logger = buildLogger()

    const firstTurn: WithParts[] = [
        buildMessage("msg-user-1", "user", "hello"),
        buildMessage("msg-assistant-1", "assistant", "done"),
        buildMessage("msg-user-2", "user", "next task"),
    ]
    injectCompressNudges(state, config, logger, firstTurn, buildPrompts())
    assert.equal(state.nudges.turnNudgeAnchors.has("msg-user-2"), true)

    const secondTurn: WithParts[] = [
        ...firstTurn,
        buildMessage("msg-assistant-2", "assistant", "done"),
        buildMessage("msg-user-3", "user", "another task"),
    ]
    injectCompressNudges(state, config, logger, secondTurn, buildPrompts())
    assert.equal(state.nudges.turnNudgeAnchors.has("msg-user-3"), false)

    const unthrottled = createSessionState()
    const unthrottledConfig = buildConfig({ nudgeFrequency: 1 })
    injectCompressNudges(unthrottled, unthrottledConfig, logger, firstTurn, buildPrompts())
    injectCompressNudges(unthrottled, unthrottledConfig, logger, secondTurn, buildPrompts())
    assert.equal(unthrottled.nudges.turnNudgeAnchors.has("msg-user-3"), true)
})

test("throttle counts user turns instead of message distance in tool-heavy turns", () => {
    const state = createSessionState()
    const config = buildConfig({ nudgeFrequency: 2 })
    const logger = buildLogger()

    const firstTurn: WithParts[] = [
        buildMessage("msg-user-1", "user", "hello"),
        buildMessage("msg-assistant-1", "assistant", "working"),
        buildMessage("msg-tool-1", "assistant", "tool output"),
        buildMessage("msg-user-2", "user", "next task"),
    ]
    injectCompressNudges(state, config, logger, firstTurn, buildPrompts())
    assert.equal(state.nudges.turnNudgeAnchors.has("msg-user-2"), true)

    const secondTurn: WithParts[] = [
        ...firstTurn,
        buildMessage("msg-assistant-2", "assistant", "working"),
        buildMessage("msg-tool-2", "assistant", "tool output"),
        buildMessage("msg-user-3", "user", "another task"),
    ]
    injectCompressNudges(state, config, logger, secondTurn, buildPrompts())
    assert.equal(state.nudges.turnNudgeAnchors.has("msg-user-3"), false)
})

test("pending boundary forces anchoring even when the throttle would block", () => {
    const state = createSessionState()
    const config = buildConfig({ nudgeFrequency: 2 })
    const logger = buildLogger()

    const firstTurn: WithParts[] = [
        buildMessage("msg-user-1", "user", "hello"),
        buildMessage("msg-assistant-1", "assistant", "done"),
        buildMessage("msg-user-2", "user", "next task"),
    ]
    injectCompressNudges(state, config, logger, firstTurn, buildPrompts())
    assert.equal(state.nudges.turnNudgeAnchors.has("msg-user-2"), true)

    state.nudges.boundaryPending = true
    const secondTurn: WithParts[] = [
        ...firstTurn,
        buildMessage("msg-assistant-2", "assistant", "done"),
        buildMessage("msg-user-3", "user", "another task"),
    ]
    injectCompressNudges(state, config, logger, secondTurn, buildPrompts())

    assert.equal(state.nudges.boundaryPending, false)
    assert.equal(state.nudges.turnNudgeAnchors.has("msg-user-3"), true)
    assert.equal(state.nudges.turnNudgeAnchors.has("msg-assistant-2"), true)
})

test("pending boundary survives until a complete turn exists", () => {
    const state = createSessionState()
    state.nudges.boundaryPending = true
    const config = buildConfig()
    const logger = buildLogger()

    const userOnly: WithParts[] = [buildMessage("msg-user-1", "user", "hello")]
    injectCompressNudges(state, config, logger, userOnly, buildPrompts())

    assert.equal(state.nudges.boundaryPending, true)
})

test("boundary nudge disabled keeps legacy behavior below minContextLimit", () => {
    const messages: WithParts[] = [
        buildMessage("msg-user-1", "user", "hello"),
        buildMessage("msg-assistant-1", "assistant", "done"),
        buildMessage("msg-user-2", "user", "next task"),
    ]
    const state = createSessionState()
    const config = buildConfig({ boundaryNudge: false })
    const logger = buildLogger()

    injectCompressNudges(state, config, logger, messages, buildPrompts())

    assert.equal(state.nudges.turnNudgeAnchors.size, 0)
    assert.doesNotMatch(messages[2].parts[0].text as string, /turn nudge/)
})

test("anchored boundary nudges are not re-injected into the same message across transforms", () => {
    const state = createSessionState()
    state.sessionId = "session-1"
    const config = buildConfig()
    const logger = buildLogger()

    let messages: WithParts[] = [buildMessage("msg-user-1", "user", "task one")]
    for (let turn = 0; turn < 3; turn++) {
        messages = structuredClone(messages)
        messages.push(buildMessage(`msg-assistant-${turn}`, "assistant", `done ${turn}`))
        messages.push(buildMessage(`msg-user-${turn + 2}`, "user", `task ${turn + 2}`))
        assignMessageRefs(state, messages)
        injectCompressNudges(state, config, logger, messages, buildPrompts())
    }

    const anchoredUserText = messages[2].parts[0].text as string
    assert.equal((anchoredUserText.match(/turn nudge/g) || []).length, 1)

    const rangeState = createSessionState()
    rangeState.sessionId = "session-range"
    const rangeConfig = buildConfig({ mode: "range" })
    let rangeMessages: WithParts[] = [buildMessage("r-user-1", "user", "task one")]
    for (let turn = 0; turn < 3; turn++) {
        rangeMessages = structuredClone(rangeMessages)
        rangeMessages.push(buildMessage(`r-assistant-${turn}`, "assistant", `done ${turn}`))
        rangeMessages.push(buildMessage(`r-user-${turn + 2}`, "user", `task ${turn + 2}`))
        assignMessageRefs(rangeState, rangeMessages)
        injectCompressNudges(rangeState, rangeConfig, logger, rangeMessages, buildPrompts())
    }

    const rangeAnchoredUserText = rangeMessages[2].parts[0].text as string
    assert.equal((rangeAnchoredUserText.match(/turn nudge/g) || []).length, 1)
})

test("pending boundary flag anchors the last completed turn and is consumed once", () => {
    const messages: WithParts[] = [
        buildMessage("msg-user-1", "user", "hello"),
        buildMessage("msg-assistant-1", "assistant", "done"),
        buildMessage("msg-user-2", "user", "next task"),
    ]
    const state = createSessionState()
    state.nudges.boundaryPending = true
    const config = buildConfig()
    const logger = buildLogger()

    injectCompressNudges(state, config, logger, messages, buildPrompts())

    assert.equal(state.nudges.boundaryPending, false)
    assert.equal(state.nudges.turnNudgeAnchors.has("msg-user-2"), true)
    assert.equal(state.nudges.turnNudgeAnchors.has("msg-assistant-1"), true)
    assert.match(messages[2].parts[0].text as string, /turn nudge/)

    state.nudges.boundaryPending = true
    injectCompressNudges(state, config, logger, messages, buildPrompts())
    assert.equal(state.nudges.boundaryPending, false)
})

test("session.idle event marks boundary pending on the matching session", async () => {
    const state = createSessionState()
    state.sessionId = "session-1"
    const config = buildConfig()
    const logger = buildLogger()
    const handler = createEventHandler(state, logger, config)

    await handler({ event: { type: "session.idle", properties: { sessionID: "session-1" } } })

    assert.equal(state.nudges.boundaryPending, true)
})

test("session.idle event ignores unknown sessions without creating state", async () => {
    const store = new SessionStateStore(createSessionState)
    const config = buildConfig()
    const logger = buildLogger()
    const handler = createEventHandler(store, logger, config)

    await handler({ event: { type: "session.idle", properties: { sessionID: "missing" } } })

    assert.equal(store.peek("missing"), undefined)
})

test("session.idle event respects manualMode, deny permission, and boundaryNudge=false", async () => {
    const manualState = createSessionState()
    manualState.sessionId = "session-manual"
    manualState.manualMode = "active"
    const handlerManual = createEventHandler(manualState, buildLogger(), buildConfig())
    await handlerManual({
        event: { type: "session.idle", properties: { sessionID: "session-manual" } },
    })
    assert.equal(manualState.nudges.boundaryPending, false)

    const denyState = createSessionState()
    denyState.sessionId = "session-deny"
    const handlerDeny = createEventHandler(
        denyState,
        buildLogger(),
        buildConfig({ permission: "deny" }),
    )
    await handlerDeny({
        event: { type: "session.idle", properties: { sessionID: "session-deny" } },
    })
    assert.equal(denyState.nudges.boundaryPending, false)

    const disabledState = createSessionState()
    disabledState.sessionId = "session-disabled"
    const handlerDisabled = createEventHandler(
        disabledState,
        buildLogger(),
        buildConfig({ boundaryNudge: false }),
    )
    await handlerDisabled({
        event: { type: "session.idle", properties: { sessionID: "session-disabled" } },
    })
    assert.equal(disabledState.nudges.boundaryPending, false)
})

test("vcs.branch.updated broadcasts boundary pending to all resident sessions", async () => {
    const store = new SessionStateStore(createSessionState)
    const first = store.get("session-a")
    const second = store.get("session-b")
    first.sessionId = "session-a"
    second.sessionId = "session-b"
    const config = buildConfig()
    const logger = buildLogger()
    const handler = createEventHandler(store, logger, config)

    await handler({ event: { type: "vcs.branch.updated", properties: { branch: "feat/x" } } })

    assert.equal(first.nudges.boundaryPending, true)
    assert.equal(second.nudges.boundaryPending, true)
})

test("boundary pending persists and loads across save/load round trip", async () => {
    const state = createSessionState()
    state.sessionId = "session-persist"
    state.nudges.boundaryPending = true
    const logger = buildLogger()

    await saveSessionState(state, logger)
    const loaded = await loadSessionState("session-persist", logger)

    assert.equal(loaded?.nudges.boundaryPending, true)

    state.nudges.boundaryPending = false
    await saveSessionState(state, logger)
    const loadedCleared = await loadSessionState("session-persist", logger)
    assert.equal(loadedCleared?.nudges.boundaryPending, false)
})

test("config recognizes compress.boundaryNudge and rejects non-boolean values", () => {
    assert.deepEqual(getInvalidConfigKeys({ compress: { boundaryNudge: true } }), [])

    const errors = validateConfigTypes({ compress: { boundaryNudge: "yes" } })
    assert.deepEqual(
        errors.map((error) => error.key),
        ["compress.boundaryNudge"],
    )
})

test("resetOnCompaction drops stale nudge anchors and keeps live ones", () => {
    const state = createSessionState()
    state.nudges.turnNudgeAnchors.add("msg-live")
    state.nudges.turnNudgeAnchors.add("msg-stale")
    state.nudges.contextLimitAnchors.add("msg-stale-context")
    state.nudges.iterationNudgeAnchors.add("msg-live-iteration")
    state.nudges.boundaryPending = true

    const messages: WithParts[] = [
        buildMessage("msg-live", "user", "kept"),
        buildMessage("msg-live-iteration", "assistant", "kept"),
    ]

    resetOnCompaction(state, messages)

    assert.equal(state.nudges.turnNudgeAnchors.has("msg-live"), true)
    assert.equal(state.nudges.turnNudgeAnchors.has("msg-stale"), false)
    assert.equal(state.nudges.contextLimitAnchors.has("msg-stale-context"), false)
    assert.equal(state.nudges.iterationNudgeAnchors.has("msg-live-iteration"), true)
    assert.equal(state.nudges.boundaryPending, true)
})

async function waitForPersistedBoundaryPending(
    sessionId: string,
    logger: Logger,
    expected: boolean,
): Promise<void> {
    for (let attempt = 0; attempt < 50; attempt++) {
        const loaded = await loadSessionState(sessionId, logger)
        if ((loaded?.nudges.boundaryPending ?? false) === expected) {
            return
        }
        await new Promise((resolve) => setTimeout(resolve, 10))
    }
    assert.fail(`boundaryPending did not persist as ${expected} for ${sessionId}`)
}

test("deny permission clears pending boundary and persists it on next transform", async () => {
    const state = createSessionState()
    state.sessionId = "session-deny-clear"
    state.nudges.boundaryPending = true
    const config = buildConfig({ permission: "deny" })
    const logger = buildLogger()
    await saveSessionState(state, logger)

    injectCompressNudges(
        state,
        config,
        logger,
        [buildMessage("msg-user-1", "user", "hello")],
        buildPrompts(),
    )

    assert.equal(state.nudges.boundaryPending, false)
    await waitForPersistedBoundaryPending("session-deny-clear", logger, false)
})

test("manualMode clears pending boundary and persists it on next transform", async () => {
    const state = createSessionState()
    state.sessionId = "session-manual-clear"
    state.manualMode = "active"
    state.nudges.boundaryPending = true
    const config = buildConfig()
    const logger = buildLogger()
    await saveSessionState(state, logger)

    injectCompressNudges(
        state,
        config,
        logger,
        [buildMessage("msg-user-1", "user", "hello")],
        buildPrompts(),
    )

    assert.equal(state.nudges.boundaryPending, false)
    await waitForPersistedBoundaryPending("session-manual-clear", logger, false)
})
