export const COMPACTION = `你正在生成当前会话唯一的滚动检查点。输出将替代旧对话前缀，成为后续模型看到的第一段上下文；OpenCode 会在它后面保留尚未压缩的近期尾部。系统级内容（AGENTS.md、项目规则等）由 OpenCode 在每次请求时独立注入，不属于压缩范围，不要复述它们。

这不是聊天记录摘要，而是可直接继续工作的语义剪枝结果。按以下规则压缩：

1. 如果输入含有上一份检查点，把仍有效的信息合并进新检查点；不要嵌套、引用或重复旧检查点。
2. 删除无关闲聊、其他项目或其他仓库的对话、重复解释、已经推翻且不再有诊断价值的方案。
3. 多次工具调用试错或失败后成功时，只保留最终成功结果；仅当根因会影响后续工作时保留一次简短失败原因。
4. 同一内容或文件被重复编辑时，只保留最终状态、仍有效的关键决策和必要理由，不复述每轮修改。
5. 按时间分层决定压缩深度：早期历史和中部历史高度压缩——每个主题只留一句话结论，不留过程；最近历史轻度压缩——尤其是与当前任务相关的内容，保留继续工作所需的关键细节（文件路径、接口、命令、测试结果、错误事实、仍有效的决策及理由），只折叠重复与已失效的内容。最近历史指自上一份检查点以来的新内容。

使用以下固定结构，省略确实为空的条目：

## 历史概要
早期与中部历史的主题和背景，每项一句话结论；远期已完成任务归入此处，不含执行过程。

## 已完成任务的概括
最近的已完成任务，每个任务一句话概括其结果与关键产出。

## 进行中任务详情
当前正在进行的任务逐项写清：目标、已完成步骤、涉及文件路径与接口、关键决策、遇到的阻塞、下一步具体动作。本节属于轻度压缩区，宁可多保留细节，不做二次推断。

## 未解决问题
跨任务的遗留风险和待确认事项。只写未在「进行中任务详情」中出现的内容，避免与该节重复。

保持具体、可验证和项目内聚。进行中的任务必须能凭检查点直接继续，不要依赖已被压缩掉的中间过程。保留文件路径、接口、命令、测试结果和错误事实等硬事实，但不要保留消息 ID、块 ID、锚点、占位符、控制标签或过程性聊天。`

export const COMPACTION_EN = `You are generating the single rolling checkpoint for this session. Your output will replace the old conversation prefix as the first context the model sees afterwards; OpenCode keeps an uncompacted recent tail right after it. System-level content (AGENTS.md, project rules, etc.) is injected independently by OpenCode on every request and is not part of compaction; do not restate it.

This is not a chat-log summary but a semantic pruning result one can resume working from directly. Compress by these rules:

1. If the input contains a previous checkpoint, merge the still-valid information into the new checkpoint; do not nest, quote, or duplicate the old one.
2. Remove irrelevant chitchat, conversations about other projects or repositories, repeated explanations, and approaches that were overturned and no longer carry diagnostic value.
3. When repeated tool trial-and-error ends in success, keep only the final successful outcome; retain one brief failure reason only if the root cause affects future work.
4. When the same content or file was edited repeatedly, keep only the final state, the still-valid key decisions, and the necessary rationale; do not restate each round of edits.
5. Choose compression depth by recency tiers: early and middle history are compressed heavily—one concluding sentence per topic, no process detail; recent history is compressed lightly—especially content related to the current task, keeping the key details needed to continue (file paths, interfaces, commands, test results, error facts, still-valid decisions and their rationale), folding only duplicates and invalidated content. Recent history means everything generated since the previous checkpoint.

Use the following fixed structure, omitting sections that are truly empty:

## History Overview
Topics and background from early and middle history, one concluding sentence each; long-completed tasks belong here, without execution process.

## Completed Task Summaries
Recently completed tasks, one sentence per task covering its outcome and key outputs.

## In-Progress Task Details
For the current task, itemize: goal, completed steps, file paths and interfaces involved, key decisions, blockers encountered, concrete next actions. This is the lightly-compressed zone; prefer keeping more detail and avoid second-order inference.

## Unresolved Issues
Cross-task lingering risks and items awaiting confirmation. Only list items not already covered under In-Progress Task Details, to avoid duplication.

Stay specific, verifiable, and project-cohesive. An in-progress task must be resumable straight from this checkpoint, without relying on intermediate process that was pruned away. Keep hard facts such as file paths, interfaces, commands, test results, and error facts, but never message IDs, block IDs, anchors, placeholders, control tags, or procedural chatter.`

export function getCompactionPrompt(language?: string): string {
    return language === "en" ? COMPACTION_EN : COMPACTION
}
