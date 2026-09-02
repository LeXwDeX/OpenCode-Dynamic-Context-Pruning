import { hashString } from "../text"

/**
 * Validity-axis merge layer (issue #23 family): pure, deterministic run
 * detection over a flat sequence of tool-call descriptors, plus a safe
 * excision helper. Nothing here touches messages — the engine builds the
 * descriptor sequence per zone and applies the resolved drop set (#25/#26/#28).
 *
 * Vocabulary (AGENTS.md two-axis model): fold = compress content, part stays;
 * merge = N parts become 1 (structural); excise = merge's removal act;
 * digest = turn-level mechanical summary.
 *
 * Contract, settled by grilling on 2026-09-02 (see issue #23):
 * - artifact runs: same-target operations (MERGEABLE_TOOLS × TARGET_KEYS) with
 *   at most ARTIFACT_MAX_GAP other tool calls bridged between members, never
 *   crossing a user-turn boundary (D6), length ≥ 2
 * - error runs: strictly adjacent same-tool error items, same turn
 * - duplicate runs: identical (tool, stable input hash) at any distance,
 *   turn boundary allowed (D8 — byte-identical input carries zero information
 *   delta, so the intent-boundary argument of D6 does not apply)
 * - priority artifact > error > duplicate: any index overlap with a
 *   higher-priority run drops the whole lower run (no partial merges)
 * - the survivor is always the LAST member (net state); counts and the first
 *   error line live in the `_merged` meta (D1/D5)
 * - excision never empties a non-empty list (never-empty rule)
 */

/** Tools whose operations carry a file target and merge into artifact runs. */
export const MERGEABLE_TOOLS = new Set([
    "edit",
    "write",
    "read",
    "patch",
    "multiedit",
    "apply_patch",
])

/** Bounded-interleave window: other tool calls allowed between run members.
 * Settled to 2 by prototype measurement on a real 460-part session dump
 * (edit→bash(test)→edit loops are the dominant noise pattern; N=3 gains
 * flatten while risk grows). */
export const ARTIFACT_MAX_GAP = 2

/** Input keys that identify a merge target, in precedence order. */
const TARGET_KEYS = ["filePath", "path", "file", "filename", "directory"]

/** First-error line inside `_merged` meta is capped at this many characters. */
const META_ERR_LINE_CHARS = 40

/** One tool call, flattened by the engine into a zone-scoped sequence. */
export interface MergeItem {
    tool: string
    status: string
    /** File target from the reduced input, or null when the call has none. */
    target: string | null
    /** Stable hash of the tool input (key-order independent). */
    inputHash: string
    /** User-turn index; runs (except duplicates) never cross turns. */
    turn: number
    /** True when the call terminated in an error state. */
    isError: boolean
    /** First line of the error text when isError; feeds the meta's `first:`. */
    errLine?: string
}

export type MergeRunKind = "artifact" | "error" | "duplicate"

export interface MergeRun {
    kind: MergeRunKind
    /** Indices into the descriptor sequence, ascending. */
    members: number[]
    /** The last member — the part that survives the merge. */
    survivor: number
    /** Artifact-run target; null for error/duplicate runs. */
    target: string | null
    /** Members whose isError is true. */
    errCount: number
}

export interface ResolvedMerge {
    /** Runs kept after priority resolution, ordered by survivor index. */
    runs: MergeRun[]
    /** Indices to excise: every kept run's members minus its survivor. */
    drops: Set<number>
    /** Survivor index → `_merged` meta string. */
    metas: Map<number, string>
}

export function extractTarget(input: unknown): string | null {
    if (input === null || typeof input !== "object" || Array.isArray(input)) {
        return null
    }
    const record = input as Record<string, unknown>
    for (const key of TARGET_KEYS) {
        const value = record[key]
        if (typeof value === "string" && value.length > 0) {
            return value
        }
    }
    return null
}

/** Key-order-independent content hash of a tool input. */
export function stableInputHash(input: unknown): string {
    return hashString(stableStringify(input))
}

function stableStringify(value: unknown): string {
    if (value === null || typeof value !== "object") {
        return JSON.stringify(value) ?? "null"
    }
    if (Array.isArray(value)) {
        return `[${value.map(stableStringify).join(",")}]`
    }
    const record = value as Record<string, unknown>
    const keys = Object.keys(record).sort()
    return `{${keys.map((key) => `${JSON.stringify(key)}:${stableStringify(record[key])}`).join(",")}}`
}

interface OpenRun {
    members: number[]
    gap: number
    lastTurn: number
    target: string
}

function closeRun(open: OpenRun, seq: MergeItem[], out: MergeRun[]): void {
    if (open.members.length < 2) {
        return
    }
    out.push({
        kind: "artifact",
        members: open.members,
        survivor: open.members[open.members.length - 1]!,
        target: open.target,
        errCount: open.members.filter((index) => seq[index]!.isError).length,
    })
}

/**
 * Same-target operation chains with bounded interleave (D3) inside a single
 * user turn (D6). Mixed mergeable tools on one target form ONE run — the
 * survivor (last operation) is the definitive state, and superseded reads
 * inside the chain are misleading information, not information (D2).
 */
export function findArtifactRuns(seq: MergeItem[], maxGap: number = ARTIFACT_MAX_GAP): MergeRun[] {
    const out: MergeRun[] = []
    const open = new Map<string, OpenRun>()
    for (let index = 0; index < seq.length; index++) {
        const item = seq[index]!
        const mergeable = MERGEABLE_TOOLS.has(item.tool) && item.target !== null
        if (!mergeable) {
            for (const run of open.values()) {
                run.gap++
            }
            continue
        }
        const target = item.target!
        const current = open.get(target)
        if (current && current.lastTurn === item.turn && current.gap <= maxGap) {
            current.members.push(index)
            current.gap = 0
            continue
        }
        if (current) {
            closeRun(current, seq, out)
        }
        open.set(target, { members: [index], gap: 0, lastTurn: item.turn, target })
    }
    for (const run of open.values()) {
        closeRun(run, seq, out)
    }
    out.sort((a, b) => a.survivor - b.survivor)
    return out
}

/**
 * Strictly adjacent same-tool error chains inside one turn. A single error is
 * never a run. Overlap with artifact runs is resolved later (artifact wins):
 * same-file failed edits are absorbed there, this catches cross-file error
 * bursts (compile/test/retry storms) on non-target tools.
 */
export function findErrorRuns(seq: MergeItem[]): MergeRun[] {
    const out: MergeRun[] = []
    let start = 0
    while (start < seq.length) {
        const item = seq[start]!
        if (!item.isError) {
            start++
            continue
        }
        let end = start
        while (
            end + 1 < seq.length &&
            seq[end + 1]!.isError &&
            seq[end + 1]!.tool === item.tool &&
            seq[end + 1]!.turn === item.turn
        ) {
            end++
        }
        if (end > start) {
            const members: number[] = []
            for (let index = start; index <= end; index++) {
                members.push(index)
            }
            out.push({
                kind: "error",
                members,
                survivor: end,
                target: null,
                errCount: members.length,
            })
        }
        start = end + 1
    }
    return out
}

/**
 * Byte-identical repeated calls (same tool + same stable input hash) at any
 * distance; the LAST occurrence survives. Turn boundaries do not protect
 * duplicates (D8). Adjacent identical calls are usually absorbed by artifact
 * or error runs first — resolveRuns enforces the priority.
 */
export function findDuplicateRuns(seq: MergeItem[]): MergeRun[] {
    const groups = new Map<string, number[]>()
    for (let index = 0; index < seq.length; index++) {
        const item = seq[index]!
        const key = `${item.tool}\u0000${item.inputHash}`
        const group = groups.get(key)
        if (group) {
            group.push(index)
        } else {
            groups.set(key, [index])
        }
    }
    const out: MergeRun[] = []
    for (const members of groups.values()) {
        if (members.length < 2) {
            continue
        }
        out.push({
            kind: "duplicate",
            members,
            survivor: members[members.length - 1]!,
            target: null,
            errCount: members.filter((index) => seq[index]!.isError).length,
        })
    }
    out.sort((a, b) => a.survivor - b.survivor)
    return out
}

/**
 * `_merged` meta for a kept run (D1/D5): `edit×3 (2 err)` for same-tool
 * chains, `ops×4` for mixed-tool artifact chains, and error chains append the
 * first error's first line (root cause) capped at 40 characters.
 */
export function mergeMeta(run: MergeRun, seq: MergeItem[]): string {
    const tools = new Set(run.members.map((index) => seq[index]!.tool))
    const label = tools.size === 1 ? run.members.map((index) => seq[index]!.tool)[0]! : "ops"
    let meta = `${label}×${run.members.length}`
    if (run.errCount > 0) {
        meta += ` (${run.errCount} err)`
    }
    if (run.kind === "error") {
        const first = run.members
            .map((index) => seq[index]!)
            .find(
                (item) =>
                    item.isError && typeof item.errLine === "string" && item.errLine.length > 0,
            )
        if (first?.errLine) {
            const line = first.errLine.slice(0, META_ERR_LINE_CHARS)
            meta += `, first: ${line}`
        }
    }
    return meta
}

/**
 * Priority resolution (artifact > error > duplicate): a run whose members
 * intersect an already-kept run is dropped whole — no partial merges, so the
 * meta never lies. Returns the drop set (members minus survivors) and the
 * survivor → meta map the engine injects into reduced inputs.
 */
export function resolveRuns(
    seq: MergeItem[],
    artifactRuns: MergeRun[],
    errorRuns: MergeRun[],
    duplicateRuns: MergeRun[],
): ResolvedMerge {
    const kept: MergeRun[] = []
    const claimed = new Set<number>()
    for (const run of [...artifactRuns, ...errorRuns, ...duplicateRuns]) {
        if (run.members.some((index) => claimed.has(index))) {
            continue
        }
        for (const index of run.members) {
            claimed.add(index)
        }
        kept.push(run)
    }
    kept.sort((a, b) => a.survivor - b.survivor)
    const drops = new Set<number>()
    const metas = new Map<number, string>()
    for (const run of kept) {
        for (const index of run.members) {
            if (index !== run.survivor) {
                drops.add(index)
            }
        }
        metas.set(run.survivor, mergeMeta(run, seq))
    }
    return { runs: kept, drops, metas }
}

/**
 * Never-empty excision: remove the dropped indices; if that would empty a
 * non-empty list, keep the single item at the highest valid dropped index
 * instead. The engine only ever passes whole tool-part indices, so tool-call
 * pairing stays structurally balanced by construction.
 */
export function exciseItems<T>(items: T[], drops: Set<number>): T[] {
    if (drops.size === 0) {
        return items.slice()
    }
    const kept = items.filter((_, index) => !drops.has(index))
    if (kept.length > 0) {
        return kept
    }
    let fallback = -1
    for (const index of drops) {
        if (index >= 0 && index < items.length && index > fallback) {
            fallback = index
        }
    }
    return fallback >= 0 ? [items[fallback]!] : []
}
