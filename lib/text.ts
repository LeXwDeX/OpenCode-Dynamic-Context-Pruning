/** Deterministic payload estimate, not a provider tokenizer. Request-level
 * reserves and unknown-media handling belong to the projection/host adapter. */
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
