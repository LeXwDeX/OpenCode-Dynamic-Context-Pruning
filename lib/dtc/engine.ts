import { estimateTokens } from "../text"
import type { MessageLike, PartLike } from "./types"

/** Only old, verified successful tool outputs are eligible for projection. */
export interface DtcConfig {
    protectRecentSteps: number
    protectRecentTokens: number
    targetRatio: number
    minimumSavingsTokens: number
    /** Additional protected tool names; never expands the built-in candidate set. */
    protectedTools: string[]
}

export const DTC_DEFAULTS: DtcConfig = {
    protectRecentSteps: 4,
    protectRecentTokens: 16000,
    targetRatio: 0.7,
    minimumSavingsTokens: 512,
    protectedTools: [],
}

export interface TransformStats {
    foldedTools: number
    estimatedBefore: number | undefined
    estimatedAfter: number | undefined
    targetTokens: number
    protectedSteps: number
    overBudget: boolean
    skipped?: "invalid-budget" | "unknown-content"
}

export interface ProjectionOptions {
    inputBudget: number
    config: DtcConfig
    /** This projection only: do not bypass protections or change future policy. */
    force?: boolean
    now?: number
}

export interface ProjectionResult {
    messages: MessageLike[]
    stats: TransformStats
}

const CLEARED_OUTPUT = "[Old tool result content cleared]"
const CLEARED_TOKENS = estimateTokens(CLEARED_OUTPUT)
const MESSAGE_OVERHEAD = 8
const PART_OVERHEAD = 4
const TOOL_OVERHEAD = 12
const STRUCTURAL_PARTS = new Set(["step-start", "step-finish", "snapshot", "patch"])
const OUTPUT_TOOLS = new Set(["read", "grep", "glob", "bash"])
const ALWAYS_PROTECTED_TOOLS = new Set(["skill", "task", "dcp_prune"])

interface ToolPosition {
    message: number
    part: number
}

interface ToolStep {
    tools: ToolPosition[]
    tokens: number
}

function hasAttachments(value: unknown): boolean {
    return Array.isArray(value) ? value.length > 0 : value !== undefined && value !== null
}

function attachmentsPresent(part: PartLike, clearedStateAttachments = false): boolean {
    return (
        hasAttachments(part.attachments) ||
        (!clearedStateAttachments && hasAttachments(part.state?.attachments)) ||
        hasAttachments(part.state?.metadata?.attachments)
    )
}

function jsonTokens(value: unknown): number | undefined {
    try {
        const encoded = JSON.stringify(value)
        return encoded === undefined ? undefined : estimateTokens(encoded)
    } catch {
        return undefined
    }
}

/** Unknown media or host content is not assigned an invented token cost. */
function estimatePart(part: PartLike, role: string | undefined): number | undefined {
    if (!part || typeof part !== "object") return undefined
    // User references retain UI markers after the host expands their content
    // into separate text parts. These markers are omitted from model requests.
    if (
        role === "user" &&
        (part.type === "agent" ||
            (part.type === "file" &&
                (part.mime === "text/plain" || part.mime === "application/x-directory")))
    )
        return 0
    if (STRUCTURAL_PARTS.has(part.type ?? "")) return 0
    // These host-owned user parts serialize as fixed text. Their presence
    // after native compaction must not disable every future projection.
    if (part.type === "compaction") {
        return PART_OVERHEAD + estimateTokens("What did we do so far?")
    }
    if (part.type === "subtask") {
        return PART_OVERHEAD + estimateTokens("The following tool was executed by the user")
    }
    if (part.type === "text" || part.type === "reasoning") {
        if (typeof part.text !== "string") return undefined
        return PART_OVERHEAD + estimateTokens(part.text)
    }
    if (part.type !== "tool" || !part.state) return undefined
    const state = part.state
    // The host omits only state.attachments for already-cleared completed
    // assistant tools. Inputs, output shape and unfamiliar metadata still count.
    const clearedStateAttachments =
        role === "assistant" && state.status === "completed" && !!state.time?.compacted
    if (attachmentsPresent(part, clearedStateAttachments)) return undefined
    const inputTokens = jsonTokens(state.input ?? {})
    if (inputTokens === undefined) return undefined
    let tokens =
        TOOL_OVERHEAD +
        estimateTokens(part.tool ?? "") +
        estimateTokens(typeof part.callID === "string" ? part.callID : "") +
        inputTokens
    if (state.status === "completed") {
        if (typeof state.output !== "string") return undefined
        tokens += state.time?.compacted ? CLEARED_TOKENS : estimateTokens(state.output)
    } else if (state.status === "error") {
        const errorOutput =
            state.metadata?.interrupted === true && typeof state.metadata.output === "string"
                ? state.metadata.output
                : state.error
        if (typeof errorOutput !== "string") return undefined
        tokens += estimateTokens(errorOutput)
    } else if (state.status === "pending" || state.status === "running") {
        tokens += estimateTokens("Tool execution aborted")
    } else {
        return undefined
    }
    // Inputs and errors remain on the wire even when an output has a marker.
    if (state.status !== "error" && state.error !== undefined) {
        if (typeof state.error !== "string") return undefined
        tokens += estimateTokens(state.error)
    }
    return tokens
}

/** Approximate visible request payload, including full inputs of compacted tools.
 * Undefined means that media or an unfamiliar host shape cannot be estimated. */
export function estimateMessages(messages: readonly MessageLike[]): number | undefined {
    let total = 0
    for (const message of messages) {
        if (!message || typeof message !== "object" || !Array.isArray(message.parts)) {
            return undefined
        }
        total += MESSAGE_OVERHEAD
        for (const part of message.parts) {
            const tokens = estimatePart(part, message.info?.role)
            if (tokens === undefined) return undefined
            total += tokens
        }
    }
    return total
}

/** Native step markers split a message. Without them the whole assistant
 * message is one indivisible step, including all parallel tool siblings. */
function toolSteps(messages: readonly MessageLike[]): ToolStep[] {
    const steps: ToolStep[] = []
    for (let messageIndex = 0; messageIndex < messages.length; messageIndex++) {
        const message = messages[messageIndex]!
        if (message.info?.role !== "assistant") continue
        let current: ToolStep = { tools: [], tokens: MESSAGE_OVERHEAD }
        for (let partIndex = 0; partIndex < (message.parts?.length ?? 0); partIndex++) {
            const part = message.parts![partIndex]!
            if (part.type === "step-start" && current.tools.length > 0) {
                steps.push(current)
                current = { tools: [], tokens: MESSAGE_OVERHEAD }
            }
            current.tokens += estimatePart(part, message.info?.role) ?? 0
            if (part.type === "tool") current.tools.push({ message: messageIndex, part: partIndex })
        }
        if (current.tools.length > 0) steps.push(current)
    }
    return steps
}

function instructionRead(part: PartLike): boolean {
    if (part.tool !== "read") return false
    // The host may append resolved AGENTS instructions to an ordinary read.
    // Their source paths are recorded in metadata.loaded, independently of
    // the requested file path. An unfamiliar loaded shape is also protected.
    const loaded = part.state?.metadata?.loaded
    if (loaded !== undefined && (!Array.isArray(loaded) || loaded.length > 0)) return true
    const input = part.state?.input
    const target = input?.filePath ?? input?.path ?? input?.file ?? input?.filename
    // A read whose target cannot be established is not a verified candidate.
    if (typeof target !== "string") return true
    const name = target.replaceAll("\\", "/").split("/").at(-1)?.toLowerCase()
    return ["agents.md", "agents.override.md", "skill.md", "claude.md"].includes(name ?? "")
}

function outputSavings(part: PartLike, config: DtcConfig): number {
    const state = part.state
    const tool = part.tool ?? ""
    if (
        !state ||
        state.status !== "completed" ||
        typeof state.output !== "string" ||
        state.time?.compacted ||
        (state.error !== undefined && state.error !== "") ||
        attachmentsPresent(part) ||
        !OUTPUT_TOOLS.has(tool) ||
        ALWAYS_PROTECTED_TOOLS.has(tool) ||
        config.protectedTools.includes(tool) ||
        instructionRead(part)
    ) {
        return 0
    }
    // A completed shell tool can still report a failed command. Only the
    // host's explicit successful exit code is sufficient for this tool.
    if (tool === "bash" && state.metadata?.exit !== 0) return 0
    if (state.metadata?.exit !== undefined && state.metadata.exit !== 0) return 0
    const savings = estimateTokens(state.output) - CLEARED_TOKENS
    return savings > 0 && savings >= config.minimumSavingsTokens ? savings : 0
}

function validateConfig(config: DtcConfig): void {
    if (
        !Number.isSafeInteger(config.protectRecentSteps) ||
        config.protectRecentSteps < 1 ||
        !Number.isSafeInteger(config.protectRecentTokens) ||
        config.protectRecentTokens < 0 ||
        !Number.isFinite(config.targetRatio) ||
        config.targetRatio <= 0 ||
        config.targetRatio > 1 ||
        !Number.isSafeInteger(config.minimumSavingsTokens) ||
        config.minimumSavingsTokens < 1 ||
        !Array.isArray(config.protectedTools) ||
        config.protectedTools.some((name) => typeof name !== "string" || !name.trim())
    ) {
        throw new Error("Invalid tool output projection policy")
    }
}

/** Returns an independent request projection. Planning never mutates source;
 * publication belongs to the host adapter after this function succeeds.
 * Only native compacted markers change, and every protection outranks budget. */
export function projectMessages(
    messages: readonly MessageLike[],
    options: ProjectionOptions,
): ProjectionResult {
    validateConfig(options.config)
    const { config, inputBudget } = options
    const validBudget = Number.isFinite(inputBudget) && inputBudget > 0
    const targetTokens = validBudget ? Math.floor(inputBudget * config.targetRatio) : 0
    const estimatedBefore = estimateMessages(messages)
    const stats: TransformStats = {
        foldedTools: 0,
        estimatedBefore,
        estimatedAfter: estimatedBefore,
        targetTokens,
        protectedSteps: 0,
        overBudget: estimatedBefore === undefined || estimatedBefore > targetTokens,
    }
    if (!validBudget || estimatedBefore === undefined) {
        stats.skipped = validBudget ? "unknown-content" : "invalid-budget"
        stats.overBudget = true
        return { messages: structuredClone(messages) as MessageLike[], stats }
    }
    const steps = toolSteps(messages)
    let firstProtected = steps.length
    let protectedTokens = 0
    while (
        firstProtected > 0 &&
        (stats.protectedSteps < config.protectRecentSteps ||
            protectedTokens < config.protectRecentTokens)
    ) {
        firstProtected--
        protectedTokens += steps[firstProtected]!.tokens
        stats.protectedSteps++
    }

    let remaining = estimatedBefore
    const selected: ToolPosition[] = []
    for (let index = 0; index < firstProtected; index++) {
        if (!options.force && remaining <= targetTokens) break
        for (const position of steps[index]!.tools) {
            if (!options.force && remaining <= targetTokens) break
            const part = messages[position.message]!.parts![position.part]!
            const savings = outputSavings(part, config)
            if (savings === 0) continue
            selected.push(position)
            remaining -= savings
        }
    }

    const projected = structuredClone(messages) as MessageLike[]
    if (selected.length > 0) {
        const now = options.now ?? Date.now()
        if (!Number.isFinite(now) || now <= 0) throw new Error("Invalid projection timestamp")
        for (const position of selected) {
            const state = projected[position.message]!.parts![position.part]!.state!
            state.time = { ...state.time, compacted: now }
        }
    }
    stats.foldedTools = selected.length
    stats.estimatedAfter = remaining
    stats.overBudget = remaining > targetTokens
    return { messages: projected, stats }
}
