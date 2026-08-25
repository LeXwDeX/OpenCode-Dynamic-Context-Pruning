import assert from "node:assert/strict"
import test from "node:test"
import { PRUNE_TOOL_NAME, createPruneTool } from "../lib/prune-tool"
import { Logger } from "../lib/logger"

const MODEL_MESSAGE = [
    {
        info: {
            role: "user",
            model: { providerID: "anthropic", modelID: "claude-sonnet" },
        },
    },
]

function buildDeps(
    messages: unknown[],
    result?: { status: string; retryAfterMs?: number; error?: string },
) {
    const calls: unknown[] = []
    const summarize = {
        summarize: async (request: unknown) => {
            calls.push(request)
            return result ?? ({ status: "succeeded" } as const)
        },
    }
    const deps = {
        client: {
            session: { messages: async () => ({ data: messages }) },
            tui: { showToast: async () => {} },
        } as any,
        summarize: summarize as any,
        logger: new Logger(false),
    }
    return { deps, calls }
}

async function runTool(deps: any): Promise<string> {
    const definition = createPruneTool(deps)
    return (definition.execute as (args: unknown, context: unknown) => Promise<string>)(
        {},
        {
            sessionID: "ses_tool",
        },
    )
}

test("tool name is namespaced as dcp_prune", () => {
    assert.equal(PRUNE_TOOL_NAME, "dcp_prune")
})

test("tool description carries the heuristic usage guidance", () => {
    const definition = createPruneTool(buildDeps([]).deps)
    assert.match(definition.description, /话题.*变更/)
    assert.match(definition.description, /立即调用/)
})

test("execute triggers native summarize with the session model", async () => {
    const { deps, calls } = buildDeps(MODEL_MESSAGE)
    const output = await runTool(deps)

    assert.deepEqual(calls, [
        {
            sessionID: "ses_tool",
            model: { providerID: "anthropic", modelID: "claude-sonnet" },
        },
    ])
    assert.match(output, /压缩完成/)
})

test("execute reports cooldown without calling summarize twice", async () => {
    const { deps, calls } = buildDeps(MODEL_MESSAGE, {
        status: "cooldown",
        retryAfterMs: 12_000,
    })
    const output = await runTool(deps)

    assert.equal(calls.length, 1)
    assert.match(output, /12 秒后才能重试/)
})

test("execute keeps the original context on failure", async () => {
    const { deps, calls } = buildDeps(MODEL_MESSAGE, {
        status: "failed",
        error: "boom",
    })
    const output = await runTool(deps)

    assert.equal(calls.length, 1)
    assert.match(output, /失败/)
    assert.match(output, /保持不变|原始上下文/)
})

test("execute explains when no session model exists yet", async () => {
    const { deps, calls } = buildDeps([])
    const output = await runTool(deps)

    assert.equal(calls.length, 0)
    assert.match(output, /模型/)
})
