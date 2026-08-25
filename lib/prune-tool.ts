import { tool } from "@opencode-ai/plugin"
import type { Logger } from "./logger"
import type { OpenCodeClient } from "./opencode-client"
import { resolveSessionModel } from "./session-model"
import type { SummarizeCoordinator } from "./summarize"

export const PRUNE_TOOL_NAME = "dcp_prune"

const PRUNE_TOOL_DESCRIPTION = `立即对当前会话执行语义上下文压缩：把旧对话前缀折叠为一个滚动检查点（保留系统级规则、压缩中部历史、详述进行中的任务），近期尾部不受影响。

满足任一启发式条件时，必须立即调用本工具：
- 对话话题发生明显变更：开始处理新的问题域、切换到另一个模块/仓库/任务；
- 当前任务刚收尾完成，即将开启下一项工作；
- 对话轮数或上下文明显变长，早期细节已不需要逐字保留。

调用是安全的：并发请求会自动合并，失败不会破坏现有上下文。不要为同一话题反复连续调用。`

export interface PruneToolDeps {
    client: OpenCodeClient
    summarize: SummarizeCoordinator
    logger: Logger
}

export function createPruneTool(deps: PruneToolDeps) {
    return tool({
        description: PRUNE_TOOL_DESCRIPTION,
        args: {},
        execute: async (_args, context) => {
            const sessionID = context.sessionID
            const model = await resolveSessionModel(deps.client, sessionID)
            if (!model) {
                return "DCP：会话中还没有可用的模型信息，无法执行压缩。"
            }

            const result = await deps.summarize.summarize({ sessionID, model })
            if (result.status === "succeeded") {
                deps.logger.debug("Prune tool triggered native compaction", {
                    sessionId: sessionID,
                })
                return "DCP：语义压缩完成，旧上下文已折叠为新检查点。"
            }
            if (result.status === "cooldown") {
                return `DCP：上一次压缩失败，${Math.ceil(result.retryAfterMs / 1000)} 秒后才能重试。`
            }
            return `DCP：压缩失败（${result.error}），原始上下文保持不变。`
        },
    })
}
