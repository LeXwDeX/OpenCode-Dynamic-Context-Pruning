import { tool } from "@opencode-ai/plugin"
import type { Logger } from "./logger"
import type { DtcState } from "./dtc/state"

export const PRUNE_TOOL_NAME = "dcp_prune"

const PRUNE_TOOL_DESCRIPTION = `请求在本会话下一次普通模型请求中折叠可安全移除的旧工具输出。仅在用户要求清理上下文，或旧工具输出已无继续保留价值时调用。标记瞬时完成，只生效一次；不修改会话历史，不运行原生压缩，不改变后续请求的长期策略。近期步骤、受保护内容和错误信息仍保留；没有可折叠内容或无法确认请求身份、模型预算时保持原样。`

export interface PruneToolDeps {
    state: DtcState
    logger: Logger
}

export function createPruneTool(deps: PruneToolDeps) {
    return tool({
        description: PRUNE_TOOL_DESCRIPTION,
        args: {},
        execute: async (_args, context) => {
            if (!context.sessionID) return "DCP：无法确认会话，本次未设置折叠请求。"
            if (!deps.state.requestFold(context.sessionID)) {
                return deps.state.projectionBlockReason()
                    ? "DCP：摘要保护状态超出容量，本实例已停止折叠；重启宿主后恢复。本次未设置折叠请求。"
                    : "DCP：摘要保护状态已占满容量，本次未设置折叠请求。"
            }
            return "DCP：已请求下一次普通模型请求折叠符合保护规则的旧工具输出，仅生效一次；没有可折叠内容或预算未知时保持原样。会话历史未修改。"
        },
    })
}
