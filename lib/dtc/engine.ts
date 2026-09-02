import type { Logger } from "../logger"
import { firstLine, truncateMiddle } from "../text"
import { digestKey, digestTurn, estimateSlice, findTopicBoundaries } from "./digest"
import type { DtcState } from "./state"
import type { MessageLike, PartLike, Turn } from "./types"

/**
 * The dynamic tiered compression engine. Runs inside the host's
 * `experimental.chat.messages.transform` hook on every model request and
 * rewrites ONLY string payloads of the request-scoped message copies:
 *
 * - messages and parts are never added, removed, or reordered
 * - part IDs, tool-call pairing, and roles are never touched
 * - distant tool outputs are folded with the host's own `time.compacted`
 *   marker, so the wire rendering is the host's native one
 *
 * Nothing here writes to the session; the host rebuilds this array from
 * storage on every request, so all mutations are inherently request-scoped.
 */

export interface DtcConfig {
    /** Turns kept completely verbatim at the end (never folded). */
    tailTurns: number
    /** Below this fraction of the context window, no folding happens at all. */
    lowWatermarkRatio: number
    /** Folding escalates until the estimate fits this fraction. */
    targetRatio: number
    /** Jaccard similarity below which consecutive turns count as a topic change. */
    driftThreshold: number
    /** C-zone tool outputs are head+tail truncated to this many characters. */
    toolOutputKeepChars: number
}

export const DTC_DEFAULTS: DtcConfig = {
    tailTurns: 4,
    lowWatermarkRatio: 0.5,
    targetRatio: 0.7,
    driftThreshold: 0.18,
    toolOutputKeepChars: 4000,
}

/** Zone width caps in turns: the current-task zone never spans more than
 * C_ZONE_MAX_TURNS even without a topic boundary; the medium zone between
 * C and D never spans more than M_ZONE_MAX_TURNS. Code constants by design —
 * they shape the tier geometry, not user policy. */
const C_ZONE_MAX_TURNS = 8
const M_ZONE_MAX_TURNS = 12
/** M-zone text parts keep their first line, capped at this many characters. */
const M_TEXT_KEEP_CHARS = 200
/** Error text caps: middle zone keeps a short first line, distant zone less. */
const M_ERROR_KEEP_CHARS = 200
const D_ERROR_KEEP_CHARS = 100
/** Tool inputs reduce to their target identity; commands keep a short head. */
const INPUT_TARGET_KEYS = ["filePath", "path", "file", "filename", "pattern", "directory"]
const COMMAND_KEEP_CHARS = 80
/** Reasoning payloads degrade to a single space (never an empty string —
 * providers differ on empty content blocks). */
const FOLDED_TEXT = " "

export type FoldLevel = 0 | 1 | 2 | 3

export interface TransformStats {
    messages: number
    userTurns: number
    level: FoldLevel
    estimatedBefore: number
    estimatedAfter: number
    contextTokens: number
    foldedTools: number
    foldedTexts: number
    reducedInputs: number
    foldedErrors: number
    digestedTurns: number
    skipped: "short" | "unknown-context" | "compaction" | undefined
}

const NO_STATS: TransformStats = {
    messages: 0,
    userTurns: 0,
    level: 0,
    estimatedBefore: 0,
    estimatedAfter: 0,
    contextTokens: 0,
    foldedTools: 0,
    foldedTexts: 0,
    reducedInputs: 0,
    foldedErrors: 0,
    digestedTurns: 0,
    skipped: undefined,
}

export interface TransformDeps {
    state: DtcState
    config: DtcConfig
    logger?: Logger
    now?: () => number
}

/** Splits the array into turns at user messages (compaction-part users are
 * host machinery, not conversational turns — same rule as the fork's own
 * `turns()` in session/compaction.ts). */
export function segmentTurns(messages: MessageLike[]): Turn[] {
    const turns: Turn[] = []
    for (let i = 0; i < messages.length; i++) {
        const info = messages[i]?.info
        if (info?.role !== "user") continue
        if ((messages[i]?.parts ?? []).some((p) => p?.type === "compaction")) continue
        turns.push({ start: i, end: messages.length })
    }
    for (let i = 0; i < turns.length - 1; i++) {
        turns[i]!.end = turns[i + 1]!.start
    }
    return turns
}

export function transformMessages(messages: MessageLike[], deps: TransformDeps): TransformStats {
    const stats: TransformStats = { ...NO_STATS }
    if (!Array.isArray(messages) || messages.length === 0) return stats
    stats.messages = messages.length

    const sessionID = findSessionID(messages)
    if (sessionID && deps.state.consumeCompactionSkip(sessionID)) {
        stats.skipped = "compaction"
        return stats
    }

    const turns = segmentTurns(messages)
    stats.userTurns = turns.length
    const { config, state } = deps
    if (turns.length <= config.tailTurns) {
        stats.skipped = "short"
        return stats
    }

    const contextTokens = sessionID ? state.contextTokens(sessionID) : undefined
    if (!contextTokens) {
        // Fail open until `chat.params` has taught us the window size.
        stats.skipped = "unknown-context"
        return stats
    }
    stats.contextTokens = contextTokens

    const headTurns = turns.slice(0, turns.length - config.tailTurns)
    const estimatedBefore = estimateSlice(messages, 0, messages.length)
    stats.estimatedBefore = estimatedBefore

    const lowWatermark = Math.floor(contextTokens * config.lowWatermarkRatio)
    const target = Math.floor(contextTokens * config.targetRatio)
    const minLevel = sessionID ? state.minLevel(sessionID) : 0
    if (estimatedBefore <= lowWatermark && minLevel === 0) {
        stats.estimatedAfter = estimatedBefore
        return stats
    }

    const zones = computeZones(messages, headTurns, sessionID, state, config)
    const now = (deps.now ?? Date.now)()

    let level = Math.max(1, minLevel) as FoldLevel
    // Bands apply cumulatively: a manual minimum level can start at 2 or 3,
    // and every band below it must still fold — starting high never skips the
    // distant zone. Each band folds exactly once per request.
    let appliedBand = 0
    const applyUpTo = (lvl: FoldLevel): void => {
        while (appliedBand < lvl) {
            appliedBand++
            applyBand(messages, headTurns, zones, appliedBand, deps, stats, now)
        }
    }
    applyUpTo(level)
    let estimatedAfter = estimateSlice(messages, 0, messages.length)
    while (estimatedAfter > target && level < 3) {
        level = (level + 1) as FoldLevel
        applyUpTo(level)
        estimatedAfter = estimateSlice(messages, 0, messages.length)
    }

    stats.level = level
    stats.estimatedAfter = estimatedAfter
    deps.logger?.debug("DTC transform", {
        sessionId: sessionID,
        messages: stats.messages,
        userTurns: stats.userTurns,
        level,
        estimatedBefore,
        estimatedAfter,
        contextTokens,
        foldedTools: stats.foldedTools,
        reducedInputs: stats.reducedInputs,
        foldedErrors: stats.foldedErrors,
        digestedTurns: stats.digestedTurns,
    })
    return stats
}

interface Zones {
    /** Head-turn ordinals: D = [0, mStart), M = [mStart, cStart), C = [cStart, head.length). */
    mStart: number
    cStart: number
}

function computeZones(
    messages: MessageLike[],
    headTurns: Turn[],
    sessionID: string | undefined,
    state: DtcState,
    config: DtcConfig,
): Zones {
    const boundaries = findTopicBoundaries(messages, headTurns, config.driftThreshold)
    const lastBoundary = boundaries.length > 0 ? boundaries[boundaries.length - 1]! : 0
    const secondLast = boundaries.length > 1 ? boundaries[boundaries.length - 2]! : 0

    let markStart = 0
    const markAt = sessionID ? state.boundaryMark(sessionID) : undefined
    if (markAt !== undefined) {
        // The tool fired inside a turn: that turn is the LAST of the old
        // topic, so the new topic starts at the following head turn. When the
        // marked turn already sits inside the protected tail, the whole head
        // becomes foldable (C empty) — exactly the "topic changed, fold the
        // old task away" semantics.
        for (let t = 0; t < headTurns.length; t++) {
            const created = messages[headTurns[t]!.start]?.info?.time?.created
            if (typeof created === "number" && created <= markAt) markStart = t + 1
        }
    }

    const cStart = Math.min(
        headTurns.length,
        Math.max(lastBoundary, markStart, headTurns.length - C_ZONE_MAX_TURNS),
    )
    const mStart = Math.min(cStart, Math.max(secondLast, cStart - M_ZONE_MAX_TURNS))
    return { mStart, cStart }
}

function applyBand(
    messages: MessageLike[],
    headTurns: Turn[],
    zones: Zones,
    band: number,
    deps: TransformDeps,
    stats: TransformStats,
    now: number,
): void {
    if (band === 1) {
        for (let t = 0; t < zones.mStart; t++) {
            foldDistant(messages, headTurns[t]!, t + 1, deps, stats, now)
        }
    } else if (band === 2) {
        for (let t = zones.mStart; t < zones.cStart; t++) {
            foldMiddle(messages, headTurns[t]!, stats, now)
        }
    } else if (band === 3) {
        for (let t = zones.cStart; t < headTurns.length; t++) {
            foldCurrent(messages, headTurns[t]!, deps.config.toolOutputKeepChars, stats)
        }
    }
}

function foldDistant(
    messages: MessageLike[],
    turn: Turn,
    ordinal: number,
    deps: TransformDeps,
    stats: TransformStats,
    now: number,
): void {
    const key = digestKey(messages, turn)
    let digest = deps.state.cachedDigest(key)
    if (digest === undefined) {
        digest = digestTurn(messages, turn, ordinal)
        deps.state.storeDigest(key, digest)
    }
    stats.digestedTurns++

    let digestPlaced = false
    for (let i = turn.start; i < turn.end; i++) {
        const message = messages[i]
        for (const part of message?.parts ?? []) {
            if (!part || typeof part !== "object") continue
            if (part.type === "tool" && part.state?.status === "error") {
                foldErrorPart(part, D_ERROR_KEEP_CHARS, true, stats)
                continue
            }
            if (foldToolPart(part, now, "distant", stats)) {
                stats.foldedTools++
                continue
            }
            if (
                part.type === "reasoning" &&
                typeof part.text === "string" &&
                part.text.length > 0
            ) {
                part.text = FOLDED_TEXT
                continue
            }
            if (part.type === "text" && typeof part.text === "string") {
                if (!digestPlaced && message?.info?.role === "user") {
                    part.text = digest
                    digestPlaced = true
                } else {
                    part.text = FOLDED_TEXT
                }
                stats.foldedTexts++
            }
        }
    }
}

function foldMiddle(messages: MessageLike[], turn: Turn, stats: TransformStats, now: number): void {
    for (let i = turn.start; i < turn.end; i++) {
        for (const part of messages[i]?.parts ?? []) {
            if (!part || typeof part !== "object") continue
            if (part.type === "tool" && part.state?.status === "error") {
                foldErrorPart(part, M_ERROR_KEEP_CHARS, false, stats)
                continue
            }
            if (foldToolPart(part, now, "middle", stats)) {
                stats.foldedTools++
                continue
            }
            if (
                part.type === "reasoning" &&
                typeof part.text === "string" &&
                part.text.length > 0
            ) {
                part.text = FOLDED_TEXT
                continue
            }
            if (
                part.type === "text" &&
                typeof part.text === "string" &&
                part.text.length > M_TEXT_KEEP_CHARS
            ) {
                part.text = firstLine(part.text, M_TEXT_KEEP_CHARS) || FOLDED_TEXT
                stats.foldedTexts++
            }
        }
    }
}

function foldCurrent(
    messages: MessageLike[],
    turn: Turn,
    keepChars: number,
    stats: TransformStats,
): void {
    for (let i = turn.start; i < turn.end; i++) {
        for (const part of messages[i]?.parts ?? []) {
            if (!part || typeof part !== "object" || part.type !== "tool") continue
            const state = part.state
            if (!state || state.status !== "completed") continue
            const output = state.output
            if (typeof output !== "string" || output.length <= keepChars) continue
            state.output = truncateMiddle(
                output,
                keepChars,
                `[DCP 已折叠 ${output.length - keepChars} 字符]`,
            )
            stats.foldedTools++
        }
    }
}

/**
 * Reduces a tool call's arguments to their target identity: path-like keys
 * stay, `command` keeps a short first line, and content payloads
 * (oldString/newString/content/…) are dropped. Repeated or failed operations
 * on the same target collapse to a recognizable skeleton — the final state
 * lives on disk and in the current-task zone, never in stale payloads.
 */
export function reduceInput(input: Record<string, unknown> | undefined): Record<string, unknown> {
    if (!input || typeof input !== "object") return {}
    const reduced: Record<string, unknown> = {}
    for (const key of INPUT_TARGET_KEYS) {
        const value = input[key]
        if (typeof value === "string" && value) reduced[key] = value
    }
    const command = input.command
    if (typeof command === "string" && command) {
        reduced.command = firstLine(command, COMMAND_KEEP_CHARS)
    }
    return reduced
}

/**
 * Folds a completed tool part using the host's native degradation marker
 * (rendered as "[Old tool result content cleared]" by the host serializer)
 * and reduces the call arguments per zone: the distant zone clears them
 * entirely (the digest carries paths/commands), the middle zone keeps the
 * target skeleton. Returns true when folded.
 */
function foldToolPart(
    part: PartLike,
    now: number,
    zone: "distant" | "middle",
    stats: TransformStats,
): boolean {
    if (part.type !== "tool") return false
    const state = part.state
    if (!state || state.status !== "completed") return false
    if (state.time && typeof state.time === "object") {
        state.time.compacted = now
    } else {
        state.time = { compacted: now }
    }
    if (state.input && typeof state.input === "object") {
        state.input = zone === "distant" ? {} : reduceInput(state.input)
        stats.reducedInputs++
    }
    return true
}

/**
 * Folds a terminal error tool part: the failure text keeps a short first
 * line (diagnostic value without the stack-trace weight) and the arguments
 * reduce like a completed call's. The part itself stays — structure, IDs,
 * and tool-call pairing are never touched. Current/tail zones never call
 * this: in-flight task detail is the spec's red line.
 */
function foldErrorPart(
    part: PartLike,
    keepChars: number,
    clearInput: boolean,
    stats: TransformStats,
): void {
    const state = part.state
    if (!state) return
    if (typeof state.error === "string" && state.error.length > keepChars) {
        state.error = firstLine(state.error, keepChars) || FOLDED_TEXT
        stats.foldedErrors++
    }
    if (state.input && typeof state.input === "object") {
        state.input = clearInput ? {} : reduceInput(state.input)
        stats.reducedInputs++
    }
}

function findSessionID(messages: MessageLike[]): string | undefined {
    for (const message of messages) {
        const id = message?.info?.sessionID
        if (typeof id === "string" && id) return id
    }
    return undefined
}
