import type { SessionState, ToolParameterEntry, WithParts } from "./types"
import type { Logger } from "../logger"
import { applyPendingCompressionDurations } from "../compress/timing"
import { loadSessionState, saveSessionState } from "./persistence"
import {
    isSubAgentSession,
    findLastCompactionTimestamp,
    countTurns,
    resetOnCompaction,
    createPruneMessagesState,
    loadPruneMessagesState,
    loadPruneMap,
    collectTurnNudgeAnchors,
} from "./utils"
import { getLastUserMessage } from "../messages/query"
import { SessionStateStore, type SessionStateTarget, resolveSessionState } from "./store"
import type { OpenCodeClient } from "../opencode-client"

export const checkSession = async (
    client: OpenCodeClient,
    target: SessionStateTarget,
    logger: Logger,
    messages: WithParts[],
    manualModeDefault: boolean,
): Promise<SessionState | undefined> => {
    const lastUserMessage = getLastUserMessage(messages)
    const lastSessionId =
        lastUserMessage?.info.sessionID ??
        messages.findLast((message) => typeof message.info?.sessionID === "string")?.info.sessionID
    if (!lastSessionId) return target instanceof SessionStateStore ? undefined : target
    const state =
        target instanceof SessionStateStore
            ? target.registerMessages(lastSessionId, messages)
            : resolveSessionState(target, lastSessionId)

    if (state.sessionId === null || state.sessionId !== lastSessionId) {
        logger.info(`Session changed: ${state.sessionId} -> ${lastSessionId}`)
        try {
            await initializeSessionState(
                client,
                target,
                lastSessionId,
                logger,
                messages,
                manualModeDefault,
            )
        } catch (err: any) {
            logger.error("Failed to initialize session state", { error: err.message })
        }
    }

    const lastCompactionTimestamp = findLastCompactionTimestamp(messages)
    if (lastCompactionTimestamp > state.lastCompaction) {
        state.lastCompaction = lastCompactionTimestamp
        resetOnCompaction(state, messages)
        logger.info("Detected compaction - reset stale state", {
            timestamp: lastCompactionTimestamp,
        })

        saveSessionState(state, logger).catch((error) => {
            logger.warn("Failed to persist state reset after compaction", {
                error: error instanceof Error ? error.message : String(error),
            })
        })
    }

    state.currentTurn = countTurns(state, messages)
    return state
}

export function createSessionState(): SessionState {
    return {
        sessionId: null,
        isSubAgent: false,
        manualMode: false,
        compressPermission: undefined,
        pendingManualTrigger: null,
        prune: {
            tools: new Map<string, number>(),
            messages: createPruneMessagesState(),
        },
        nudges: {
            contextLimitAnchors: new Set<string>(),
            turnNudgeAnchors: new Set<string>(),
            iterationNudgeAnchors: new Set<string>(),
        },
        stats: {
            pruneTokenCounter: 0,
            totalPruneTokens: 0,
        },
        compressionTiming: {
            startsByCallId: new Map<string, number>(),
            pendingByCallId: new Map(),
            recordedAtByCallId: new Map<string, number>(),
        },
        toolParameters: new Map<string, ToolParameterEntry>(),
        subAgentResultCache: new Map<string, string>(),
        toolIdList: [],
        messageIds: {
            byRawId: new Map<string, string>(),
            byRef: new Map<string, string>(),
            nextRef: 1,
        },
        lastCompaction: 0,
        currentTurn: 0,
        modelContextLimit: undefined,
        systemPromptTokens: undefined,
    }
}

export function resetSessionState(state: SessionState): void {
    const modelContextLimit = state.modelContextLimit
    state.sessionId = null
    state.isSubAgent = false
    state.manualMode = false
    state.compressPermission = undefined
    state.pendingManualTrigger = null
    state.prune = {
        tools: new Map<string, number>(),
        messages: createPruneMessagesState(),
    }
    state.nudges = {
        contextLimitAnchors: new Set<string>(),
        turnNudgeAnchors: new Set<string>(),
        iterationNudgeAnchors: new Set<string>(),
    }
    state.stats = {
        pruneTokenCounter: 0,
        totalPruneTokens: 0,
    }
    state.toolParameters.clear()
    state.subAgentResultCache.clear()
    state.toolIdList = []
    state.messageIds = {
        byRawId: new Map<string, string>(),
        byRef: new Map<string, string>(),
        nextRef: 1,
    }
    state.lastCompaction = 0
    state.currentTurn = 0
    state.modelContextLimit = modelContextLimit
    state.systemPromptTokens = undefined
}

export async function initializeSessionState(
    client: OpenCodeClient,
    target: SessionStateTarget,
    sessionId: string,
    logger: Logger,
    messages: WithParts[],
    manualModeEnabled: boolean,
): Promise<SessionState> {
    if (target instanceof SessionStateStore) {
        target.registerMessages(sessionId, messages)
        return target.initialize(sessionId, (state) =>
            ensureSessionInitialized(client, state, sessionId, logger, messages, manualModeEnabled),
        )
    }

    await ensureSessionInitialized(client, target, sessionId, logger, messages, manualModeEnabled)
    return target
}

export async function ensureSessionInitialized(
    client: OpenCodeClient,
    state: SessionState,
    sessionId: string,
    logger: Logger,
    messages: WithParts[],
    manualModeEnabled: boolean,
): Promise<void> {
    if (state.sessionId === sessionId) {
        return
    }

    // logger.info("session ID = " + sessionId)
    // logger.info("Initializing session state", { sessionId: sessionId })

    resetSessionState(state)
    state.manualMode = manualModeEnabled ? "active" : false
    state.sessionId = sessionId

    const isSubAgent = await isSubAgentSession(client, sessionId)
    state.isSubAgent = isSubAgent
    // logger.info("isSubAgent = " + isSubAgent)

    state.lastCompaction = findLastCompactionTimestamp(messages)
    state.currentTurn = countTurns(state, messages)
    state.nudges.turnNudgeAnchors = collectTurnNudgeAnchors(messages)

    const persisted = await loadSessionState(sessionId, logger)
    if (persisted === null) {
        return
    }

    if (typeof persisted.manualMode === "boolean") {
        state.manualMode = persisted.manualMode ? "active" : false
    }

    state.prune.tools = loadPruneMap(persisted.prune.tools)
    state.prune.messages = loadPruneMessagesState(persisted.prune.messages)
    state.nudges.contextLimitAnchors = new Set<string>(persisted.nudges.contextLimitAnchors || [])
    state.nudges.turnNudgeAnchors = new Set<string>([
        ...state.nudges.turnNudgeAnchors,
        ...(persisted.nudges.turnNudgeAnchors || []),
    ])
    state.nudges.iterationNudgeAnchors = new Set<string>(
        persisted.nudges.iterationNudgeAnchors || [],
    )
    state.stats = {
        pruneTokenCounter: persisted.stats?.pruneTokenCounter || 0,
        totalPruneTokens: persisted.stats?.totalPruneTokens || 0,
    }

    if (typeof persisted.lastCompaction === "number") {
        state.lastCompaction = Math.max(state.lastCompaction, persisted.lastCompaction)
    }
    if (persisted.messageIds && typeof persisted.messageIds === "object") {
        state.messageIds = {
            byRawId: new Map<string, string>(
                Object.entries(persisted.messageIds.byRawId || {}).filter(
                    (e): e is [string, string] => typeof e[1] === "string",
                ),
            ),
            byRef: new Map<string, string>(
                Object.entries(persisted.messageIds.byRef || {}).filter(
                    (e): e is [string, string] => typeof e[1] === "string",
                ),
            ),
            nextRef:
                typeof persisted.messageIds.nextRef === "number" &&
                persisted.messageIds.nextRef >= 1
                    ? persisted.messageIds.nextRef
                    : 1,
        }
    }

    const applied = applyPendingCompressionDurations(state)
    if (applied > 0) {
        await saveSessionState(state, logger)
    }
}
