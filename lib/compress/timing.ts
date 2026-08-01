import type { SessionState } from "../state/types"
import { attachCompressionDuration } from "./state"

export interface PendingCompressionDuration {
    messageId: string
    callId: string
    durationMs: number
}

export interface CompressionTimingState {
    startsByCallId: Map<string, number>
    pendingByCallId: Map<string, PendingCompressionDuration>
    recordedAtByCallId: Map<string, number>
}

const MAX_TIMING_ENTRIES = 2048
const TIMING_TTL_MS = 30 * 60 * 1000

export function buildCompressionTimingKey(messageId: string, callId: string): string {
    return `${messageId}:${callId}`
}

export function consumeCompressionStart(
    state: SessionState,
    messageId: string,
    callId: string,
): number | undefined {
    const key = buildCompressionTimingKey(messageId, callId)
    const start = state.compressionTiming.startsByCallId.get(key)
    state.compressionTiming.startsByCallId.delete(key)
    state.compressionTiming.recordedAtByCallId.delete(key)
    return start
}

export function pruneCompressionTiming(state: SessionState, now = Date.now()): void {
    const timing = state.compressionTiming
    const cutoff = now - TIMING_TTL_MS
    for (const [key, recordedAt] of timing.recordedAtByCallId) {
        if (recordedAt >= cutoff) continue
        timing.recordedAtByCallId.delete(key)
        timing.startsByCallId.delete(key)
        timing.pendingByCallId.delete(key)
    }

    while (timing.recordedAtByCallId.size > MAX_TIMING_ENTRIES) {
        const oldest = timing.recordedAtByCallId.keys().next().value
        if (typeof oldest !== "string") break
        timing.recordedAtByCallId.delete(oldest)
        timing.startsByCallId.delete(oldest)
        timing.pendingByCallId.delete(oldest)
    }
}

export function resolveCompressionDuration(
    startedAt: number | undefined,
    eventTime: number | undefined,
    partTime: { start?: unknown; end?: unknown } | undefined,
): number | undefined {
    const runningAt =
        typeof partTime?.start === "number" && Number.isFinite(partTime.start)
            ? partTime.start
            : eventTime
    const pendingToRunningMs =
        typeof startedAt === "number" && typeof runningAt === "number"
            ? Math.max(0, runningAt - startedAt)
            : undefined

    const toolStart = partTime?.start
    const toolEnd = partTime?.end
    const runtimeMs =
        typeof toolStart === "number" &&
        Number.isFinite(toolStart) &&
        typeof toolEnd === "number" &&
        Number.isFinite(toolEnd)
            ? Math.max(0, toolEnd - toolStart)
            : undefined

    return typeof pendingToRunningMs === "number" ? pendingToRunningMs : runtimeMs
}

export function applyPendingCompressionDurations(state: SessionState): number {
    if (state.compressionTiming.pendingByCallId.size === 0) {
        return 0
    }

    let updates = 0
    for (const [key, entry] of state.compressionTiming.pendingByCallId) {
        const applied = attachCompressionDuration(
            state.prune.messages,
            entry.messageId,
            entry.callId,
            entry.durationMs,
        )
        if (applied > 0) {
            updates += applied
            state.compressionTiming.pendingByCallId.delete(key)
            state.compressionTiming.recordedAtByCallId.delete(key)
        }
    }

    return updates
}
