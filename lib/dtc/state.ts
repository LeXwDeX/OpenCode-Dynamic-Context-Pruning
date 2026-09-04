const SESSION_LIMIT = 500

interface PendingRequest {
    compaction?: boolean
    fold?: boolean
}

/** Only pending one-shot controls live here; no history, identity or model cache. */
export class DtcState {
    private readonly sessions = new Map<string, PendingRequest>()
    private blockedReason: "compaction-guard-capacity" | undefined

    requestFold(sessionID: string): boolean {
        return this.mark(sessionID, "fold")
    }

    consumeFold(sessionID: string): boolean {
        return this.consume(sessionID, "fold")
    }

    armCompactionSkip(sessionID: string): void {
        this.mark(sessionID, "compaction")
    }

    consumeCompactionSkip(sessionID: string): boolean {
        return this.consume(sessionID, "compaction")
    }

    clearCompactionSkip(sessionID: string): void {
        this.consume(sessionID, "compaction")
    }

    dropSession(sessionID: string): void {
        this.sessions.delete(sessionID)
    }

    projectionBlockReason(): "compaction-guard-capacity" | undefined {
        return this.blockedReason
    }

    stats(): { sessions: number; blockedReason: "compaction-guard-capacity" | undefined } {
        return { sessions: this.sessions.size, blockedReason: this.blockedReason }
    }

    private mark(sessionID: string, key: keyof PendingRequest): boolean {
        if (!sessionID || this.blockedReason) return false
        if (!this.sessions.has(sessionID) && this.sessions.size === SESSION_LIMIT) {
            // Losing a forced request is safe; losing a summary guard is not.
            const evictable = [...this.sessions].find(([, pending]) => !pending.compaction)
            if (evictable) this.sessions.delete(evictable[0])
            else {
                // The unrecorded guard cannot be recovered by consuming other
                // entries. Keep projection disabled until this instance restarts.
                if (key === "compaction") this.blockedReason = "compaction-guard-capacity"
                return false
            }
        }
        const pending = this.sessions.get(sessionID) ?? {}
        pending[key] = true
        this.sessions.delete(sessionID)
        this.sessions.set(sessionID, pending)
        return true
    }

    private consume(sessionID: string, key: keyof PendingRequest): boolean {
        const pending = this.sessions.get(sessionID)
        if (!pending?.[key]) return false
        delete pending[key]
        if (!pending.compaction && !pending.fold) this.sessions.delete(sessionID)
        return true
    }
}
