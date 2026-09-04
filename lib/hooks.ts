import type { PluginConfig } from "./config"
import type { Logger } from "./logger"
import type { OpenCodeClient } from "./opencode-client"
import { projectMessages } from "./dtc/engine"
import type { DtcState } from "./dtc/state"
import type { MessageLike } from "./dtc/types"
import { canCommitMessages, inputBudgetFor, modelFor, sessionIDFor } from "./request"
import { eventSessionID } from "./session-events"

interface StateDeps {
    state: DtcState
    logger: Logger
}

function safeLog(write: () => unknown): void {
    try {
        void Promise.resolve(write()).catch(() => undefined)
    } catch {
        // Diagnostics cannot change whether a request is projected.
    }
}

/** The verified host calls compacting immediately before the summary transform. */
export function createSessionCompactingHandler(deps: StateDeps) {
    return async (input: { sessionID: string }, _output?: unknown): Promise<void> => {
        const wasBlocked = deps.state.projectionBlockReason()
        deps.state.armCompactionSkip(input.sessionID)
        const reason = deps.state.projectionBlockReason()
        if (!wasBlocked && reason) {
            safeLog(() =>
                deps.logger.warn("DCP projection disabled until plugin restart", { reason }),
            )
        }
    }
}

/**
 * An empty/unidentified summary history cannot consume the skip. The later
 * compaction params call clears it without observing or changing model options.
 * If the host aborts before both hooks, the next identified transform skips once
 * and clears the flag; this loses no information and does not persist a mode.
 */
export function createChatParamsHandler(deps: StateDeps) {
    return async (
        input: { sessionID: string; agent?: string },
        _output?: unknown,
    ): Promise<void> => {
        if (input.agent === "compaction") deps.state.clearCompactionSkip(input.sessionID)
    }
}

export interface TransformHandlerDeps extends StateDeps {
    client: OpenCodeClient
    config: PluginConfig["dtc"]
}

/** Build a private projection, then commit only to prevalidated ordinary slots. */
export function createTransformHandler(deps: TransformHandlerDeps) {
    const skip = (reason: string): void => {
        safeLog(() => deps.logger.debug("DCP request projection skipped", { reason }))
    }
    return async (_input: unknown, output: { messages: unknown[] }): Promise<void> => {
        try {
            const blockedReason = deps.state.projectionBlockReason()
            if (blockedReason) return skip(blockedReason)
            const messages = output?.messages
            if (!canCommitMessages(messages)) return skip("unsupported-array")
            if (messages.length === 0) return skip("empty-history")
            const sessionID = sessionIDFor(messages)
            if (!sessionID) return skip("unidentified-session")
            if (deps.state.consumeCompactionSkip(sessionID)) return skip("native-compaction")
            const force = deps.state.consumeFold(sessionID)
            const model = modelFor(messages)
            if (!model) return skip("unknown-model")
            const inputBudget = await inputBudgetFor(deps.client, model)
            if (inputBudget === undefined) return skip("unavailable-budget")
            // Provider lookup yields control. Recheck writable slots before any
            // work, and reject a host replacement of the request in the meantime.
            const currentBlockReason = deps.state.projectionBlockReason()
            if (currentBlockReason) return skip(currentBlockReason)
            if (output.messages !== messages || !canCommitMessages(messages))
                return skip("request-changed")
            if (sessionIDFor(messages) !== sessionID) return skip("request-changed")
            const currentModel = modelFor(messages)
            if (
                currentModel?.providerID !== model.providerID ||
                currentModel?.modelID !== model.modelID
            )
                return skip("model-changed")
            const projection = projectMessages(messages as MessageLike[], {
                inputBudget,
                config: deps.config,
                force,
            })
            if (projection.messages.length !== messages.length) return skip("invalid-projection")
            if (output.messages !== messages || !canCommitMessages(messages))
                return skip("request-changed")
            // The host keeps its original array reference; assigning output.messages
            // would be ignored. No getters, proxies, holes or readonly slots remain.
            for (let index = 0; index < messages.length; index++) {
                messages[index] = projection.messages[index]
            }
            safeLog(() =>
                deps.logger.debug("DCP request projection", {
                    sessionId: sessionID,
                    ...projection.stats,
                }),
            )
        } catch (error) {
            safeLog(() =>
                deps.logger.warn("DCP projection failed; original request retained", {
                    error: error instanceof Error ? error.message : String(error),
                }),
            )
        }
    }
}

export function createEventHandler(deps: StateDeps) {
    return async (input: { event: { type: string; properties?: Record<string, any> } }) => {
        if (input.event.type !== "session.deleted") return
        const sessionID = eventSessionID(input.event.properties)
        if (sessionID) deps.state.dropSession(sessionID)
    }
}
