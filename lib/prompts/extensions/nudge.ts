import type { PluginConfig } from "../../config"
import type { SessionState, WithParts } from "../../state"
import { isIgnoredUserMessage, isProtectedUserMessage } from "../../messages/query"
import { isMessageCompacted } from "../../state/utils"

export function buildCompressedBlockGuidance(state: SessionState): string {
    const refs = Array.from(state.prune.messages.activeBlockIds)
        .filter((id) => Number.isInteger(id) && id > 0)
        .sort((a, b) => a - b)
        .map((id) => `b${id}`)
    const blockCount = refs.length
    const blockList = blockCount > 0 ? refs.join(", ") : "无"

    return [
        "压缩块上下文：",
        `- 此会话中的活跃压缩块：${blockCount} 个（${blockList}）`,
        "- 如果你选择的压缩范围包含任何列出的块，在摘要中使用 `(bN)` 恰好包含每个必需的占位符一次。",
    ].join("\n")
}

export function buildAvailableMessageIdGuidance(
    state: SessionState,
    config: PluginConfig,
    messages: WithParts[],
): string {
    const visibleIds = new Set(
        messages
            .filter(
                (msg) =>
                    !isIgnoredUserMessage(msg) &&
                    !isMessageCompacted(state, msg) &&
                    !isProtectedUserMessage(config, msg),
            )
            .map((msg) => msg.info.id),
    )

    const refs = []
    for (const [ref, rawId] of state.messageIds.byRef) {
        if (visibleIds.has(rawId)) {
            refs.push(ref)
        }
    }

    refs.sort((a, b) => {
        const numA = Number.parseInt(a.slice(1), 10)
        const numB = Number.parseInt(b.slice(1), 10)
        return numA - numB
    })

    if (refs.length === 0) {
        return ""
    }

    const refList =
        refs.length <= 15
            ? refs.join(", ")
            : `${refs[0]} 到 ${refs[refs.length - 1]}（共 ${refs.length} 个）`

    return [
        "可用消息边界 ID：",
        `- 当前上下文中可作为 compress 边界的合法消息 ID：${refList}`,
        config.compress.mode === "message"
            ? "- 只从以上列表中选取 content[].messageId。不要发明、外推或使用不在列表中的 ID。"
            : "- 只从以上列表中选取 startId 和 endId。不要发明、外推或使用不在列表中的 ID。",
    ].join("\n")
}

export function renderMessagePriorityGuidance(priorityLabel: string, refs: string[]): string {
    const refList = refs.length > 0 ? refs.join(", ") : "无"

    const normalized = priorityLabel.toLowerCase()
    const priorityLabelZh = normalized === "high" ? "高" : normalized === "medium" ? "中" : "低"

    return [
        "消息优先级上下文：",
        "- 高优先级的旧消息消耗更多上下文，如果安全的话应立即压缩。",
        `- 此点之前的${priorityLabelZh}优先级消息 ID：${refList}`,
    ].join("\n")
}

export function appendGuidanceToDcpTag(nudgeText: string, guidance: string): string {
    if (!guidance.trim()) {
        return nudgeText
    }

    const closeTag = ""
    const closeTagIndex = nudgeText.lastIndexOf(closeTag)

    if (closeTagIndex === -1) {
        return nudgeText
    }

    const beforeClose = nudgeText.slice(0, closeTagIndex).trimEnd()
    const afterClose = nudgeText.slice(closeTagIndex)
    return `${beforeClose}\n\n${guidance}\n${afterClose}`
}
