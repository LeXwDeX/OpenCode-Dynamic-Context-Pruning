/**
 * Per-session runtime state for the DTC engine. Everything here is
 * request-scoped or in-memory only — nothing is ever persisted, matching the
 * "no plugin checkpoint persistence" constraint. All maps are LRU-bounded.
 */

const SESSION_LIMIT = 500
const DIGEST_LIMIT = 2000

function lruSet<K, V>(map: Map<K, V>, key: K, value: V, limit: number): void {
    if (map.has(key)) map.delete(key)
    map.set(key, value)
    while (map.size > limit) {
        const oldest = map.keys().next().value
        if (oldest === undefined) break
        map.delete(oldest)
    }
}

interface SessionDtcState {
    /** Context window size learned from `chat.params` (tokens). */
    contextTokens?: number
    /**
     * One-shot skip flag: set by the compacting hook so the transform that
     * the host runs over the compaction input (fork compaction.ts fires
     * compacting at :373 and the transform at :380 in the same flow) never
     * folds content the summarizer needs at full fidelity.
     */
    skipNextTransform?: boolean
    /**
     * `dcp_prune` marks a topic boundary: folds deepen (minimum level) and
     * the current-task zone restarts at the first turn created after this
     * timestamp.
     */
    boundaryMarkAt?: number
    /** Manual severity bump from `dcp_prune` / `/dcp fold`. */
    minLevel?: number
}

export class DtcState {
    private readonly sessions = new Map<string, SessionDtcState>()
    private readonly digests = new Map<string, string>()

    observeContextLimit(sessionID: string, contextTokens: number | undefined): void {
        if (!sessionID || !contextTokens || !Number.isFinite(contextTokens) || contextTokens <= 0) {
            return
        }
        const state = this.session(sessionID)
        state.contextTokens = contextTokens
        lruSet(this.sessions, sessionID, state, SESSION_LIMIT)
    }

    contextTokens(sessionID: string): number | undefined {
        return this.sessions.get(sessionID)?.contextTokens
    }

    /** Called by the compacting hook; consumed by the very next transform. */
    armCompactionSkip(sessionID: string): void {
        const state = this.session(sessionID)
        state.skipNextTransform = true
        lruSet(this.sessions, sessionID, state, SESSION_LIMIT)
    }

    consumeCompactionSkip(sessionID: string): boolean {
        const state = this.sessions.get(sessionID)
        if (!state?.skipNextTransform) return false
        state.skipNextTransform = false
        return true
    }

    /** `dcp_prune` / `/dcp fold`: mark a boundary now and deepen folding. */
    markBoundary(sessionID: string, at: number, minLevel = 2): void {
        const state = this.session(sessionID)
        state.boundaryMarkAt = at
        state.minLevel = Math.max(state.minLevel ?? 0, minLevel)
        lruSet(this.sessions, sessionID, state, SESSION_LIMIT)
    }

    boundaryMark(sessionID: string): number | undefined {
        return this.sessions.get(sessionID)?.boundaryMarkAt
    }

    minLevel(sessionID: string): number {
        return this.sessions.get(sessionID)?.minLevel ?? 0
    }

    cachedDigest(key: string): string | undefined {
        return this.digests.get(key)
    }

    storeDigest(key: string, digest: string): void {
        lruSet(this.digests, key, digest, DIGEST_LIMIT)
    }

    dropSession(sessionID: string): void {
        this.sessions.delete(sessionID)
    }

    /** Test/inspection surface. */
    stats(): { sessions: number; digests: number } {
        return { sessions: this.sessions.size, digests: this.digests.size }
    }

    private session(sessionID: string): SessionDtcState {
        return this.sessions.get(sessionID) ?? {}
    }
}
