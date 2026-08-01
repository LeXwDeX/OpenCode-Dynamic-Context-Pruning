import type { WithParts } from "../state"
export { runWithConcurrency } from "../concurrency"

const MAX_PART_CHARS = 100_000
const MAX_TOTAL_CHARS = 1_000_000
const TRUNCATED_MARKER = "\n[内容因长度限制被截断]"

function stringify(value: unknown): string {
    if (typeof value === "string") return value
    try {
        return JSON.stringify(value, null, 2) ?? String(value)
    } catch {
        return String(value)
    }
}

function truncate(value: string, limit = MAX_PART_CHARS): string {
    if (value.length <= limit) return value
    return value.slice(0, limit) + TRUNCATED_MARKER
}

function serializePart(part: WithParts["parts"][number]): string[] {
    if (part.type === "text" && typeof part.text === "string") {
        return [truncate(part.text)]
    }
    if (part.type !== "tool") return []

    const chunks = [`[工具：${part.tool}；状态：${part.state.status}]`]
    if (part.state.input !== undefined) {
        chunks.push("输入：\n" + truncate(stringify(part.state.input)))
    }
    if (part.state.status === "completed" && part.state.output !== undefined) {
        chunks.push("输出：\n" + truncate(stringify(part.state.output)))
    } else if (part.state.status === "error" && part.state.error !== undefined) {
        chunks.push("错误：\n" + truncate(stringify(part.state.error)))
    }
    return chunks
}

export function serializeMessagesForExternalSummary(messages: WithParts[]): string {
    const chunks: string[] = []
    let length = 0

    for (const message of messages) {
        const header = `[消息：${message.info.id}；角色：${message.info.role}]`
        const content = [header, ...message.parts.flatMap(serializePart)].join("\n")
        if (length + content.length > MAX_TOTAL_CHARS) {
            const remaining = Math.max(0, MAX_TOTAL_CHARS - length)
            if (remaining > 0) chunks.push(content.slice(0, remaining))
            chunks.push(TRUNCATED_MARKER.trim())
            break
        }
        chunks.push(content)
        length += content.length
    }

    return chunks.join("\n\n")
}
