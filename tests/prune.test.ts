import assert from "node:assert/strict"
import test from "node:test"
import { prune } from "../lib/messages/prune"
import { createSessionState } from "../lib/state"
import { Logger } from "../lib/logger"
import type { PluginConfig } from "../lib/config"
import type { WithParts } from "../lib/state"

function buildConfig(): PluginConfig {
    return {
        enabled: true,
        debug: false,
        autoUpdate: false,
        protectedFilePatterns: [],
        strategies: {
            deduplication: { enabled: false, protectedTools: [] },
            purgeErrors: { enabled: false, turns: 2, protectedTools: [] },
        },
        compress: {
            mode: "range",
            permission: "auto",
            protectedTools: [],
        },
        manualMode: { enabled: false, automaticStrategies: false },
        commands: { enabled: true },
        experimental: { allowSubAgents: false, customPrompts: false },
    } as any
}

function buildAssistantMessage(id: string, parts: any[], sessionID = "ses_test"): WithParts {
    return {
        info: {
            id,
            role: "assistant",
            sessionID,
            agent: "assistant",
            time: { created: 1 },
        } as WithParts["info"],
        parts,
    }
}

function buildUserMessage(id: string, text: string, sessionID = "ses_test"): WithParts {
    return {
        info: {
            id,
            role: "user",
            sessionID,
            agent: "assistant",
            model: { providerID: "anthropic", modelID: "claude" },
            time: { created: 1 },
        } as WithParts["info"],
        parts: [
            {
                id: `part_${id}`,
                messageID: id,
                sessionID,
                type: "text" as const,
                text,
            },
        ],
    }
}

function toolPart(callID: string, tool: string, status: string, output?: string, input?: any) {
    return {
        id: `part_${callID}`,
        messageID: "msg",
        sessionID: "ses_test",
        type: "tool" as const,
        tool,
        callID,
        state: {
            status,
            output: output ?? "result",
            input: input ?? {},
        },
    }
}

test("prune replaces output for pruned completed tool calls", () => {
    const state = createSessionState()
    const logger = new Logger(false)
    const config = buildConfig()

    state.prune.tools.set("call1", 100)

    const messages: WithParts[] = [
        buildAssistantMessage("msg1", [
            toolPart("call1", "bash", "completed", "very long output"),
            toolPart("call2", "bash", "completed", "keep this"),
        ]),
    ]

    prune(state, logger, config, messages)

    const parts = messages[0].parts
    assert.equal(
        (parts[0] as any).state.output,
        "[Output removed to save context - information superseded or no longer needed]",
    )
    assert.equal((parts[1] as any).state.output, "keep this")
})

test("prune does not replace output for edit/write/question tools", () => {
    const state = createSessionState()
    const logger = new Logger(false)
    const config = buildConfig()

    state.prune.tools.set("call1", 100)
    state.prune.tools.set("call2", 100)
    state.prune.tools.set("call3", 100)

    const messages: WithParts[] = [
        buildAssistantMessage("msg1", [
            toolPart("call1", "edit", "completed", "edit output"),
            toolPart("call2", "write", "completed", "write output"),
            toolPart("call3", "question", "completed", "question output"),
        ]),
    ]

    prune(state, logger, config, messages)

    // edit and write outputs should be preserved (pruneToolOutputs skips them)
    assert.equal((messages[0].parts[0] as any).state.output, "edit output")
    assert.equal((messages[0].parts[1] as any).state.output, "write output")
    // question output should be preserved (pruneToolOutputs skips question)
    assert.equal((messages[0].parts[2] as any).state.output, "question output")
})

test("prune replaces question input for pruned question tools", () => {
    const state = createSessionState()
    const logger = new Logger(false)
    const config = buildConfig()

    state.prune.tools.set("call1", 100)

    const messages: WithParts[] = [
        buildAssistantMessage("msg1", [
            toolPart("call1", "question", "completed", "answer", {
                questions: [{ question: "Do you want?" }],
            }),
        ]),
    ]

    prune(state, logger, config, messages)

    assert.equal(
        (messages[0].parts[0] as any).state.input.questions,
        "[questions removed - see output for user's answers]",
    )
})

test("prune replaces string inputs for errored tools", () => {
    const state = createSessionState()
    const logger = new Logger(false)
    const config = buildConfig()

    state.prune.tools.set("call1", 100)

    const messages: WithParts[] = [
        buildAssistantMessage("msg1", [
            toolPart("call1", "bash", "error", "error msg", {
                command: "very long command string",
                timeout: 5000,
            }),
        ]),
    ]

    prune(state, logger, config, messages)

    const input = (messages[0].parts[0] as any).state.input
    assert.equal(input.command, "[input removed due to failed tool call]")
    // Non-string inputs should not be replaced
    assert.equal(input.timeout, 5000)
})

test("prune skips compacted messages", () => {
    const state = createSessionState()
    const logger = new Logger(false)
    const config = buildConfig()

    state.prune.tools.set("call1", 100)

    // Mark the message as compacted by setting lastCompaction after message creation time
    state.lastCompaction = 999

    const messages: WithParts[] = [
        {
            info: {
                id: "msg1",
                role: "assistant",
                sessionID: "ses_test",
                agent: "assistant",
                time: { created: 1 },
            } as WithParts["info"],
            parts: [toolPart("call1", "bash", "completed", "keep this output")],
        },
    ]

    prune(state, logger, config, messages)

    // Should not be pruned because it's compacted (created before lastCompaction)
    assert.equal((messages[0].parts[0] as any).state.output, "keep this output")
})

test("prune does not prune non-pruned tool IDs", () => {
    const state = createSessionState()
    const logger = new Logger(false)
    const config = buildConfig()

    const messages: WithParts[] = [
        buildAssistantMessage("msg1", [
            toolPart("call1", "bash", "completed", "original output"),
        ]),
    ]

    prune(state, logger, config, messages)

    assert.equal((messages[0].parts[0] as any).state.output, "original output")
})

test("prune filterCompressedRanges removes messages in active blocks", () => {
    const state = createSessionState()
    const logger = new Logger(false)
    const config = buildConfig()

    // Set up a compressed range
    state.prune.messages.byMessageId.set("msg2", { activeBlockIds: [1] })
    state.prune.messages.activeByAnchorMessageId.set("msg1", 1)
    state.prune.messages.blocksById.set(1, {
        blockId: 1,
        active: true,
        summary: "Compressed summary of msg2",
        anchorMessageId: "msg1",
    } as any)

    const messages: WithParts[] = [
        buildUserMessage("msg1", "first message"),
        buildAssistantMessage("msg2", [
            toolPart("call1", "bash", "completed", "output"),
        ]),
        buildUserMessage("msg3", "third message"),
    ]

    prune(state, logger, config, messages)

    // msg2 should be filtered out, summary injected before msg1
    assert.ok(messages.some((m) => m.info.id === "msg3"))
    // msg2 should be removed
    assert.ok(!messages.some((m) => m.info.id === "msg2"))
})
