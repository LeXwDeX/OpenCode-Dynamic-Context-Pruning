import assert from "node:assert/strict"
import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import test from "node:test"
import { createSessionCompactingHandler } from "../lib/hooks"
import { COMPACTION, COMPACTION_EN, getCompactionPrompt } from "../lib/prompts/compaction"
import { PromptStore } from "../lib/prompts/store"
import { Logger } from "../lib/logger"
import { DtcState } from "../lib/dtc/state"

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

test("compaction prompt uses the four-section checkpoint structure", () => {
    assert.ok(COMPACTION.includes("## 历史概要"))
    assert.ok(COMPACTION.includes("## 已完成任务的概括"))
    assert.ok(COMPACTION.includes("## 进行中任务详情"))
    assert.ok(COMPACTION.includes("## 未解决问题"))
})

test("compaction prompt never duplicates system-level content", () => {
    // Native compaction only sees serialized session messages; OpenCode injects
    // AGENTS.md etc. into the system prompt on every request. Restating them in
    // the checkpoint would duplicate context every compaction.
    assert.ok(!COMPACTION.includes("## 系统上下文"))
    assert.ok(!COMPACTION.includes("原样保留"))
    assert.match(COMPACTION, /AGENTS\.md[^。]*每次请求时独立注入/)
})

test("compaction prompt keeps in-progress task details continuation-ready", () => {
    for (const keyword of ["目标", "已完成步骤", "文件路径", "关键决策", "阻塞", "下一步"]) {
        assert.ok(COMPACTION.includes(keyword), `prompt must mention ${keyword}`)
    }
})

test("compaction prompt compresses by recency tiers", () => {
    assert.ok(COMPACTION.includes("早期"))
    assert.ok(COMPACTION.includes("中部历史"))
    assert.ok(COMPACTION.includes("重度压缩"))
    assert.ok(COMPACTION.includes("轻度压缩"))
    assert.match(COMPACTION, /近距离内容[^：]*轻度压缩/)
    assert.match(COMPACTION, /远距离内容[^：]*重度压缩/)
})

test("compaction prompt bounds recent history to content since the previous checkpoint", () => {
    assert.ok(COMPACTION.includes("自上一份检查点以来的新内容"))
})

test("compaction prompt explains the rolling previous-checkpoint merge tag", () => {
    assert.ok(COMPACTION.includes("<previous-checkpoint>"))
    assert.ok(COMPACTION.includes("滚动合并"))
    assert.ok(COMPACTION_EN.includes("<previous-checkpoint>"))
    assert.ok(COMPACTION_EN.includes("Rolling merge"))
})

test("compaction prompt defers the retained tail to the host and forbids restating it", () => {
    assert.match(COMPACTION, /检查点之后直接保留最近若干轮完整对话/)
    assert.match(COMPACTION, /不要复述、总结或改写/)
})

test("compaction prompt keeps unresolved issues free of in-progress overlap", () => {
    const section = COMPACTION.split("## 未解决问题")[1] ?? ""
    assert.ok(
        section.includes("进行中任务详情"),
        "unresolved issues must reference the in-progress section",
    )
    assert.ok(section.includes("避免"))
})

test("english compaction prompt mirrors the checkpoint structure and semantics", () => {
    for (const heading of [
        "## History Overview",
        "## Completed Task Summaries",
        "## In-Progress Task Details",
    ]) {
        assert.ok(COMPACTION_EN.includes(heading), `EN prompt must contain ${heading}`)
    }
    assert.ok(!COMPACTION_EN.includes("## System Context"))
    assert.ok(COMPACTION_EN.includes("AGENTS.md"))
    assert.ok(COMPACTION_EN.includes("injected independently by OpenCode on every request"))
    assert.ok(COMPACTION_EN.includes("since the previous checkpoint"))
    const unresolved = COMPACTION_EN.split("## Unresolved Issues")[1] ?? ""
    assert.ok(unresolved.includes("In-Progress Task Details"))
})

test("getCompactionPrompt falls back to Chinese for unknown languages", () => {
    assert.equal(getCompactionPrompt(), COMPACTION)
    assert.equal(getCompactionPrompt("zh"), COMPACTION)
    assert.equal(getCompactionPrompt("fr"), COMPACTION)
    assert.equal(getCompactionPrompt("en"), COMPACTION_EN)
})

test("PromptStore serves the configured language variant", () => {
    const dir = mkdtempSync(join(tmpdir(), "dcp-prompts-lang-"))
    const en = new PromptStore(new Logger(false), dir, false, "en")
    assert.equal(en.getRuntimePrompts().compaction, COMPACTION_EN)
    const zh = new PromptStore(new Logger(false), dir, false, undefined)
    assert.equal(zh.getRuntimePrompts().compaction, COMPACTION)
})

function buildClient(messages: unknown[] = []) {
    return { session: { messages: async () => ({ data: messages }) } } as any
}

function buildHandler(messages: unknown[] = []) {
    const prompts = buildPromptStore()
    const state = new DtcState()
    return {
        prompts,
        state,
        handler: createSessionCompactingHandler({
            prompts,
            logger: new Logger(false),
            client: buildClient(messages),
            state,
        }),
    }
}

test("compacting hook replaces the prompt when none is set", async () => {
    const { prompts, handler } = buildHandler()
    const output = { context: [] as string[], prompt: undefined as string | undefined }
    await handler({ sessionID: "ses_1" }, output)

    assert.equal(typeof output.prompt, "string")
    assert.ok((output.prompt ?? "").length > 0)
    assert.equal(output.prompt, prompts.getRuntimePrompts().compaction)
    assert.deepEqual(output.context, [])
})

test("compacting hook keeps existing context entries when replacing the prompt", async () => {
    const { handler } = buildHandler()
    const output = { context: ["other-plugin-context"], prompt: undefined as string | undefined }
    await handler({ sessionID: "ses_1" }, output)

    assert.deepEqual(output.context, ["other-plugin-context"])
})

test("compacting hook never overwrites a prompt set by another plugin", async () => {
    const { prompts, handler } = buildHandler()
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
    const { handler } = buildHandler()
    await handler({ sessionID: "" }, { context: [], prompt: undefined })
})

test("compacting hook appends the previous checkpoint inside the merge tag", async () => {
    const checkpoint = {
        info: { role: "assistant", summary: true },
        parts: [{ type: "text", text: "## 历史概要\n旧检查点正文" }],
    }
    const { prompts, handler } = buildHandler([checkpoint])

    const output = { context: [] as string[], prompt: undefined as string | undefined }
    await handler({ sessionID: "ses_1" }, output)

    assert.equal(
        output.prompt,
        `${prompts.getRuntimePrompts().compaction}\n\n<previous-checkpoint>\n## 历史概要\n旧检查点正文\n</previous-checkpoint>`,
    )
})

test("compacting hook uses the latest checkpoint and skips non-checkpoint messages", async () => {
    const messages = [
        {
            info: { role: "assistant", summary: true },
            parts: [{ type: "text", text: "第一份检查点" }],
        },
        { info: { role: "user" }, parts: [{ type: "text", text: "继续" }] },
        {
            info: { role: "assistant", summary: false },
            parts: [{ type: "text", text: "普通回复" }],
        },
        {
            info: { role: "assistant", summary: true },
            parts: [{ type: "text", text: "第二份检查点" }],
        },
    ]
    const { handler } = buildHandler(messages)

    const output = { context: [] as string[], prompt: undefined as string | undefined }
    await handler({ sessionID: "ses_1" }, output)

    assert.match(
        output.prompt ?? "",
        /<previous-checkpoint>\n第二份检查点\n<\/previous-checkpoint>/,
    )
})

test("compacting hook omits the block when no previous checkpoint exists", async () => {
    const messages = [
        { info: { role: "assistant", summary: true }, parts: [{ type: "text", text: "  " }] },
    ]
    const { prompts, handler } = buildHandler(messages)

    const output = { context: [] as string[], prompt: undefined as string | undefined }
    await handler({ sessionID: "ses_1" }, output)

    assert.equal(output.prompt, prompts.getRuntimePrompts().compaction)
})

test("compacting hook fails open when message fetching throws", async () => {
    const prompts = buildPromptStore()
    const client = {
        session: {
            messages: async () => {
                throw new Error("boom")
            },
        },
    } as any
    const state = new DtcState()
    const handler = createSessionCompactingHandler({
        prompts,
        logger: new Logger(false),
        client,
        state,
    })

    const output = { context: [] as string[], prompt: undefined as string | undefined }
    await handler({ sessionID: "ses_1" }, output)

    assert.equal(output.prompt, prompts.getRuntimePrompts().compaction)
})

test("compacting hook arms the one-shot DTC skip for the summarizer input", async () => {
    const { state, handler } = buildHandler()
    const output = { context: [] as string[], prompt: undefined as string | undefined }
    await handler({ sessionID: "ses_arm" }, output)
    assert.equal(state.consumeCompactionSkip("ses_arm"), true)
    assert.equal(state.consumeCompactionSkip("ses_arm"), false, "skip is one-shot")
})
