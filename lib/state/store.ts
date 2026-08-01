import type { CompressionTimingState } from "../compress/timing"
import type { SessionState, WithParts } from "./types"

const MAX_RESIDENT_SESSIONS = 64
const MAX_MESSAGE_OWNERS = 20_000
const MAX_TIMING_ENTRIES = 2048
const TIMING_TTL_MS = 30 * 60 * 1000

interface TimedStart {
    startedAt: number
    recordedAt: number
}

interface TimedPending {
    messageId: string
    callId: string
    durationMs: number
    recordedAt: number
}

/**
 * Keeps mutable plugin state isolated per OpenCode session.
 *
 * OpenCode creates one plugin instance per workspace, not per chat session. Every
 * hook must therefore resolve its own SessionState through this store.
 */
export class SessionStateStore {
    private readonly states = new Map<string, SessionState>()
    private readonly initializationQueues = new Map<string, Promise<void>>()
    private readonly messageOwners = new Map<string, string>()
    private readonly orphanStarts = new Map<string, TimedStart>()
    private readonly orphanPending = new Map<string, TimedPending>()

    constructor(private readonly createState: () => SessionState) {}

    get(sessionId: string): SessionState {
        const existing = this.states.get(sessionId)
        if (existing) {
            this.touch(sessionId, existing)
            return existing
        }

        const state = this.createState()
        this.states.set(sessionId, state)
        this.trimSessions()
        return state
    }

    peek(sessionId: string): SessionState | undefined {
        return this.states.get(sessionId)
    }

    async initialize(
        sessionId: string,
        initializer: (state: SessionState) => Promise<void>,
    ): Promise<SessionState> {
        const state = this.get(sessionId)
        const previous = this.initializationQueues.get(sessionId) ?? Promise.resolve()
        const current = previous.catch(() => undefined).then(() => initializer(state))
        this.initializationQueues.set(sessionId, current)

        try {
            await current
        } finally {
            if (this.initializationQueues.get(sessionId) === current) {
                this.initializationQueues.delete(sessionId)
            }
        }

        return state
    }

    registerMessages(sessionId: string, messages: WithParts[]): SessionState {
        const state = this.get(sessionId)
        for (const message of messages) {
            const messageId = message.info?.id
            if (typeof messageId !== "string") continue
            this.messageOwners.delete(messageId)
            this.messageOwners.set(messageId, sessionId)
            this.moveOrphanTiming(messageId, state.compressionTiming)
        }
        while (this.messageOwners.size > MAX_MESSAGE_OWNERS) {
            const oldest = this.messageOwners.keys().next().value
            if (typeof oldest !== "string") break
            this.messageOwners.delete(oldest)
        }
        return state
    }

    resolveEventState(sessionId: string | undefined, messageId: string): SessionState | undefined {
        const resolvedSessionId = sessionId ?? this.messageOwners.get(messageId)
        if (!resolvedSessionId) return undefined
        this.messageOwners.set(messageId, resolvedSessionId)
        return this.get(resolvedSessionId)
    }

    recordOrphanStart(key: string, startedAt: number): void {
        this.pruneOrphanTiming()
        if (this.orphanStarts.has(key)) return
        this.orphanStarts.set(key, { startedAt, recordedAt: Date.now() })
        this.trimMap(this.orphanStarts)
    }

    consumeOrphanStart(key: string): number | undefined {
        const entry = this.orphanStarts.get(key)
        this.orphanStarts.delete(key)
        return entry?.startedAt
    }

    recordOrphanPending(
        key: string,
        entry: { messageId: string; callId: string; durationMs: number },
    ): void {
        this.pruneOrphanTiming()
        this.orphanPending.set(key, { ...entry, recordedAt: Date.now() })
        this.trimMap(this.orphanPending)
    }

    deleteOrphanStart(key: string): void {
        this.orphanStarts.delete(key)
    }

    private moveOrphanTiming(messageId: string, timing: CompressionTimingState): void {
        const prefix = `${messageId}:`
        for (const [key, entry] of this.orphanStarts) {
            if (!key.startsWith(prefix)) continue
            if (!timing.startsByCallId.has(key)) {
                timing.startsByCallId.set(key, entry.startedAt)
            }
            timing.recordedAtByCallId.set(key, entry.recordedAt)
            this.orphanStarts.delete(key)
        }
        for (const [key, entry] of this.orphanPending) {
            if (!key.startsWith(prefix)) continue
            timing.pendingByCallId.set(key, {
                messageId: entry.messageId,
                callId: entry.callId,
                durationMs: entry.durationMs,
            })
            timing.recordedAtByCallId.set(key, entry.recordedAt)
            this.orphanPending.delete(key)
        }
    }

    private touch(sessionId: string, state: SessionState): void {
        this.states.delete(sessionId)
        this.states.set(sessionId, state)
    }

    private trimSessions(): void {
        while (this.states.size > MAX_RESIDENT_SESSIONS) {
            const oldest = Array.from(this.states.keys()).find(
                (sessionId) => !this.initializationQueues.has(sessionId),
            )
            if (!oldest) return
            this.states.delete(oldest)
            for (const [messageId, owner] of this.messageOwners) {
                if (owner === oldest) this.messageOwners.delete(messageId)
            }
        }
    }

    private pruneOrphanTiming(): void {
        const cutoff = Date.now() - TIMING_TTL_MS
        for (const [key, entry] of this.orphanStarts) {
            if (entry.recordedAt < cutoff) this.orphanStarts.delete(key)
        }
        for (const [key, entry] of this.orphanPending) {
            if (entry.recordedAt < cutoff) this.orphanPending.delete(key)
        }
    }

    private trimMap<T>(map: Map<string, T>): void {
        while (map.size > MAX_TIMING_ENTRIES) {
            const oldest = map.keys().next().value
            if (typeof oldest !== "string") return
            map.delete(oldest)
        }
    }
}

export type SessionStateTarget = SessionState | SessionStateStore

export function resolveSessionState(target: SessionStateTarget, sessionId: string): SessionState {
    return target instanceof SessionStateStore ? target.get(sessionId) : target
}
