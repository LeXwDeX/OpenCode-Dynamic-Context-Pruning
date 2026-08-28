import type { AutoPruneConfig } from "./config"

export type PruneSignal = "topic-drift" | "volume" | "idle-gap"

export interface ObserveResult {
    signals: PruneSignal[]
}

interface SessionState {
    window: string[]
    count: number
    lastAt: number
    pendingSignals: PruneSignal[]
    lastTriggerAt: number
}

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

const WINDOW_SIZE = 4
const DRIFT_BASELINE = 3
// Short messages ("继续", "ok") share almost no tokens with any previous turn,
// so comparing them against the window would fake a topic change. Drift is
// only evaluated for messages substantial enough to describe a topic.
const MIN_DRIFT_TOKENS = 6

function extractText(parts: unknown[]): string {
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

export class AutoPruner {
    private readonly sessions = new Map<string, SessionState>()
    private readonly now: () => number

    constructor(
        private readonly config: AutoPruneConfig,
        now?: () => number,
    ) {
        this.now = now ?? Date.now
    }

    observeUserMessage(sessionID: string, parts: unknown[], at = this.now()): ObserveResult {
        const state = this.state(sessionID)
        const text = extractText(parts)

        const signals = this.evaluate(state, text, at)

        if (text) {
            state.window.push(text)
            if (state.window.length > WINDOW_SIZE) state.window.shift()
        }
        state.count += 1
        state.lastAt = at

        for (const signal of signals) {
            if (!state.pendingSignals.includes(signal)) state.pendingSignals.push(signal)
        }

        return { signals }
    }

    consumePending(sessionID: string, at = this.now()): PruneSignal[] | null {
        const state = this.sessions.get(sessionID)
        if (!state || state.pendingSignals.length === 0) return null
        const signals = [...state.pendingSignals]
        state.pendingSignals = []
        if (at - state.lastTriggerAt < this.config.cooldownMs) return null
        state.lastTriggerAt = at
        return signals
    }

    markPruned(sessionID: string, at = this.now()): void {
        const state = this.sessions.get(sessionID)
        if (!state) return
        state.count = 0
        state.window = []
        state.pendingSignals = []
        state.lastTriggerAt = at
    }

    dropSession(sessionID: string): void {
        this.sessions.delete(sessionID)
    }

    private evaluate(state: SessionState, text: string, at: number): PruneSignal[] {
        if (state.count + 1 < this.config.minMessages) return []

        const signals: PruneSignal[] = []

        if (state.count > 0 && at - state.lastAt >= this.config.idleGapMs) {
            signals.push("idle-gap")
        }

        if (state.count >= DRIFT_BASELINE && text) {
            const current = tokenize(text)
            if (current.size >= MIN_DRIFT_TOKENS) {
                let max = 0
                for (
                    let index = Math.max(0, state.window.length - DRIFT_BASELINE);
                    index < state.window.length;
                    index++
                ) {
                    max = Math.max(max, jaccard(current, tokenize(state.window[index])))
                }
                if (max < this.config.driftThreshold) signals.push("topic-drift")
            }
        }

        if (state.count + 1 >= this.config.volumeThreshold) signals.push("volume")

        return signals
    }

    private state(sessionID: string): SessionState {
        let state = this.sessions.get(sessionID)
        if (!state) {
            state = { window: [], count: 0, lastAt: 0, pendingSignals: [], lastTriggerAt: 0 }
            this.sessions.set(sessionID, state)
            if (this.sessions.size > 200) {
                const oldest = this.sessions.keys().next().value
                if (oldest !== undefined && oldest !== sessionID) this.sessions.delete(oldest)
            }
        }
        return state
    }
}
