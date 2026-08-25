import assert from "node:assert/strict"
import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import test from "node:test"
import { createSessionCompactingHandler } from "../lib/hooks"
import { COMPACTION } from "../lib/prompts/compaction"
import { PromptStore } from "../lib/prompts/store"
import { Logger } from "../lib/logger"

function buildPromptStore(): PromptStore {
    return new PromptStore(new Logger(false), mkdtempSync(join(tmpdir(), "dcp-prompts-")), false)
}

test("bundled compaction prompt is a non-empty instruction document", () => {
    assert.equal(typeof COMPACTION, "string")
    assert.ok(COMPACTION.trim().length > 0)
})

test("compaction prompt instructs rolling checkpoint merge of the previous checkpoint", () => {
    assert.ok(COMPACTION.includes("检查点"))
})

test("compaction prompt prunes unrelated chatter and other projects", () => {
    assert.ok(COMPACTION.includes("无关"))
    assert.ok(/其他项目|其他仓库/.test(COMPACTION))
})

test("compaction prompt folds repeated tool trial-and-error into final outcomes", () => {
    assert.ok(/试错|失败/.test(COMPACTION))
})

test("compaction prompt folds repeated edits into final state and key decisions", () => {
    assert.ok(/重复编辑|最终状态/.test(COMPACTION))
})

test("compaction prompt compresses small completed topics", () => {
    assert.ok(/已完成/.test(COMPACTION))
})

test("compaction prompt uses the three-tier checkpoint structure", () => {
    assert.ok(COMPACTION.includes("## 系统上下文"))
    assert.ok(COMPACTION.includes("## 历史概要"))
    assert.ok(COMPACTION.includes("## 已完成任务的概括"))
    assert.ok(COMPACTION.includes("## 进行中任务详情"))
})

test("compaction prompt preserves system-level content like AGENTS.md", () => {
    assert.ok(COMPACTION.includes("AGENTS.md"))
    assert.ok(COMPACTION.includes("原样保留"))
})

test("compaction prompt keeps in-progress task details continuation-ready", () => {
    for (const keyword of ["目标", "已完成步骤", "文件路径", "关键决策", "阻塞", "下一步"]) {
        assert.ok(COMPACTION.includes(keyword), `prompt must mention ${keyword}`)
    }
})

test("compaction prompt compresses by recency tiers", () => {
    assert.ok(COMPACTION.includes("早期历史"))
    assert.ok(COMPACTION.includes("中部历史"))
    assert.ok(COMPACTION.includes("高度压缩"))
    assert.ok(COMPACTION.includes("最近历史"))
    assert.ok(COMPACTION.includes("轻度压缩"))
    assert.match(COMPACTION, /最近历史轻度压缩[^；]*当前任务/)
})

test("compacting hook replaces the prompt when none is set", async () => {
    const prompts = buildPromptStore()
    const handler = createSessionCompactingHandler(prompts, new Logger(false))

    const output = { context: [] as string[], prompt: undefined as string | undefined }
    await handler({ sessionID: "ses_1" }, output)

    assert.equal(typeof output.prompt, "string")
    assert.ok((output.prompt ?? "").length > 0)
    assert.equal(output.prompt, prompts.getRuntimePrompts().compaction)
    assert.deepEqual(output.context, [])
})

test("compacting hook keeps existing context entries when replacing the prompt", async () => {
    const prompts = buildPromptStore()
    const handler = createSessionCompactingHandler(prompts, new Logger(false))

    const output = { context: ["other-plugin-context"], prompt: undefined as string | undefined }
    await handler({ sessionID: "ses_1" }, output)

    assert.deepEqual(output.context, ["other-plugin-context"])
})

test("compacting hook never overwrites a prompt set by another plugin", async () => {
    const prompts = buildPromptStore()
    const handler = createSessionCompactingHandler(prompts, new Logger(false))

    const output = {
        context: ["other-plugin-context"],
        prompt: "another plugin already replaced the compaction prompt",
    }
    await handler({ sessionID: "ses_1" }, output)

    assert.equal(output.prompt, "another plugin already replaced the compaction prompt")
    assert.ok(output.context.includes("other-plugin-context"))
    assert.ok(output.context.includes(prompts.getRuntimePrompts().compaction))
    assert.equal(output.context.length, 2)
})

test("compacting hook does not throw for any session", async () => {
    const prompts = buildPromptStore()
    const handler = createSessionCompactingHandler(prompts, new Logger(false))

    await handler({ sessionID: "" }, { context: [], prompt: undefined })
})
