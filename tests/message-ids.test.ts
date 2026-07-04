import assert from "node:assert/strict"
import test from "node:test"
import { Logger } from "../lib/logger"
import { assignMessageRefs } from "../lib/message-ids"
import { checkSession, createSessionState, type WithParts } from "../lib/state"

function textPart(messageID: string, sessionID: string, id: string, text: string) {
    return {
        id,
        messageID,
        sessionID,
        type: "text" as const,
        text,
    }
}

function buildCompactedMessages(sessionID: string): WithParts[] {
    return [
        {
            info: {
                id: "msg-assistant-summary",
                role: "assistant",
                sessionID,
                agent: "assistant",
                summary: true,
                time: { created: 2 },
            } as WithParts["info"],
            parts: [
                textPart(
                    "msg-assistant-summary",
                    sessionID,
                    "msg-assistant-summary-part",
                    "Compaction summary",
                ),
            ],
        },
        {
            info: {
                id: "msg-user-follow-up",
                role: "user",
                sessionID,
                agent: "assistant",
                model: {
                    providerID: "anthropic",
                    modelID: "claude-test",
                },
                time: { created: 3 },
            } as WithParts["info"],
            parts: [
                textPart(
                    "msg-user-follow-up",
                    sessionID,
                    "msg-user-follow-up-part",
                    "Continue after compaction",
                ),
            ],
        },
    ]
}

test("checkSession garbage-collects stale message id aliases after native compaction", async () => {
    const sessionID = `ses_message_ids_after_compaction_${Date.now()}`
    const messages = buildCompactedMessages(sessionID)
    const state = createSessionState()
    const logger = new Logger(false)

    state.sessionId = sessionID
    state.messageIds.byRawId.set("old-message-9998", "m9998")
    state.messageIds.byRawId.set("old-message-9999", "m9999")
    state.messageIds.byRef.set("m9998", "old-message-9998")
    state.messageIds.byRef.set("m9999", "old-message-9999")
    state.messageIds.nextRef = 5

    await checkSession({} as any, state, logger, messages, false)

    assert.equal(state.lastCompaction, 2)
    assert.equal(state.messageIds.byRawId.has("old-message-9998"), false)
    assert.equal(state.messageIds.byRawId.has("old-message-9999"), false)
    assert.equal(state.messageIds.byRef.has("m9998"), false)
    assert.equal(state.messageIds.byRef.has("m9999"), false)
    assert.equal(state.messageIds.nextRef, 5)

    const assigned = assignMessageRefs(state, messages)

    assert.equal(assigned, 2)
    assert.equal(state.messageIds.byRawId.get("msg-assistant-summary"), "m0005")
    assert.equal(state.messageIds.byRawId.get("msg-user-follow-up"), "m0006")
    assert.equal(state.messageIds.byRef.get("m0005"), "msg-assistant-summary")
    assert.equal(state.messageIds.byRef.get("m0006"), "msg-user-follow-up")
    assert.equal(state.messageIds.nextRef, 7)
})

test("assignMessageRefs skips pre-compaction messages reintroduced via full session history", async () => {
    const sessionID = `ses_message_ids_full_history_${Date.now()}`
    const compactedMessages = buildCompactedMessages(sessionID)
    const state = createSessionState()
    const logger = new Logger(false)

    state.sessionId = sessionID
    await checkSession({} as any, state, logger, compactedMessages, false)
    assignMessageRefs(state, compactedMessages)

    const preCompactionMessage: WithParts = {
        info: {
            id: "msg-before-compaction",
            role: "user",
            sessionID,
            agent: "assistant",
            model: {
                providerID: "anthropic",
                modelID: "claude-test",
            },
            time: { created: 1 },
        } as WithParts["info"],
        parts: [
            textPart(
                "msg-before-compaction",
                sessionID,
                "msg-before-compaction-part",
                "This happened before the compaction summary",
            ),
        ],
    }

    // Simulate the compress tool fetching the full raw session history, which
    // still includes messages from before the native compaction boundary.
    const fullHistory = [preCompactionMessage, ...compactedMessages]
    const assigned = assignMessageRefs(state, fullHistory)

    assert.equal(assigned, 0)
    assert.equal(state.messageIds.byRawId.has("msg-before-compaction"), false)
})
