import type { SessionState, ToolStatus, WithParts } from "./index"
import type { Logger } from "../logger"
import { PluginConfig } from "../config"
import { isMessageCompacted } from "./utils"
import { countToolTokens } from "../token-utils"

const MAX_TOOL_CACHE_SIZE = 1000

/**
 * Sync tool parameters from session messages.
 */
export function syncToolCache(
    state: SessionState,
    config: PluginConfig,
    logger: Logger,
    messages: WithParts[],
): void {
    try {
        logger.info("Syncing tool parameters from OpenCode messages")

        let turnCounter = 0
        const candidates = new Map<
            string,
            { part: Extract<WithParts["parts"][number], { type: "tool" }>; turn: number }
        >()

        for (const msg of messages) {
            if (isMessageCompacted(state, msg)) {
                continue
            }

            const parts = Array.isArray(msg.parts) ? msg.parts : []
            for (const part of parts) {
                if (part.type === "step-start") {
                    turnCounter++
                    continue
                }

                if (part.type !== "tool" || !part.callID) {
                    continue
                }

                candidates.delete(part.callID)
                candidates.set(part.callID, { part, turn: turnCounter })
            }
        }

        const recentCandidates = Array.from(candidates.entries())
            .filter(([, candidate]) => {
                const turnProtectionEnabled = config.turnProtection.enabled
                const turnProtectionTurns = config.turnProtection.turns
                return !(
                    turnProtectionEnabled &&
                    turnProtectionTurns > 0 &&
                    state.currentTurn - candidate.turn < turnProtectionTurns
                )
            })
            .slice(-MAX_TOOL_CACHE_SIZE)
        const retainedIds = new Set(recentCandidates.map(([callId]) => callId))

        for (const callId of state.toolParameters.keys()) {
            if (!retainedIds.has(callId)) state.toolParameters.delete(callId)
        }

        for (const [callId, { part, turn }] of recentCandidates) {
            const status = part.state.status as ToolStatus | undefined
            const cached = state.toolParameters.get(callId)
            if (cached?.status === status) continue

            const tokenCount = countToolTokens(part)
            state.toolParameters.set(callId, {
                tool: part.tool,
                parameters: part.state?.input ?? {},
                status,
                error: part.state.status === "error" ? part.state.error : undefined,
                turn,
                tokenCount,
            })
            if (!cached) {
                logger.info(
                    `Cached tool id: ${callId} (turn ${turn}${tokenCount !== undefined ? `, ${tokenCount} tokens` : ""})`,
                )
            }
        }

        logger.info(
            `Synced cache - size: ${state.toolParameters.size}, currentTurn: ${state.currentTurn}`,
        )
        trimToolParametersCache(state)
    } catch (error) {
        logger.warn("Failed to sync tool parameters from OpenCode", {
            error: error instanceof Error ? error.message : String(error),
        })
    }
}

/**
 * Trim the tool parameters cache to prevent unbounded memory growth.
 * Uses FIFO eviction - removes oldest entries first.
 */
export function trimToolParametersCache(state: SessionState): void {
    if (state.toolParameters.size <= MAX_TOOL_CACHE_SIZE) {
        return
    }

    const keysToRemove = Array.from(state.toolParameters.keys()).slice(
        0,
        state.toolParameters.size - MAX_TOOL_CACHE_SIZE,
    )

    for (const key of keysToRemove) {
        state.toolParameters.delete(key)
    }
}
