import assert from "node:assert/strict"
import test from "node:test"
import {
    runWithConcurrency,
    serializeMessagesForExternalSummary,
} from "../lib/compress/external-content"
import type { WithParts } from "../lib/state"

test("external summary content includes text plus tool input and output", () => {
    const message = {
        info: {
            id: "message-1",
            role: "assistant",
            sessionID: "session-1",
            time: { created: 1 },
        },
        parts: [
            { type: "text", text: "检查构建结果" },
            {
                type: "tool",
                tool: "read",
                callID: "call-1",
                state: {
                    status: "completed",
                    input: { filePath: "src/index.ts" },
                    output: "export const answer = 42",
                },
            },
        ],
    } as WithParts

    const content = serializeMessagesForExternalSummary([message])

    assert.match(content, /消息：message-1；角色：assistant/)
    assert.match(content, /检查构建结果/)
    assert.match(content, /工具：read；状态：completed/)
    assert.match(content, /src\/index\.ts/)
    assert.match(content, /export const answer = 42/)
})

test("external summary content includes tool errors", () => {
    const message = {
        info: {
            id: "message-2",
            role: "assistant",
            sessionID: "session-1",
            time: { created: 2 },
        },
        parts: [
            {
                type: "tool",
                tool: "bash",
                callID: "call-2",
                state: {
                    status: "error",
                    input: { command: "npm test" },
                    error: "exit code 1",
                },
            },
        ],
    } as WithParts

    const content = serializeMessagesForExternalSummary([message])
    assert.match(content, /npm test/)
    assert.match(content, /exit code 1/)
})

test("external summary work uses bounded concurrency", async () => {
    let active = 0
    let maximum = 0
    const completed: number[] = []

    await runWithConcurrency([1, 2, 3, 4, 5], 2, async (value) => {
        active++
        maximum = Math.max(maximum, active)
        await new Promise((resolve) => setTimeout(resolve, 1))
        completed.push(value)
        active--
    })

    assert.equal(maximum, 2)
    assert.deepEqual(completed.sort(), [1, 2, 3, 4, 5])
})
