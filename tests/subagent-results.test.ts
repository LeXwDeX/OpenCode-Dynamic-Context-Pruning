import assert from "node:assert/strict"
import test from "node:test"
import {
    getSubAgentId,
    buildSubagentResultText,
    mergeSubagentResult,
} from "../lib/subagents/subagent-results"
import type { WithParts } from "../lib/state"

function buildAssistantMessage(
    id: string,
    parts: WithParts["parts"],
    sessionID = "ses_test",
): WithParts {
    return {
        info: {
            id,
            role: "assistant",
            sessionID,
            agent: "assistant",
            time: { created: Date.now() },
        } as WithParts["info"],
        parts,
    }
}

function textPart(text: string, messageID = "msg", sessionID = "ses_test") {
    return {
        id: `part_${Math.random().toString(36).slice(2)}`,
        messageID,
        sessionID,
        type: "text" as const,
        text,
    }
}

function compressToolPart(sessionID = "ses_test") {
    return {
        id: `part_tool`,
        messageID: "msg",
        sessionID,
        type: "tool" as const,
        tool: "compress",
        callID: "call_1",
        state: { status: "completed" as const, output: "compressed" },
    }
}

test("getSubAgentId returns session ID from part metadata", () => {
    const part = { state: { metadata: { sessionId: "ses_sub_123" } } }
    assert.equal(getSubAgentId(part), "ses_sub_123")
})

test("getSubAgentId returns null for missing metadata", () => {
    assert.equal(getSubAgentId({}), null)
    assert.equal(getSubAgentId(null), null)
    assert.equal(getSubAgentId(undefined), null)
    assert.equal(getSubAgentId({ state: {} }), null)
    assert.equal(getSubAgentId({ state: { metadata: {} } }), null)
})

test("getSubAgentId returns null for empty/whitespace session ID", () => {
    assert.equal(getSubAgentId({ state: { metadata: { sessionId: "" } } }), null)
    assert.equal(getSubAgentId({ state: { metadata: { sessionId: "   " } } }), null)
})

test("getSubAgentId returns null for non-string session ID", () => {
    assert.equal(getSubAgentId({ state: { metadata: { sessionId: 123 } } }), null)
})

test("buildSubagentResultText returns empty for no messages", () => {
    assert.equal(buildSubagentResultText([]), "")
})

test("buildSubagentResultText returns last assistant text", () => {
    const messages: WithParts[] = [
        buildAssistantMessage("msg1", [textPart("Hello world")]),
    ]
    assert.equal(buildSubagentResultText(messages), "Hello world")
})

test("buildSubagentResultText returns only last assistant text when no compress in second-to-last", () => {
    const messages: WithParts[] = [
        buildAssistantMessage("msg1", [textPart("First response")]),
        buildAssistantMessage("msg2", [textPart("Second response")]),
    ]
    assert.equal(buildSubagentResultText(messages), "Second response")
})

test("buildSubagentResultText combines last two when second-to-last has compress tool", () => {
    const messages: WithParts[] = [
        buildAssistantMessage("msg1", [compressToolPart(), textPart("After compress")]),
        buildAssistantMessage("msg2", [textPart("Final text")]),
    ]
    assert.equal(buildSubagentResultText(messages), "After compress\n\nFinal text")
})

test("buildSubagentResultText handles empty text parts", () => {
    const messages: WithParts[] = [
        buildAssistantMessage("msg1", [textPart("")]),
    ]
    assert.equal(buildSubagentResultText(messages), "")
})

test("buildSubagentResultText filters non-assistant messages", () => {
    const userMessage: WithParts = {
        info: {
            id: "msg-user",
            role: "user",
            sessionID: "ses_test",
            agent: "assistant",
            model: { providerID: "test", modelID: "test" },
            time: { created: 1 },
        } as WithParts["info"],
        parts: [textPart("user text")],
    }
    const messages: WithParts[] = [
        userMessage,
        buildAssistantMessage("msg1", [textPart("Assistant text")]),
    ]
    assert.equal(buildSubagentResultText(messages), "Assistant text")
})

test("mergeSubagentResult replaces task_result content", () => {
    const output = "prefix <task_result> old content </task_result> suffix"
    const result = mergeSubagentResult(output, "new content")
    assert.equal(result, "prefix <task_result> new content </task_result> suffix")
})

test("mergeSubagentResult returns original when no subAgentResultText", () => {
    const output = "prefix <task_result> old </task_result> suffix"
    assert.equal(mergeSubagentResult(output, ""), output)
})

test("mergeSubagentResult returns original when output is not string", () => {
    assert.equal(mergeSubagentResult(null as any, "text"), null)
})

test("mergeSubagentResult leaves output unchanged when no task_result tag", () => {
    const output = "no task result here"
    assert.equal(mergeSubagentResult(output, "replacement"), "no task result here")
})
