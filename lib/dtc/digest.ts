import { estimateTokens, firstLine, hashString, tokenize, jaccard } from "../text"
import type { MessageLike, PartLike, Turn } from "./types"

/**
 * Mechanical turn digests for the distant zone. Deterministic string
 * extraction — no model calls, no persisted state — so the same turn always
 * folds to the same line and the result is safe to cache in memory.
 */

const INTENT_MAX = 120
const RESULT_MAX = 160
const MAX_TOOLS = 8
const MAX_FILES = 6
const DIGEST_MAX_CHARS = 600

const PATH_KEYS = ["filePath", "path", "file", "filename", "pattern", "directory"]

function toolSummary(parts: PartLike[]): { actions: string; files: string; errors: number } {
    const counts = new Map<string, number>()
    const files: string[] = []
    let errors = 0
    for (const part of parts) {
        if (!part || typeof part !== "object" || part.type !== "tool") continue
        const name = part.tool ?? "tool"
        counts.set(name, (counts.get(name) ?? 0) + 1)
        if (part.state?.status === "error") errors++
        const input = part.state?.input
        if (input && typeof input === "object") {
            for (const key of PATH_KEYS) {
                const value = (input as Record<string, unknown>)[key]
                if (typeof value === "string" && value && !files.includes(value)) {
                    files.push(value)
                }
            }
            const command = (input as Record<string, unknown>).command
            if (typeof command === "string" && command && !files.includes(firstLine(command, 60))) {
                files.push(firstLine(command, 60))
            }
        }
    }
    const actions = [...counts.entries()]
        .map(([name, count]) => (count > 1 ? `${name}×${count}` : name))
        .slice(0, MAX_TOOLS)
        .join(", ")
    return { actions, files: files.slice(0, MAX_FILES).join(" "), errors }
}

/** Builds the one-block digest that replaces a distant turn's content. */
export function digestTurn(messages: MessageLike[], turn: Turn, index: number): string {
    const slice = messages.slice(turn.start, turn.end)
    const user = slice[0]
    const intent = firstLine(userText(user), INTENT_MAX) || "(无文本)"
    const { actions, files, errors } = toolSummary(
        slice.flatMap((m) => (m && typeof m === "object" ? (m.parts ?? []) : [])),
    )
    let result = ""
    for (let i = slice.length - 1; i >= 0; i--) {
        if (slice[i]?.info?.role !== "assistant") continue
        const text = assistantText(slice[i])
        if (text) {
            result = firstLine(text, RESULT_MAX)
            break
        }
    }
    const parts = [`[DCP·轮${index}]`, `意图: ${intent}`]
    if (actions) parts.push(`动作: ${actions}`)
    if (files) parts.push(`涉及: ${files}`)
    if (result) parts.push(`结果: ${result}`)
    if (errors > 0) parts.push(`错误×${errors}`)
    const digest = parts.join(" | ")
    return digest.length > DIGEST_MAX_CHARS ? `${digest.slice(0, DIGEST_MAX_CHARS)}…` : digest
}

function userText(message: MessageLike | undefined): string {
    const parts = message?.parts ?? []
    const texts = parts
        .filter((p) => p?.type === "text" && typeof p.text === "string")
        .map((p) => p.text as string)
    return texts.join(" ").trim()
}

function assistantText(message: MessageLike | undefined): string {
    return userText(message)
}

/** Stable cache key: identity of the opening message + shape of the content. */
export function digestKey(messages: MessageLike[], turn: Turn): string {
    const first = messages[turn.start]
    const id = first?.info?.id ?? "noid"
    let shape = ""
    for (let i = turn.start; i < turn.end && i < messages.length; i++) {
        const message = messages[i]
        shape += `${message?.info?.role ?? "?"}:${(message?.parts ?? []).length};`
        for (const part of message?.parts ?? []) {
            if (!part || typeof part !== "object") continue
            if (part.type === "text" && typeof part.text === "string") {
                shape += part.text.slice(0, 64)
            } else if (part.type === "tool") {
                shape += `${part.tool ?? "tool"}:${part.state?.status ?? "?"}:${(part.state?.output ?? "").length}`
            }
        }
    }
    return `${id}:${hashString(shape)}`
}

/**
 * Stateless topic-boundary scanner over the head region: a boundary is a
 * substantial user message whose similarity to its predecessor drops below
 * the drift threshold. Returns turn positions (indices into `turns`).
 */
export function findTopicBoundaries(
    messages: MessageLike[],
    turns: Turn[],
    driftThreshold: number,
): number[] {
    const boundaries: number[] = []
    let previous: Set<string> | undefined
    for (let t = 0; t < turns.length; t++) {
        const text = userText(messages[turns[t]!.start])
        const tokens = tokenize(text)
        // Short messages ("继续", "ok") share almost no tokens with anything
        // and would fake a topic change; only substantial texts count.
        if (tokens.size < 6) continue
        if (previous && jaccard(tokens, previous) < driftThreshold) boundaries.push(t)
        previous = tokens
    }
    return boundaries
}

/** Token estimate of a message slice, summing every string payload. Parts
 * folded with the host's compacted marker count as the short placeholder the
 * host serializer will actually emit, not the stored output. */
export function estimateSlice(messages: MessageLike[], start: number, end: number): number {
    let tokens = 0
    for (let i = start; i < end && i < messages.length; i++) {
        for (const part of messages[i]?.parts ?? []) {
            if (!part || typeof part !== "object") continue
            if (typeof part.text === "string") tokens += estimateTokens(part.text)
            const state = part.state
            if (!state) continue
            if (state.time?.compacted) {
                tokens += 8
                continue
            }
            if (typeof state.output === "string") tokens += estimateTokens(state.output)
            if (state.input) tokens += estimateTokens(JSON.stringify(state.input))
            if (typeof state.error === "string") tokens += estimateTokens(state.error)
        }
    }
    return tokens
}
