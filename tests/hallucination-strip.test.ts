import assert from "node:assert/strict"
import test from "node:test"
import { stripHallucinations } from "../lib/messages/utils"
import type { WithParts } from "../lib/state"

function message(role: "user" | "assistant", parts: unknown[]): WithParts {
    return {
        info: {
            id: `message-${role}`,
            role,
            sessionID: "session-1",
            time: { created: 1 },
        } as WithParts["info"],
        parts: parts as WithParts["parts"],
    }
}

test("hallucination stripping preserves user-authored tag examples", () => {
    const messages = [
        message("user", [
            {
                type: "text",
                text: "请保留 <dcp-message-id>m0001</dcp-message-id>",
            },
        ]),
    ]

    stripHallucinations(messages)
    assert.equal(
        (messages[0].parts[0] as { text: string }).text,
        "请保留 <dcp-message-id>m0001</dcp-message-id>",
    )
})

test("hallucination stripping preserves tool output but cleans assistant text", () => {
    const messages = [
        message("assistant", [
            { type: "text", text: "alpha <dcp>beta</dcp> omega" },
            {
                type: "tool",
                tool: "read",
                callID: "call-1",
                state: {
                    status: "completed",
                    input: {},
                    output: "literal <dcp>tool data</dcp>",
                },
            },
        ]),
    ]

    stripHallucinations(messages)
    assert.equal((messages[0].parts[0] as { text: string }).text, "alpha  omega")
    assert.equal(
        (messages[0].parts[1] as { state: { output: string } }).state.output,
        "literal <dcp>tool data</dcp>",
    )
})
