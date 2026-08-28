export type ActivityState = "busy" | "idle" | "unknown"

interface SessionActivity {
    state: Exclude<ActivityState, "unknown">
    at: number
}

// A busy status that never got its matching idle event must not wedge the
// session forever; after this long the state decays back to "unknown".
const BUSY_TTL_MS = 10 * 60_000
const MAX_TRACKED_SESSIONS = 500

/**
 * Tracks per-session busy/idle state from host events so compression can be
 * gated on real session activity instead of optimistic assumptions.
 *
 * State sources (in order of preference):
 * - `session.status` events carrying `{ status: { type: "busy" | "idle" } }`
 * - `session.idle` events (authoritative turn-boundary signal)
 *
 * Sessions with no observed events report "unknown"; callers decide what
 * fail-open means for their own trigger surface.
 */
export class SessionActivityTracker {
    private readonly sessions = new Map<string, SessionActivity>()
    private readonly now: () => number

    constructor(now?: () => number) {
        this.now = now ?? Date.now
    }

    observe(type: string, properties?: Record<string, any>): void {
        const sessionID = properties?.sessionID
        if (typeof sessionID !== "string" || !sessionID) return

        if (type === "session.status") {
            const status = properties?.status?.type
            // `retry` is an active turn between attempts — as far as a running
            // compaction is concerned it is exactly as busy as "busy".
            if (status === "busy" || status === "retry") this.set(sessionID, "busy")
            else if (status === "idle") this.set(sessionID, "idle")
            return
        }
        if (type === "session.idle") this.set(sessionID, "idle")
    }

    state(sessionID: string): ActivityState {
        const activity = this.sessions.get(sessionID)
        if (!activity) return "unknown"
        if (activity.state === "busy" && this.now() - activity.at > BUSY_TTL_MS) return "unknown"
        return activity.state
    }

    dropSession(sessionID: string): void {
        this.sessions.delete(sessionID)
    }

    private set(sessionID: string, state: "busy" | "idle"): void {
        if (this.sessions.has(sessionID)) this.sessions.delete(sessionID)
        this.sessions.set(sessionID, { state, at: this.now() })
        if (this.sessions.size > MAX_TRACKED_SESSIONS) {
            // The just-updated session is always the map's newest entry, so the
            // first key is always a victim.
            const oldest = this.sessions.keys().next().value
            if (oldest !== undefined) this.sessions.delete(oldest)
        }
    }
}
