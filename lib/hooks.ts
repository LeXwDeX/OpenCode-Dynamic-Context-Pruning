import type { PluginConfig } from "./config"
import type { Logger } from "./logger"
import type { OpenCodeClient } from "./opencode-client"
import type { PromptStore } from "./prompts/store"
import { segmentTurns, transformMessages } from "./dtc/engine"
import type { DtcState } from "./dtc/state"
import type { MessageLike } from "./dtc/types"
import { estimateSlice } from "./dtc/digest"
import { eventSessionID } from "./session-events"

interface CompactionOutput {
    context: string[]
    prompt?: string
}

/** Host-side tail protection DCP applies unless the user configured it. */
export const DEFAULT_TAIL_TURNS = 4
export const DEFAULT_PRESERVE_RECENT_TOKENS = 32_000

/**
 * Extracts the text of the most recent completed checkpoint (assistant
 * message flagged `summary`) from a session messages response. The host
 * hides prior checkpoint pairs from the summarizer input and only re-exposes
 * them through its own default prompt — which DCP replaces. Fetching the
 * previous checkpoint here is what keeps the checkpoint rolling instead of
 * restarting from the retained tail each compaction.
 */
export function extractPreviousCheckpoint(messages: unknown): string | undefined {
    if (!Array.isArray(messages)) return undefined
    for (let index = messages.length - 1; index >= 0; index--) {
        const message = messages[index] as { info?: any; parts?: any[] } | undefined
        const info = message?.info
        if (info?.role !== "assistant" || info.summary !== true) continue
        const parts = Array.isArray(message?.parts) ? message.parts : []
        const text = parts
            .filter((part) => part?.type === "text" && typeof part.text === "string")
            .map((part) => part.text.trim())
            .filter(Boolean)
            .join("\n\n")
            .trim()
        if (text) return text
    }
    return undefined
}

async function fetchPreviousCheckpoint(
    client: OpenCodeClient,
    sessionID: string,
): Promise<string | undefined> {
    if (!sessionID) return undefined
    try {
        const response = await client.session.messages({ path: { id: sessionID } })
        return extractPreviousCheckpoint(response.data ?? response)
    } catch {
        // Fail-open: without the previous checkpoint the compaction still
        // runs, it just restarts from the raw history.
        return undefined
    }
}

export interface SessionCompactingDeps {
    prompts: PromptStore
    logger: Logger
    client: OpenCodeClient
    state: DtcState
}

export function createSessionCompactingHandler(deps: SessionCompactingDeps) {
    return async (input: { sessionID: string }, output: CompactionOutput): Promise<void> => {
        try {
            // The host fires this hook and then runs the messages transform
            // over the compaction input in the same flow (fork
            // session/compaction.ts :373 → :380). Folding that input would
            // strip detail the summarizer needs, so arm a one-shot skip.
            deps.state.armCompactionSkip(input.sessionID)
            deps.prompts.reload()
            const prompt = deps.prompts.getRuntimePrompts().compaction
            const previous = await fetchPreviousCheckpoint(deps.client, input.sessionID)
            const withCheckpoint = previous
                ? `${prompt}\n\n<previous-checkpoint>\n${previous}\n</previous-checkpoint>`
                : prompt
            if (!output.prompt) {
                output.prompt = withCheckpoint
            } else if (!output.context.includes(prompt)) {
                output.context.push(withCheckpoint)
            }
            deps.logger.debug("Applied semantic pruning prompt", {
                sessionId: input.sessionID,
                carriedCheckpoint: Boolean(previous),
            })
        } catch (error) {
            deps.logger.warn(
                "Failed to apply semantic pruning prompt; native compaction continues",
                {
                    sessionId: input.sessionID,
                    error: error instanceof Error ? error.message : String(error),
                },
            )
        }
    }
}

/**
 * `chat.params` fires on every LLM request with the resolved model. DTC only
 * reads the context-window size from it — the budget tiers are fractions of
 * that window, and until it is known the engine fails open (no folding).
 */
export function createChatParamsHandler(deps: { state: DtcState; logger: Logger }) {
    return async (
        input: { sessionID: string; model?: { limit?: { context?: number } } },
        _output?: unknown,
    ): Promise<void> => {
        try {
            const context = input.model?.limit?.context
            if (typeof context === "number" && Number.isFinite(context) && context > 0) {
                deps.state.observeContextLimit(input.sessionID, context)
            }
        } catch (error) {
            deps.logger.debug("chat.params observation failed", {
                error: error instanceof Error ? error.message : String(error),
            })
        }
    }
}

export interface TransformHandlerDeps {
    state: DtcState
    config: PluginConfig["dtc"]
    logger: Logger
}

/**
 * THE compression surface: runs inside the host's per-request messages
 * transform. Fail-open by contract — any engine error must leave the array
 * untouched rather than break the model call.
 */
export function createTransformHandler(deps: TransformHandlerDeps) {
    return async (_input: unknown, output: { messages: unknown[] }): Promise<void> => {
        try {
            if (!Array.isArray(output?.messages) || output.messages.length === 0) return
            transformMessages(output.messages as MessageLike[], {
                state: deps.state,
                config: deps.config,
                logger: deps.logger,
            })
        } catch (error) {
            deps.logger.warn("DTC transform failed; the request proceeds unfolded", {
                error: error instanceof Error ? error.message : String(error),
            })
        }
    }
}

export interface EventHandlerDeps {
    state: DtcState
    logger: Logger
}

/** Slim lifecycle feed: only session deletion needs explicit cleanup; every
 * other DTC structure is LRU-bounded or request-scoped. */
export function createEventHandler(deps: EventHandlerDeps) {
    return async (input: { event: { type: string; properties?: Record<string, any> } }) => {
        try {
            if (input.event.type !== "session.deleted") return
            const sessionID = eventSessionID(input.event.properties)
            if (sessionID) deps.state.dropSession(sessionID)
        } catch (error) {
            deps.logger.warn("Event handler failed", {
                type: input.event.type,
                error: error instanceof Error ? error.message : String(error),
            })
        }
    }
}

async function showToast(
    client: OpenCodeClient,
    title: string,
    message: string,
    variant: "info" | "warning" | "error" = "info",
): Promise<void> {
    await client.tui
        .showToast({
            body: { title, message, variant, duration: 5000 },
        })
        .catch(() => undefined)
}

export interface CommandExecuteDeps {
    client: OpenCodeClient
    state: DtcState
    config: PluginConfig["dtc"]
    logger: Logger
}

export function createCommandExecuteHandler(deps: CommandExecuteDeps) {
    return async (
        input: {
            command: string
            sessionID: string
            arguments: string
        },
        _output?: { parts: unknown[] },
    ): Promise<void> => {
        if (input.command !== "dcp") return

        const subcommand = (input.arguments ?? "").trim().split(/\s+/, 1)[0]?.toLowerCase()

        if (subcommand === "fold") {
            deps.state.markBoundary(input.sessionID, Date.now(), 3)
            await showToast(
                deps.client,
                "DCP fold",
                "已标记话题边界并加深折叠；下一次模型请求起生效，会话不中断。",
            )
            deps.logger.debug("Handled DCP fold command", { sessionId: input.sessionID })
            throw new Error("__DCP_FOLD_HANDLED__")
        }

        if (subcommand === "status") {
            const message = await buildStatusMessage(deps, input.sessionID)
            await showToast(deps.client, "DCP status", message)
            throw new Error("__DCP_STATUS_HANDLED__")
        }

        await showToast(
            deps.client,
            "DCP",
            "用法：/dcp fold（立即深折叠）或 /dcp status（查看分区状态）。压缩由动态分级引擎在每次请求时自动完成。",
        )
        throw new Error("__DCP_HELP_HANDLED__")
    }
}

async function buildStatusMessage(deps: CommandExecuteDeps, sessionID: string): Promise<string> {
    try {
        const response = await deps.client.session.messages({ path: { id: sessionID } })
        const data = (response as { data?: unknown }).data ?? response
        const messages = (Array.isArray(data) ? data : []) as MessageLike[]
        const turns = segmentTurns(messages)
        const estimated = estimateSlice(messages, 0, messages.length)
        const context = deps.state.contextTokens(sessionID)
        const tail = Math.min(deps.config.tailTurns, turns.length)
        const lines = [
            `消息 ${messages.length} 条 / 对话轮 ${turns.length}（尾部保护 ${tail} 轮）`,
            `估算 ${estimated.toLocaleString()} tokens` +
                (context ? ` / 上下文窗口 ${context.toLocaleString()}` : "（窗口未知，暂未折叠）"),
            `手动降级档位：${deps.state.minLevel(sessionID)}`,
        ]
        return lines.join("\n")
    } catch {
        return "无法读取会话状态。"
    }
}

/**
 * Mutates the host config at load time: register the `/dcp` command when
 * enabled, and raise the host's compaction tail protection to DCP's tiered
 * defaults (last turns kept verbatim) unless the user already configured
 * them — this shapes the host's own overflow-compaction fallback, which is
 * the only compaction that still writes checkpoints.
 */
export function createConfigHandler(config: PluginConfig, logger: Logger) {
    return async (opencodeConfig: Record<string, any>): Promise<void> => {
        const compaction = (opencodeConfig.compaction ??= {})
        if (compaction.tail_turns === undefined) {
            compaction.tail_turns = DEFAULT_TAIL_TURNS
        }
        if (compaction.preserve_recent_tokens === undefined) {
            compaction.preserve_recent_tokens = DEFAULT_PRESERVE_RECENT_TOKENS
        }
        if (config.commands.enabled) {
            opencodeConfig.command ??= {}
            opencodeConfig.command.dcp = {
                template: "",
                description: "Dynamic context pruning: /dcp fold | /dcp status",
            }
        }
        logger.debug("Applied host config defaults", {
            tailTurns: compaction.tail_turns,
            preserveRecentTokens: compaction.preserve_recent_tokens,
        })
    }
}
