import type { AutoPruneConfig } from "./config"
import type { Logger } from "./logger"
import type { OpenCodeClient } from "./opencode-client"
import type { PromptStore } from "./prompts/store"
import type { PruneSignal, AutoPruner } from "./auto-prune"
import type { PruneEventName, PruneService } from "./prune-service"
import { eventSessionID, retrySeconds } from "./prune-service"

interface CompactionOutput {
    context: string[]
    prompt?: string
}

export function createSessionCompactingHandler(prompts: PromptStore, logger: Logger) {
    return async (input: { sessionID: string }, output: CompactionOutput): Promise<void> => {
        try {
            prompts.reload()
            const prompt = prompts.getRuntimePrompts().compaction
            if (!output.prompt) {
                output.prompt = prompt
            } else if (!output.context.includes(prompt)) {
                output.context.push(prompt)
            }
            logger.debug("Applied semantic pruning prompt", { sessionId: input.sessionID })
        } catch (error) {
            logger.warn("Failed to apply semantic pruning prompt; native compaction continues", {
                sessionId: input.sessionID,
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

export function createChatMessageHandler(autoPruner: AutoPruner) {
    return async (input: { sessionID: string }, _output?: unknown): Promise<void> => {
        const parts = (_output as { parts?: unknown[] } | undefined)?.parts ?? []
        autoPruner.observeUserMessage(input.sessionID, parts)
    }
}

const SIGNAL_LABELS: Record<PruneSignal, string> = {
    "topic-drift": "话题变更",
    volume: "消息量达到阈值",
    "idle-gap": "长时间中断后恢复",
}

export interface EventHandlerDeps {
    client: OpenCodeClient
    prune: PruneService
    autoPruner: AutoPruner
    config: AutoPruneConfig
    logger: Logger
}

export function createEventHandler(deps: EventHandlerDeps) {
    async function triggerAutoPrune(sessionID: string, signals: PruneSignal[]): Promise<void> {
        const reason = signals.map((signal) => SIGNAL_LABELS[signal]).join("、")
        const result = await deps.prune.request({ sessionID, onBusy: "proceed" })

        // busy and no-model mean nothing was attempted this time. consumePending
        // has already cleared the signals, so this trigger is spent: there is
        // no retry at the next idle. New signals only arrive from later messages.
        const attempted =
            result.status === "succeeded" ||
            result.status === "failed" ||
            result.status === "cooldown"
        if (!attempted) {
            if (result.status === "busy") {
                await showToast(
                    deps.client,
                    "DCP 自动压缩",
                    `检测到${reason}，但会话正忙，本次已跳过；原始上下文保持不变。`,
                    "warning",
                )
            }
            deps.logger.debug("Auto prune skipped", {
                sessionId: sessionID,
                status: result.status,
            })
            return
        }
        deps.autoPruner.markPruned(sessionID)

        if (result.status === "succeeded") {
            await showToast(deps.client, "DCP 自动压缩", `检测到${reason}，已生成新的语义检查点。`)
        } else if (result.status === "cooldown") {
            await showToast(
                deps.client,
                "DCP 自动压缩",
                `检测到${reason}，但上一次压缩失败；${retrySeconds(result.retryAfterMs)} 秒后可重试。`,
                "warning",
            )
        } else {
            await showToast(
                deps.client,
                "DCP 自动压缩",
                `检测到${reason}，但压缩失败；原始上下文保持不变。`,
                "warning",
            )
        }
        deps.logger.debug("Auto prune finished", { sessionId: sessionID, status: result.status })
    }

    return async (input: { event: { type: string; properties?: Record<string, any> } }) => {
        const event = input.event
        const sessionID = eventSessionID(event.properties)
        if (!sessionID) return

        // Every event feeds the service first: it tracks session activity and
        // drains deferred prunes at the idle boundary. The `session.idle` event
        // is itself the authoritative turn-boundary evidence, so auto prune
        // relies on the service's busy re-check (after model resolution) to
        // stand down when a new turn races the trigger.
        try {
            deps.prune.observeEvent(event.type, event.properties)
            if (event.type === "session.idle") {
                if (!deps.config.enabled) return
                const signals = deps.autoPruner.consumePending(sessionID)
                if (signals) await triggerAutoPrune(sessionID, signals)
                return
            }
            if (event.type === "session.compacted") {
                deps.autoPruner.markPruned(sessionID)
                return
            }
            if (event.type === "session.deleted") {
                deps.autoPruner.dropSession(sessionID)
            }
        } catch (error) {
            deps.logger.warn("Event handler failed", {
                type: event.type,
                sessionId: sessionID,
                error: error instanceof Error ? error.message : String(error),
            })
        }
    }
}

export function createCommandExecuteHandler(
    client: OpenCodeClient,
    prune: PruneService,
    logger: Logger,
) {
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
        if (subcommand !== "summarize") {
            await showToast(
                client,
                "DCP",
                "Use /dcp summarize for semantic pruning, or OpenCode's native /compact command.",
            )
            throw new Error("__DCP_HELP_HANDLED__")
        }

        const result = await prune.request({ sessionID: input.sessionID, onBusy: "proceed" })
        if (result.status === "busy") {
            await showToast(
                client,
                "DCP summarize",
                "Session is busy; the prune will not interrupt the current turn. Try again once it finishes.",
                "warning",
            )
            throw new Error("__DCP_SUMMARIZE_HANDLED__")
        }
        if (result.status === "no-model") {
            await showToast(
                client,
                "DCP summarize",
                "No session model is available yet.",
                "warning",
            )
            throw new Error("__DCP_SUMMARIZE_NO_MODEL__")
        }
        if (result.status === "succeeded") {
            await showToast(client, "DCP summarize", "Semantic pruning checkpoint created.")
        } else if (result.status === "cooldown") {
            await showToast(
                client,
                "DCP summarize",
                `Previous attempt failed; retry in ${retrySeconds(result.retryAfterMs)}s.`,
                "warning",
            )
        } else {
            await showToast(
                client,
                "DCP summarize",
                "Native compaction failed; the original context was kept.",
                "error",
            )
        }
        logger.debug("Handled DCP summarize command", {
            sessionId: input.sessionID,
            status: result.status,
        })
        throw new Error("__DCP_SUMMARIZE_HANDLED__")
    }
}
