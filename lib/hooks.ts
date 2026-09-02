import type { PluginConfig } from "./config"
import type { Logger } from "./logger"
import type { OpenCodeClient } from "./opencode-client"
import { segmentTurns, transformMessages } from "./dtc/engine"
import type { DtcState } from "./dtc/state"
import type { MessageLike } from "./dtc/types"
import { estimateSlice } from "./dtc/digest"
import { eventSessionID } from "./session-events"

/** Host-side tail protection DCP applies unless the user configured it. */
export const DEFAULT_TAIL_TURNS = 4
export const DEFAULT_PRESERVE_RECENT_TOKENS = 32_000

export interface SessionCompactingDeps {
    state: DtcState
    logger: Logger
}

/**
 * The host fires this hook right before it runs the messages transform over
 * the compaction input (fork session/compaction.ts :373 → :380). DCP does NOT
 * touch the compaction prompt: the host's native anchored-summary template
 * (with its own previous-summary rolling merge) stays fully in charge of
 * `/compact` and the overflow fallback. The hook's single job is arming the
 * one-shot DTC skip so the summarizer always sees full-fidelity input instead
 * of request-time folds.
 */
export function createSessionCompactingHandler(deps: SessionCompactingDeps) {
    return async (input: { sessionID: string }, _output?: unknown): Promise<void> => {
        try {
            deps.state.armCompactionSkip(input.sessionID)
            deps.logger.debug("Armed DTC skip for the native compaction input", {
                sessionId: input.sessionID,
            })
        } catch (error) {
            deps.logger.warn("Failed to arm the compaction skip; native compaction continues", {
                sessionId: input.sessionID,
                error: error instanceof Error ? error.message : String(error),
            })
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
