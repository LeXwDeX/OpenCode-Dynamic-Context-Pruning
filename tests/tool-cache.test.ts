import assert from "node:assert/strict"
import test from "node:test"
import type { PluginConfig } from "../lib/config"
import { Logger } from "../lib/logger"
import { createSessionState, syncToolCache, type WithParts } from "../lib/state"

const config = {
    turnProtection: { enabled: false, turns: 4 },
} as PluginConfig

function toolMessage(index: number): WithParts {
    const messageId = `message-${index}`
    const callId = `call-${index}`
    return {
        info: {
            id: messageId,
            role: "assistant",
            sessionID: "session-1",
            time: { created: index },
        } as WithParts["info"],
        parts: [
            {
                type: "tool",
                messageID: messageId,
                sessionID: "session-1",
                callID: callId,
                tool: "read",
                state: {
                    status: "completed",
                    input: { filePath: `file-${index}.txt` },
                    output: `result-${index}`,
                },
            },
        ] as WithParts["parts"],
    }
}

test("tool cache keeps a stable newest window above its capacity", () => {
    const state = createSessionState()
    const messages = Array.from({ length: 1100 }, (_, index) => toolMessage(index))
    const logger = new Logger(false)

    syncToolCache(state, config, logger, messages)
    const firstKeys = Array.from(state.toolParameters.keys())
    syncToolCache(state, config, logger, messages)
    const secondKeys = Array.from(state.toolParameters.keys())

    assert.equal(firstKeys.length, 1000)
    assert.equal(firstKeys[0], "call-100")
    assert.equal(firstKeys.at(-1), "call-1099")
    assert.deepEqual(secondKeys, firstKeys)
})
