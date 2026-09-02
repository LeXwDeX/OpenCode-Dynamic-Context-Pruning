import type { Logger } from "../logger"
import { firstLine, truncateMiddle } from "../text"
import {
    digestKey,
    digestTurn,
    estimateSlice,
    findTopicBoundaries,
    offTopicMiddleTurns,
} from "./digest"
import {
    exciseItems,
    extractTarget,
    findArtifactRuns,
    findDuplicateRuns,
    findErrorRuns,
    resolveRuns,
    stableInputHash,
    type MergeItem,
} from "./merge"
import type { DtcState } from "./state"
import type { MessageLike, PartLike, Turn } from "./types"

/**
 * The dynamic tiered compression engine. Runs inside the host's
 * `experimental.chat.messages.transform` hook on every model request and
 * rewrites ONLY string payloads of the request-scoped message copies:
 *
 * - messages are never added, removed, or reordered; part IDs, roles, and
 *   tool-call pairing are never touched
 * - the one structural exception is validity-axis merging (#25, #26, #28):
 *   inside the D/M zones, same-target operation runs, strictly adjacent
 *   same-tool error chains, and byte-identical duplicate calls collapse to a
 *   single surviving tool part — whole parts are excised, a message is never
 *   emptied, and the C/T zones are exempt
 * - distant tool outputs are folded with the host's own `time.compacted`
 *   marker, so the wire rendering is the host's native one
 * - middle-zone turns topically discontinuous with the current-task zone
 *   (#27) deepen to the distant digest treatment, detected mechanically with
 *   the same Jaccard drift threshold and layered under the merge excision
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
    /** Validity axis (#25/#26/#28): M/D same-target artifact runs, adjacent
     * same-tool error chains, and byte-identical duplicate calls merge into
     * one surviving call (`_merged` meta carries the counts). */
    mergeRuns: boolean
}

export const DTC_DEFAULTS: DtcConfig = {
    tailTurns: 4,
    lowWatermarkRatio: 0.5,
    targetRatio: 0.7,
    driftThreshold: 0.18,
    toolOutputKeepChars: 4000,
    mergeRuns: true,
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
    /** Topic axis (#27): M-zone turns deepened to the distant digest treatment. */
    offTopicTurns: number
    /** Validity axis (#25/#26/#28): runs merged into one surviving call. */
    mergedRuns: number
    /** Whole tool parts actually removed (never-empty adjustments included). */
    excisedParts: number
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
    offTopicTurns: 0,
    mergedRuns: 0,
    excisedParts: 0,
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

    const sessionID = findSessionID(messages, deps.state)
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

    // Topic axis (#27): middle-zone turns topically discontinuous with the
    // current-task zone deepen to the distant digest treatment. Planned
    // pre-excision and outside the merge gate — the topic axis does not
    // depend on the validity axis. Failure skips only the deepening; the
    // middle zone folds classically.
    let offTopicDigests: Map<number, string> | undefined
    try {
        offTopicDigests = planOffTopicDeepening(messages, headTurns, zones, deps)
    } catch (error) {
        deps.logger?.warn("DTC off-topic scan failed; middle zone folds classically", {
            error: String(error),
        })
    }

    // Validity axis (#25/#26): artifact and error runs in the D/M zones
    // merge BEFORE any folding, so band 1 digests and the escalation estimate
    // both see the excised shape. Failure skips only the merge — folding
    // proceeds.
    let mergeDigests: Map<number, string> | undefined
    let mergeInjections: SurvivorInjection[] = []
    if (config.mergeRuns) {
        try {
            const plan = planMergeRuns(messages, headTurns, zones, deps)
            if (plan) {
                applyMergeExcision(plan, stats)
                mergeDigests = plan.digests
                mergeInjections = plan.injections
            }
        } catch (error) {
            deps.logger?.warn("DTC merge phase failed; folding continues", {
                error: String(error),
            })
        }
    }

    let level = Math.max(1, minLevel) as FoldLevel
    // Bands apply cumulatively: a manual minimum level can start at 2 or 3,
    // and every band below it must still fold — starting high never skips the
    // distant zone. Each band folds exactly once per request.
    let appliedBand = 0
    const applyUpTo = (lvl: FoldLevel): void => {
        while (appliedBand < lvl) {
            appliedBand++
            applyBand(
                messages,
                headTurns,
                zones,
                appliedBand,
                deps,
                stats,
                now,
                mergeDigests,
                offTopicDigests,
            )
        }
    }
    applyUpTo(level)
    let estimatedAfter = estimateSlice(messages, 0, messages.length)
    while (estimatedAfter > target && level < 3) {
        level = (level + 1) as FoldLevel
        applyUpTo(level)
        estimatedAfter = estimateSlice(messages, 0, messages.length)
    }

    // `_merged` meta lands only once band 2 has run (level >= 2): the meta
    // composes with the reduced skeleton, never with raw payloads. Level-1
    // requests excise but stay meta-free — validity ⊥ depth by design.
    if (level >= 2) injectMergeMetas(mergeInjections)

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
        offTopicTurns: stats.offTopicTurns,
        mergedRuns: stats.mergedRuns,
        excisedParts: stats.excisedParts,
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

/**
 * Topic-axis deepening (#27): plans the distant digest treatment for M-zone
 * turns whose user text drifts from the C-zone reference. Digests are
 * precomputed on the pre-excision array — counts stay faithful (`edit×3`)
 * and keys match the shape the host rebuilds on every request — mirroring
 * the D-zone loop exactly, so a turn deepened in M and later sliding into D
 * is a pure cache hit with an identical digest.
 */
function planOffTopicDeepening(
    messages: MessageLike[],
    headTurns: Turn[],
    zones: Zones,
    deps: TransformDeps,
): Map<number, string> {
    const digests = new Map<number, string>()
    const offTopic = offTopicMiddleTurns(
        messages,
        headTurns,
        zones.mStart,
        zones.cStart,
        deps.config.driftThreshold,
    )
    for (const t of offTopic) {
        const turn = headTurns[t]!
        const key = digestKey(messages, turn)
        let digest = deps.state.cachedDigest(key)
        if (digest === undefined) {
            digest = digestTurn(messages, turn, t + 1)
            deps.state.storeDigest(key, digest)
        }
        digests.set(t, digest)
    }
    return digests
}

function applyBand(
    messages: MessageLike[],
    headTurns: Turn[],
    zones: Zones,
    band: number,
    deps: TransformDeps,
    stats: TransformStats,
    now: number,
    mergeDigests?: Map<number, string>,
    offTopicDigests?: Map<number, string>,
): void {
    if (band === 1) {
        for (let t = 0; t < zones.mStart; t++) {
            foldDistant(messages, headTurns[t]!, t + 1, deps, stats, now, mergeDigests?.get(t))
        }
    } else if (band === 2) {
        for (let t = zones.mStart; t < zones.cStart; t++) {
            const precomputed = offTopicDigests?.get(t)
            if (precomputed !== undefined) {
                // #27: off-topic with the current-task zone — full distant
                // treatment with the pre-excision digest, folded exactly once.
                foldDistant(messages, headTurns[t]!, t + 1, deps, stats, now, precomputed)
                stats.offTopicTurns++
            } else {
                foldMiddle(messages, headTurns[t]!, stats, now)
            }
        }
    } else if (band === 3) {
        for (let t = zones.cStart; t < headTurns.length; t++) {
            foldCurrent(messages, headTurns[t]!, deps.config.toolOutputKeepChars, stats)
        }
    }
}

/** A survivor awaiting its `_merged` meta once band 2 has run. */
interface SurvivorInjection {
    part: PartLike
    meta: string
}

interface MergePlan {
    /** Pre-excision D-zone digests keyed by head-turn index (band 1 input). */
    digests: Map<number, string>
    /** M-zone survivors; injected after escalation when level >= 2. */
    injections: SurvivorInjection[]
    /** Whole tool parts to excise, grouped per message as local indices. */
    excisions: Array<{ message: MessageLike; localDrops: Set<number> }>
    keptRuns: number
}

/**
 * Validity-axis merge planning (#25/#26/#28): resolves same-target artifact
 * runs, strictly adjacent same-tool error chains, and byte-identical duplicate
 * calls over the D/M tool-descriptor sequence and computes everything the rest
 * of the pipeline needs — pre-excision D-zone digests, per-message excision
 * sets, and the M-zone survivor injections. Returns undefined when nothing
 * merges, restoring the pre-merge code path byte for byte. The descriptor scan
 * covers head turns [0, cStart) only, so C/T parts can never enter a run and
 * drops can only map back to D/M messages.
 */
function planMergeRuns(
    messages: MessageLike[],
    headTurns: Turn[],
    zones: Zones,
    deps: TransformDeps,
): MergePlan | undefined {
    const seq: MergeItem[] = []
    const records: Array<{
        part: PartLike
        message: MessageLike
        localIndex: number
        turn: number
    }> = []
    for (let t = 0; t < zones.cStart && t < headTurns.length; t++) {
        const turn = headTurns[t]!
        for (let i = turn.start; i < turn.end && i < messages.length; i++) {
            const message = messages[i]
            const parts = message?.parts
            if (!Array.isArray(parts)) continue
            for (let localIndex = 0; localIndex < parts.length; localIndex++) {
                const part = parts[localIndex]
                if (!part || typeof part !== "object" || part.type !== "tool") continue
                const state = part.state
                if (!state || typeof state !== "object") continue
                const status = String(state.status ?? "")
                seq.push({
                    tool: String(part.tool ?? "tool"),
                    status,
                    isError: status === "error",
                    target: extractTarget(state.input),
                    inputHash: stableInputHash(state.input),
                    turn: t,
                    errLine:
                        typeof state.error === "string" ? firstLine(state.error, 200) : undefined,
                })
                records.push({ part, message, localIndex, turn: t })
            }
        }
    }
    if (seq.length === 0) return undefined
    // #26 wires error runs alongside the artifacts; #28 appends the duplicate
    // detector: byte-identical (tool, stable input hash) calls at any
    // distance, turn boundaries allowed (D8). resolveRuns owns the priority:
    // a run overlapping a higher-priority one is dropped whole.
    const resolved = resolveRuns(
        seq,
        findArtifactRuns(seq),
        findErrorRuns(seq),
        findDuplicateRuns(seq),
    )
    if (resolved.drops.size === 0) return undefined

    // Digests must be computed BEFORE the excision: the D-zone digest carries
    // pre-merge counts (`edit×3`, never `edit×1`), and because the host
    // rebuilds the array pre-excision on every request, keys taken at this
    // same shape stay stable across requests.
    const digests = new Map<number, string>()
    for (let t = 0; t < zones.mStart; t++) {
        const turn = headTurns[t]!
        const key = digestKey(messages, turn)
        let digest = deps.state.cachedDigest(key)
        if (digest === undefined) {
            digest = digestTurn(messages, turn, t + 1)
            deps.state.storeDigest(key, digest)
        }
        digests.set(t, digest)
    }

    const excisionMap = new Map<MessageLike, Set<number>>()
    for (let index = 0; index < records.length; index++) {
        if (!resolved.drops.has(index)) continue
        const record = records[index]!
        let localDrops = excisionMap.get(record.message)
        if (!localDrops) {
            localDrops = new Set<number>()
            excisionMap.set(record.message, localDrops)
        }
        localDrops.add(record.localIndex)
    }
    const injections: SurvivorInjection[] = []
    for (const [survivor, meta] of resolved.metas) {
        const record = records[survivor]!
        // D-zone survivors stay injection-free: their inputs are cleared and
        // the counts live in the digest; only M-zone survivors carry `_merged`.
        if (record.turn >= zones.mStart) injections.push({ part: record.part, meta })
    }
    return {
        digests,
        injections,
        excisions: [...excisionMap].map(([message, localDrops]) => ({ message, localDrops })),
        keptRuns: resolved.runs.length,
    }
}

/** Applies the plan's excisions: whole tool parts leave the request copy,
 * never-empty per message; counters record what actually left. */
function applyMergeExcision(plan: MergePlan, stats: TransformStats): void {
    for (const { message, localDrops } of plan.excisions) {
        const parts = message.parts
        if (!Array.isArray(parts)) continue
        const before = parts.length
        const kept = exciseItems(parts, localDrops)
        message.parts = kept
        stats.excisedParts += before - kept.length
    }
    stats.mergedRuns = plan.keptRuns
}

/** Injects `_merged` meta into M-zone survivor inputs after band 2 has run
 * (level >= 2). Runs never cross zone lines, so a survivor's own zone
 * decides injection; conflict with a pre-existing `_merged` key is impossible
 * because `reduceInput` never copies unknown keys. Only terminal states
 * (completed/error) carry meta — in-flight parts are not merge results. */
function injectMergeMetas(injections: SurvivorInjection[]): void {
    for (const { part, meta } of injections) {
        const state = part.state
        if (!state || typeof state !== "object") continue
        const status = String(state.status ?? "")
        if (status !== "completed" && status !== "error") continue
        const input = state.input
        state.input = {
            ...(input && typeof input === "object" ? input : {}),
            _merged: meta,
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
    precomputed?: string,
): void {
    // When the merge phase precomputed this digest (pre-excision shape), the
    // cache round-trip already happened there; consuming it keeps the digest
    // identical while `digestedTurns` still counts exactly once per D turn.
    let digest = precomputed
    if (digest === undefined) {
        const key = digestKey(messages, turn)
        digest = deps.state.cachedDigest(key)
        if (digest === undefined) {
            digest = digestTurn(messages, turn, ordinal)
            deps.state.storeDigest(key, digest)
        }
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

function findSessionID(messages: MessageLike[], state: DtcState): string | undefined {
    for (const message of messages) {
        const id = message?.info?.sessionID
        if (typeof id === "string" && id) return id
    }
    // Fork-shape fallback: the host stripped id/sessionID from the payload,
    // so correlate through the chat.params index instead — scan user turns
    // newest-first and return the session recorded for that message's
    // creation time. Request N's chat.params records the user message that
    // triggered it, so from request N+1 on the session always resolves;
    // the very first request of a session finds nothing and fails open.
    for (let i = messages.length - 1; i >= 0; i--) {
        const message = messages[i]
        if (message?.info?.role !== "user") continue
        if ((message.parts ?? []).some((p) => p?.type === "compaction")) continue
        const created = message.info?.time?.created
        if (typeof created !== "number") continue
        const sessionID = state.sessionByUserTime(created)
        if (sessionID) return sessionID
    }
    return undefined
}
