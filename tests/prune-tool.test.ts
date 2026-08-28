import assert from "node:assert/strict"
import test from "node:test"
import { PRUNE_TOOL_NAME, createPruneTool } from "../lib/prune-tool"
import type { PruneOutcome } from "../lib/prune-service"
import { Logger } from "../lib/logger"

function buildDeps(result?: PruneOutcome) {
    const requests: Array<{ sessionID: string; onBusy: string }> = []
    const deps = {
        prune: {
            request: async (request: { sessionID: string; onBusy: string }) => {
                requests.push(request)
                return result ?? ({ status: "deferred" } as PruneOutcome)
            },
        } as any,
        logger: new Logger(false),
    }
    return { deps, requests }
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

test("tool description only authorizes topic changes and explicit requests", () => {
    const definition = createPruneTool(buildDeps().deps)
    assert.match(definition.description, /话题.*变更/)
    assert.match(definition.description, /用户明确要求/)
    assert.doesNotMatch(definition.description, /立即调用/)
    assert.doesNotMatch(definition.description, /上下文明显变长/)
})

test("tool description documents the deferred, non-interrupting execution", () => {
    const definition = createPruneTool(buildDeps().deps)
    assert.match(definition.description, /排队/)
    assert.match(definition.description, /尝试/)
    assert.match(definition.description, /空闲边界/)
    assert.doesNotMatch(definition.description, /将在.*执行/)
})

test("execute always requests with the defer policy so a running turn is never interrupted", async () => {
    const { deps, requests } = buildDeps()
    await runTool(deps)

    assert.deepEqual(requests, [{ sessionID: "ses_tool", onBusy: "defer" }])
})

test("execute reports a queued prune while the session is mid-turn", async () => {
    const { deps } = buildDeps({ status: "deferred" })
    const output = await runTool(deps)

    assert.match(output, /排队/)
    assert.match(output, /尝试/)
    assert.match(output, /空闲边界/)
})

test("execute reports success once compaction has run", async () => {
    const { deps, requests } = buildDeps({ status: "succeeded" })
    const output = await runTool(deps)

    assert.equal(requests.length, 1)
    assert.match(output, /压缩完成/)
})

test("execute reports busy without claiming compaction happened", async () => {
    const { deps } = buildDeps({ status: "busy" })
    const output = await runTool(deps)

    assert.match(output, /未执行压缩/)
    assert.doesNotMatch(output, /压缩完成/)
})

test("execute reports cooldown without calling summarize twice", async () => {
    const { deps, requests } = buildDeps({ status: "cooldown", retryAfterMs: 12_000 })
    const output = await runTool(deps)

    assert.equal(requests.length, 1)
    assert.match(output, /12 秒后才能重试/)
})

test("execute keeps the original context on failure", async () => {
    const { deps, requests } = buildDeps({ status: "failed", error: "boom" })
    const output = await runTool(deps)

    assert.equal(requests.length, 1)
    assert.match(output, /失败/)
    assert.match(output, /保持不变|原始上下文/)
})

test("execute explains when no session model exists yet", async () => {
    const { deps, requests } = buildDeps({ status: "no-model" })
    const output = await runTool(deps)

    assert.equal(requests.length, 1)
    assert.match(output, /模型/)
})
