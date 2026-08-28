import { tool } from "@opencode-ai/plugin"
import type { Logger } from "./logger"
import type { PruneService } from "./prune-service"
import { retrySeconds } from "./prune-service"

export const PRUNE_TOOL_NAME = "dcp_prune"

const PRUNE_TOOL_DESCRIPTION = `把当前会话的旧对话前缀折叠为一个滚动检查点（保留系统级规则、压缩中部历史、详述进行中的任务），近期尾部不受影响。

仅在这些情况下调用：
- 对话话题发生明显变更：开始处理新的问题域、切换到另一个模块/仓库/任务；
- 用户明确要求压缩上下文。

同一任务内的多轮追问、参数微调、延续当前工作，都不要调用。调用不会打断当前工作：压缩会排队，并在下一个空闲边界尝试执行；并发请求自动合并，失败不会破坏现有上下文。不要为同一话题反复调用。`

export interface PruneToolDeps {
    prune: PruneService
    logger: Logger
}

export function createPruneTool(deps: PruneToolDeps) {
    return tool({
        description: PRUNE_TOOL_DESCRIPTION,
        args: {},
        execute: async (_args, context) => {
            const sessionID = context.sessionID
            const result = await deps.prune.request({ sessionID, onBusy: "defer" })

            if (result.status === "succeeded") {
                deps.logger.debug("Prune tool triggered native compaction", {
                    sessionId: sessionID,
                })
                return "DCP：语义压缩完成，旧上下文已折叠为新检查点。"
            }
            if (result.status === "deferred") {
                return "DCP：会话仍在工作中，压缩已排队，将在下一个空闲边界尝试自动执行；当前上下文不受影响。"
            }
            if (result.status === "busy") {
                return "DCP：会话正忙，为避免打断当前工作，本次未执行压缩。"
            }
            if (result.status === "cooldown") {
                return `DCP：上一次压缩失败，${retrySeconds(result.retryAfterMs)} 秒后才能重试。`
            }
            if (result.status === "no-model") {
                return "DCP：会话中还没有可用的模型信息，无法执行压缩。"
            }
            return `DCP：压缩失败（${result.error}），原始上下文保持不变。`
        },
    })
}
