import assert from "node:assert/strict"
import test from "node:test"
import { stripStaleMetadata } from "../lib/messages/reasoning-strip"
import type { WithParts } from "../lib/state"

function buildUserMessage(
    modelID: string,
    providerID: string,
    sessionID = "ses_test",
): WithParts {
    return {
        info: {
            id: "msg-user",
            role: "user",
            sessionID,
            agent: "assistant",
            model: { modelID, providerID },
            time: { created: 1 },
        } as WithParts["info"],
        parts: [
            {
                id: "part-user",
                messageID: "msg-user",
                sessionID,
                type: "text" as const,
                text: "hello",
            },
        ],
    }
}

function buildAssistantMessage(
    modelID: string,
    providerID: string,
    parts: any[],
    sessionID = "ses_test",
): WithParts {
    return {
        info: {
            id: "msg-assistant",
            role: "assistant",
            sessionID,
            agent: "assistant",
            modelID,
            providerID,
            time: { created: 2 },
        } as WithParts["info"],
        parts,
    }
}

test("stripStaleMetadata does nothing when no messages", () => {
    const messages: WithParts[] = []
    stripStaleMetadata(messages)
    assert.equal(messages.length, 0)
})

test("stripStaleMetadata does nothing when no user message", () => {
    const messages: WithParts[] = [
        buildAssistantMessage("claude", "anthropic", [
            {
                id: "p1",
                messageID: "msg-assistant",
                sessionID: "ses_test",
                type: "text" as const,
                text: "hello",
                metadata: { key: "value" },
            },
        ]),
    ]
    stripStaleMetadata(messages)
    assert.ok("metadata" in messages[0].parts[0])
})

test("stripStaleMetadata strips metadata from assistant parts with different model", () => {
    const messages: WithParts[] = [
        buildUserMessage("claude-4", "anthropic"),
        buildAssistantMessage("gpt-4", "openai", [
            {
                id: "p1",
                messageID: "msg-assistant",
                sessionID: "ses_test",
                type: "text" as const,
                text: "response",
                metadata: { reasoning: "thinking..." },
            },
        ]),
    ]
    stripStaleMetadata(messages)
    assert.ok(!("metadata" in messages[1].parts[0]))
    assert.equal((messages[1].parts[0] as any).text, "response")
})

test("stripStaleMetadata preserves metadata when model matches", () => {
    const messages: WithParts[] = [
        buildUserMessage("claude-4", "anthropic"),
        buildAssistantMessage("claude-4", "anthropic", [
            {
                id: "p1",
                messageID: "msg-assistant",
                sessionID: "ses_test",
                type: "text" as const,
                text: "response",
                metadata: { reasoning: "thinking..." },
            },
        ]),
    ]
    stripStaleMetadata(messages)
    assert.ok("metadata" in messages[1].parts[0])
})

test("stripStaleMetadata preserves parts without metadata", () => {
    const messages: WithParts[] = [
        buildUserMessage("claude-4", "anthropic"),
        buildAssistantMessage("gpt-4", "openai", [
            {
                id: "p1",
                messageID: "msg-assistant",
                sessionID: "ses_test",
                type: "text" as const,
                text: "no metadata here",
            },
        ]),
    ]
    stripStaleMetadata(messages)
    assert.equal((messages[1].parts[0] as any).text, "no metadata here")
})

test("stripStaleMetadata strips metadata from tool parts with different model", () => {
    const messages: WithParts[] = [
        buildUserMessage("claude-4", "anthropic"),
        buildAssistantMessage("gpt-4", "openai", [
            {
                id: "p1",
                messageID: "msg-assistant",
                sessionID: "ses_test",
                type: "tool" as const,
                tool: "bash",
                callID: "call1",
                state: { status: "completed", output: "ok" },
                metadata: { tokens: 100 },
            },
        ]),
    ]
    stripStaleMetadata(messages)
    assert.ok(!("metadata" in messages[1].parts[0]))
})

test("stripStaleMetadata skips non-text non-tool parts", () => {
    const messages: WithParts[] = [
        buildUserMessage("claude-4", "anthropic"),
        buildAssistantMessage("gpt-4", "openai", [
            {
                id: "p1",
                messageID: "msg-assistant",
                sessionID: "ses_test",
                type: "image" as any,
                metadata: { should: "stay" },
            },
        ]),
    ]
    stripStaleMetadata(messages)
    // Non-text/tool parts should be preserved as-is
    assert.ok("metadata" in messages[1].parts[0])
})
