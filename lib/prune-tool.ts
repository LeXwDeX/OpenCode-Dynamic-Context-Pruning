import { tool } from "@opencode-ai/plugin"
import type { Logger } from "./logger"
import type { DtcState } from "./dtc/state"

export const PRUNE_TOOL_NAME = "dcp_prune"

const PRUNE_TOOL_DESCRIPTION = `标记话题边界并加深本会话的动态上下文折叠。压缩本身由 DCP 在每次模型请求时自动分级完成（远距离重度折叠、当前任务轻度折叠、最近数轮原样保留），本工具只调整折叠策略，不执行任何会话操作。

仅在这些情况下调用：
- 对话话题发生明显变更：开始处理新的问题域、切换到另一个模块/仓库/任务；
- 用户明确要求压缩上下文。

同一任务内的多轮追问、参数微调、延续当前工作，都不要调用。调用瞬时完成，绝不打断当前工作：旧任务内容从下一次模型请求起被折叠为结构化摘要，最近对话与当前任务细节不受影响。不要为同一话题反复调用。`

export interface PruneToolDeps {
    state: DtcState
    logger: Logger
    now?: () => number
}

export function createPruneTool(deps: PruneToolDeps) {
    return tool({
        description: PRUNE_TOOL_DESCRIPTION,
        args: {},
        execute: async (_args, context) => {
            const sessionID = context.sessionID
            const now = (deps.now ?? Date.now)()
            deps.state.markBoundary(sessionID, now, 2)
            deps.logger.debug("Prune tool marked a topic boundary", {
                sessionId: sessionID,
            })
            return "DCP：已标记话题边界并加深本会话折叠——旧任务内容将从下一次模型请求起分级折叠为结构化摘要；最近对话与当前任务细节不受影响，会话未中断。"
        },
    })
}
