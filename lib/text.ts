/**
 * Shared text utilities for the dynamic tiered compression engine and the
 * topic-boundary scanner. Pure functions only — everything here must stay
 * deterministic so folded output and digests are stable across requests.
 */

export function tokenize(text: string): Set<string> {
    const tokens = new Set<string>()
    for (const match of text.toLowerCase().matchAll(/[\p{L}\p{N}]+/gu)) {
        const word = match[0]
        if (/[\u4e00-\u9fff]/.test(word)) {
            if (word.length === 1) {
                tokens.add(word)
                continue
            }
            for (let index = 0; index < word.length - 1; index++) {
                tokens.add(word.slice(index, index + 2))
            }
        } else {
            tokens.add(word)
        }
    }
    return tokens
}

export function jaccard(a: Set<string>, b: Set<string>): number {
    if (a.size === 0 && b.size === 0) return 1
    let intersection = 0
    for (const token of a) {
        if (b.has(token)) intersection++
    }
    return intersection / (a.size + b.size - intersection)
}

/**
 * Cheap deterministic token estimate: CJK characters count ~0.7 tokens each,
 * everything else ~0.25 (the standard chars/4 approximation). Precise enough
 * for budget decisions — the escalation loop re-measures after every level.
 */
export function estimateTokens(text: string): number {
    let cjk = 0
    let other = 0
    for (let index = 0; index < text.length; index++) {
        const code = text.charCodeAt(index)
        if (code >= 0x4e00 && code <= 0x9fff) cjk++
        else other++
    }
    return Math.ceil(cjk * 0.7 + other / 4)
}

/** djb2 string hash — stable digest cache keys without storing content. */
export function hashString(text: string): string {
    let hash = 5381
    for (let index = 0; index < text.length; index++) {
        hash = ((hash << 5) + hash + text.charCodeAt(index)) | 0
    }
    return (hash >>> 0).toString(36)
}

export function firstLine(text: string, maxChars: number): string {
    const line = text.split("\n", 1)[0]?.trim() ?? ""
    return line.length > maxChars ? `${line.slice(0, maxChars)}…` : line
}

export function truncateMiddle(text: string, keepChars: number, note: string): string {
    if (text.length <= keepChars) return text
    const head = Math.ceil(keepChars / 2)
    const tail = Math.floor(keepChars / 2)
    return `${text.slice(0, head)}\n${note}\n${text.slice(text.length - tail)}`
}

export function extractTextParts(parts: unknown[]): string {
    const texts: string[] = []
    for (const part of parts) {
        if (
            part &&
            typeof part === "object" &&
            (part as { type?: unknown }).type === "text" &&
            typeof (part as { text?: unknown }).text === "string"
        ) {
            texts.push((part as { text: string }).text)
        }
    }
    return texts.join(" ").trim()
}
