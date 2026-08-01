/**
 * State persistence module for DCP plugin.
 * Persists pruned tool IDs across sessions so they survive OpenCode restarts.
 * Storage location: ~/.local/share/opencode/storage/plugin/dcp/{sessionId}.json
 */

import * as fs from "fs/promises"
import { existsSync } from "fs"
import { randomUUID } from "crypto"
import { homedir } from "os"
import { join } from "path"
import type { CompressionBlock, PrunedMessageEntry, SessionState, SessionStats } from "./types"
import type { Logger } from "../logger"
import { serializePruneMessagesState } from "./utils"
import { runWithConcurrency } from "../concurrency"

/** Prune state as stored on disk */
export interface PersistedPruneMessagesState {
    byMessageId: Record<string, PrunedMessageEntry>
    blocksById: Record<string, CompressionBlock>
    activeBlockIds: number[]
    activeByAnchorMessageId: Record<string, number>
    nextBlockId: number
    nextRunId: number
}

export interface PersistedPrune {
    tools?: Record<string, number>
    messages?: PersistedPruneMessagesState
}

export interface PersistedNudges {
    contextLimitAnchors: string[]
    turnNudgeAnchors?: string[]
    iterationNudgeAnchors?: string[]
}

export interface PersistedMessageIdState {
    byRawId: Record<string, string>
    byRef: Record<string, string>
    nextRef: number
}

export interface PersistedSessionState {
    sessionName?: string
    manualMode?: boolean
    prune: PersistedPrune
    nudges: PersistedNudges
    stats: SessionStats
    lastUpdated: string
    lastCompaction?: number
    messageIds?: PersistedMessageIdState
}

const saveQueues = new Map<string, Promise<void>>()

function getStorageDir(): string {
    return join(
        process.env.XDG_DATA_HOME || join(homedir(), ".local", "share"),
        "opencode",
        "storage",
        "plugin",
        "dcp",
    )
}

async function ensureStorageDir(): Promise<void> {
    const storageDir = getStorageDir()
    if (!existsSync(storageDir)) {
        await fs.mkdir(storageDir, { recursive: true })
    }
}

function getSessionFilePath(sessionId: string): string {
    return join(getStorageDir(), `${sessionId}.json`)
}

async function writePersistedSessionState(
    sessionId: string,
    state: PersistedSessionState,
    logger: Logger,
): Promise<void> {
    await ensureStorageDir()

    const filePath = getSessionFilePath(sessionId)
    const temporaryPath = `${filePath}.${process.pid}.${randomUUID()}.tmp`
    const content = JSON.stringify(state, null, 2)
    try {
        await fs.writeFile(temporaryPath, content, "utf-8")
        await fs.rename(temporaryPath, filePath)
    } catch (error) {
        await fs.unlink(temporaryPath).catch(() => undefined)
        throw error
    }

    logger.info("Saved session state to disk", {
        sessionId,
        totalTokensSaved: state.stats.totalPruneTokens,
    })
}

export async function saveSessionState(
    sessionState: SessionState,
    logger: Logger,
    sessionName?: string,
): Promise<void> {
    if (!sessionState.sessionId) {
        return
    }

    const sessionId = sessionState.sessionId
    const state: PersistedSessionState = {
        sessionName: sessionName,
        manualMode: !!sessionState.manualMode,
        prune: {
            tools: Object.fromEntries(sessionState.prune.tools),
            messages: serializePruneMessagesState(sessionState.prune.messages),
        },
        nudges: {
            contextLimitAnchors: Array.from(sessionState.nudges.contextLimitAnchors),
            turnNudgeAnchors: Array.from(sessionState.nudges.turnNudgeAnchors),
            iterationNudgeAnchors: Array.from(sessionState.nudges.iterationNudgeAnchors),
        },
        stats: { ...sessionState.stats },
        lastUpdated: new Date().toISOString(),
        lastCompaction: sessionState.lastCompaction,
        messageIds: {
            byRawId: Object.fromEntries(sessionState.messageIds.byRawId),
            byRef: Object.fromEntries(sessionState.messageIds.byRef),
            nextRef: sessionState.messageIds.nextRef,
        },
    }
    const previous = saveQueues.get(sessionId) ?? Promise.resolve()
    const current = previous
        .catch(() => undefined)
        .then(() => writePersistedSessionState(sessionId, state, logger))
    saveQueues.set(sessionId, current)

    try {
        await current
    } catch (error: any) {
        logger.error("Failed to save session state", {
            sessionId,
            error: error?.message,
        })
        throw error
    } finally {
        if (saveQueues.get(sessionId) === current) {
            saveQueues.delete(sessionId)
        }
    }
}

export async function loadSessionState(
    sessionId: string,
    logger: Logger,
): Promise<PersistedSessionState | null> {
    try {
        const filePath = getSessionFilePath(sessionId)

        if (!existsSync(filePath)) {
            return null
        }

        const content = await fs.readFile(filePath, "utf-8")
        const state = JSON.parse(content) as PersistedSessionState

        const hasPruneTools = state?.prune?.tools && typeof state.prune.tools === "object"
        const hasPruneMessages = state?.prune?.messages && typeof state.prune.messages === "object"
        const hasNudgeFormat = state?.nudges && typeof state.nudges === "object"
        if (
            !state ||
            !state.prune ||
            !hasPruneTools ||
            !hasPruneMessages ||
            !state.stats ||
            !hasNudgeFormat
        ) {
            logger.warn("Invalid session state file, ignoring", {
                sessionId: sessionId,
            })
            return null
        }

        const rawContextLimitAnchors = Array.isArray(state.nudges.contextLimitAnchors)
            ? state.nudges.contextLimitAnchors
            : []
        const validAnchors = rawContextLimitAnchors.filter(
            (entry): entry is string => typeof entry === "string",
        )
        const dedupedAnchors = [...new Set(validAnchors)]
        if (validAnchors.length !== rawContextLimitAnchors.length) {
            logger.warn("Filtered out malformed contextLimitAnchors entries", {
                sessionId: sessionId,
                original: rawContextLimitAnchors.length,
                valid: validAnchors.length,
            })
        }
        state.nudges.contextLimitAnchors = dedupedAnchors

        const rawTurnNudgeAnchors = Array.isArray(state.nudges.turnNudgeAnchors)
            ? state.nudges.turnNudgeAnchors
            : []
        const validSoftAnchors = rawTurnNudgeAnchors.filter(
            (entry): entry is string => typeof entry === "string",
        )
        const dedupedSoftAnchors = [...new Set(validSoftAnchors)]
        if (validSoftAnchors.length !== rawTurnNudgeAnchors.length) {
            logger.warn("Filtered out malformed turnNudgeAnchors entries", {
                sessionId: sessionId,
                original: rawTurnNudgeAnchors.length,
                valid: validSoftAnchors.length,
            })
        }
        state.nudges.turnNudgeAnchors = dedupedSoftAnchors

        const rawIterationNudgeAnchors = Array.isArray(state.nudges.iterationNudgeAnchors)
            ? state.nudges.iterationNudgeAnchors
            : []
        const validIterationAnchors = rawIterationNudgeAnchors.filter(
            (entry): entry is string => typeof entry === "string",
        )
        const dedupedIterationAnchors = [...new Set(validIterationAnchors)]
        if (validIterationAnchors.length !== rawIterationNudgeAnchors.length) {
            logger.warn("Filtered out malformed iterationNudgeAnchors entries", {
                sessionId: sessionId,
                original: rawIterationNudgeAnchors.length,
                valid: validIterationAnchors.length,
            })
        }
        state.nudges.iterationNudgeAnchors = dedupedIterationAnchors

        logger.info("Loaded session state from disk", {
            sessionId: sessionId,
        })

        return state
    } catch (error: any) {
        logger.warn("Failed to load session state", {
            sessionId: sessionId,
            error: error?.message,
        })
        return null
    }
}

export interface AggregatedStats {
    totalTokens: number
    totalTools: number
    totalMessages: number
    sessionCount: number
}

export async function loadAllSessionStats(logger: Logger): Promise<AggregatedStats> {
    const result: AggregatedStats = {
        totalTokens: 0,
        totalTools: 0,
        totalMessages: 0,
        sessionCount: 0,
    }

    try {
        const storageDir = getStorageDir()
        if (!existsSync(storageDir)) {
            return result
        }

        const files = await fs.readdir(storageDir)
        const jsonFiles = files.filter((f) => f.endsWith(".json"))

        await runWithConcurrency(jsonFiles, 16, async (file) => {
            try {
                const filePath = join(storageDir, file)
                const content = await fs.readFile(filePath, "utf-8")
                const state = JSON.parse(content) as PersistedSessionState

                if (state?.stats?.totalPruneTokens && state?.prune) {
                    result.totalTokens += state.stats.totalPruneTokens
                    result.totalTools += state.prune.tools
                        ? Object.keys(state.prune.tools).length
                        : 0
                    result.totalMessages += state.prune.messages?.byMessageId
                        ? Object.keys(state.prune.messages.byMessageId).length
                        : 0
                    result.sessionCount++
                }
            } catch {
                // Skip invalid files
            }
        })

        logger.debug("Loaded all-time stats", result)
    } catch (error: any) {
        logger.warn("Failed to load all-time stats", { error: error?.message })
    }

    return result
}
