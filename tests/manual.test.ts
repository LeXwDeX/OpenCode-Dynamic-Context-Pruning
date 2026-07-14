import assert from "node:assert/strict"
import test from "node:test"
import type { PluginConfig } from "../lib/config"
import { handleManualTriggerCommand } from "../lib/commands/manual"
import { Logger } from "../lib/logger"
import { createSessionState, type WithParts } from "../lib/state"

function message(id: string, created: number, role: "user" | "assistant" = "user"): WithParts {
    return {
        info: {
            id,
            role,
            sessionID: "session-1",
            agent: "build",
            time: { created },
        } as WithParts["info"],
        parts: [
            {
                id: `${id}-part`,
                messageID: id,
                sessionID: "session-1",
                type: "text",
                text: id,
            },
        ],
    }
}

test("manual compression prompt lists valid range boundary IDs", async () => {
    const state = createSessionState()
    const messages = [message("message-1", 1), message("message-2", 2)]

    state.messageIds.byRawId.set("message-1", "m0001")
    state.messageIds.byRawId.set("message-2", "m0002")
    state.messageIds.byRef.set("m0001", "message-1")
    state.messageIds.byRef.set("m0002", "message-2")

    const prompt = await handleManualTriggerCommand(
        {
            client: {} as any,
            state,
            config: { compress: { mode: "range" } } as PluginConfig,
            logger: new Logger(false),
            sessionId: "session-1",
            messages,
        },
        "compress",
    )

    assert.match(prompt || "", /可用消息边界 ID：[\s\S]*m0001, m0002/)
    assert.match(prompt || "", /startId 和 endId/)
})

test("manual message compression prompt lists valid message IDs", async () => {
    const state = createSessionState()
    const messages = [message("message-1", 1), message("message-2", 2)]

    state.messageIds.byRawId.set("message-1", "m0001")
    state.messageIds.byRawId.set("message-2", "m0002")
    state.messageIds.byRef.set("m0001", "message-1")
    state.messageIds.byRef.set("m0002", "message-2")

    const prompt = await handleManualTriggerCommand(
        {
            client: {} as any,
            state,
            config: { compress: { mode: "message" } } as PluginConfig,
            logger: new Logger(false),
            sessionId: "session-1",
            messages,
        },
        "compress",
    )

    assert.match(prompt || "", /可用消息边界 ID：[\s\S]*m0001, m0002/)
    assert.match(prompt || "", /content\[\]\.messageId/)
    assert.doesNotMatch(prompt || "", /startId|endId/)
})

test("manual message compression prompt excludes protected user messages", async () => {
    const state = createSessionState()
    const messages = [message("message-1", 1), message("message-2", 2, "assistant")]

    state.messageIds.byRawId.set("message-1", "m0001")
    state.messageIds.byRawId.set("message-2", "m0002")
    state.messageIds.byRef.set("m0001", "message-1")
    state.messageIds.byRef.set("m0002", "message-2")

    const prompt = await handleManualTriggerCommand(
        {
            client: {} as any,
            state,
            config: {
                compress: { mode: "message", protectUserMessages: true },
            } as PluginConfig,
            logger: new Logger(false),
            sessionId: "session-1",
            messages,
        },
        "compress",
    )

    assert.match(prompt || "", /content\[\]\.messageId/)
    assert.match(prompt || "", /m0002/)
    assert.doesNotMatch(prompt || "", /m0001/)
})
