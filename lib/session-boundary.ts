import type { Logger } from "./logger"

/**
 * Per-session boundary phase. The compression boundary is NOT the raw
 * `session.idle` instant: an idle observation opens a quiet window, and only
 * a window that survives its full duration plus a live status probe is
 * classified as AT-REST. Busy/retry evidence at any point cancels the window.
 */
export type BoundaryPhase = "unknown" | "busy" | "pending-rest" | "at-rest"

/** Why an at-rest classification fired. `probe-failopen` covers a missing
 * endpoint, an HTTP error, and a timed-out probe — all fail open. */
export type RestFireReason = "window-expired" | "probe-failopen"

export type AtRestListener = (sessionID: string, reason: RestFireReason) => void | Promise<void>

/** Internal constants — deliberately NOT config: safety semantics, not user
 * preference (design ADR-0004). Clock and timers are injectable for tests. */
export const BOUNDARY_QUIET_MS = 2_000
export const PROBE_TIMEOUT_MS = 2_000
// Busy evidence that never got its matching idle must not wedge the session
// forever; after this long it decays back to "unknown" (fail-open).
const BUSY_EVIDENCE_TTL_MS = 10 * 60_000
const MAX_TRACKED_SESSIONS = 500

export interface SessionBoundaryDeps {
    /** THE single busy probe (PruneService.probeBusy), injected — never
     * imported, so this module never depends on prune-service. */
    probeBusy: (sessionID: string) => Promise<boolean | null>
    logger: Logger
    now?: () => number
    setTimer?: (fn: () => void, ms: number) => unknown
    clearTimer?: (t: unknown) => void
}

interface SessionEntry {
    phase: BoundaryPhase
    /** Bumped on every cancel/re-arm so an in-flight expiry probe result that
     * predates a canceling event is discarded (probe-in-flight guard). */
    generation: number
    timer?: unknown
    busyAt?: number
    /** Whether any `session.status` observation ever arrived for this session.
     * Hosts that never send status events run in T3 degrade mode where every
     * turn-end legacy idle re-arms the boundary from at-rest. */
    sawStatus: boolean
}

/**
 * Classifies turn boundaries as AT-REST or relay-idle. Owns the ONLY
 * per-session busy/idle event state machine (it absorbed the former
 * SessionActivityTracker): exactly one entry per session, LRU-bounded.
 *
 * State model per session:
 * - unknown            no evidence (fresh, TTL-decayed, or post-lifecycle); fail-open
 * - busy               busy/retry evidence cached; TTL-decays to unknown
 * - pending-rest       quiet window armed (BOUNDARY_QUIET_MS); busy/retry cancels
 * - at-rest            rest confirmed; onAtRest fired once
 *
 * Idle handling: `pending-rest` + idle -> ignore (dual-publish second leg).
 * `at-rest` + idle -> ignore on status-capable hosts (T1/T2: a real next turn
 * is preceded by a busy/retry status that exits at-rest first). In degrade
 * mode (T3: no status observation ever received) a legacy idle from at-rest
 * RE-ARMS the window — every turn-end idle is a new boundary candidate.
 */
export class SessionBoundaryTracker {
    private readonly sessions = new Map<string, SessionEntry>()
    private readonly listeners: AtRestListener[] = []
    private readonly probeBusy: (sessionID: string) => Promise<boolean | null>
    private readonly logger: Logger
    private readonly now: () => number
    private readonly setTimer: (fn: () => void, ms: number) => unknown
    private readonly clearTimer: (t: unknown) => void

    constructor(deps: SessionBoundaryDeps) {
        this.probeBusy = deps.probeBusy
        this.logger = deps.logger
        this.now = deps.now ?? Date.now
        this.setTimer = deps.setTimer ?? ((fn, ms) => setTimeout(fn, ms))
        this.clearTimer =
            deps.clearTimer ?? ((t) => clearTimeout(t as ReturnType<typeof setTimeout>))
    }

    /** Register an at-rest listener; listeners fire in registration order
     * (1. deferred drain, 2. heuristic auto prune) and are individually
     * error-isolated: a throw or rejection is warn-logged and never blocks
     * later listeners nor escapes into the timer callback. */
    onAtRest(listener: AtRestListener): void {
        this.listeners.push(listener)
    }

    /** Primary input: `session.status` event payload status type. */
    observeStatus(sessionID: string | undefined, statusType: unknown): void {
        if (!sessionID) return
        const entry = this.entry(sessionID)
        entry.sawStatus = true
        if (statusType === "busy" || statusType === "retry") {
            this.transition(
                sessionID,
                entry,
                "busy",
                statusType === "retry" ? "retry-observed" : "busy-observed",
            )
            return
        }
        if (statusType === "idle") {
            this.observeIdle(sessionID, entry, "status")
        }
    }

    /** First-class input: legacy `session.idle`. Absorbed by dedup on hosts
     * that dual-publish; the only boundary signal on status-less hosts (T3). */
    observeLegacyIdle(sessionID: string | undefined): void {
        if (!sessionID) return
        this.observeIdle(sessionID, this.entry(sessionID), "legacy-idle")
    }

    /** Lifecycle: cancel any pending window and forget the session. */
    observeDeleted(sessionID: string | undefined): void {
        if (!sessionID) return
        const entry = this.sessions.get(sessionID)
        if (!entry) return
        this.cancelWindow(entry)
        this.sessions.delete(sessionID)
        this.logger.debug("Boundary session dropped", { sessionId: sessionID, reason: "deleted" })
    }

    /** Lifecycle: compaction ended; reset to unknown so the next idle opens a
     * fresh window. */
    observeCompacted(sessionID: string | undefined): void {
        if (!sessionID) return
        const entry = this.sessions.get(sessionID)
        if (!entry) return
        const from = entry.phase
        this.cancelWindow(entry)
        entry.phase = "unknown"
        delete entry.busyAt
        this.logger.debug("Boundary transition", {
            sessionId: sessionID,
            from,
            to: "unknown",
            reason: "compacted",
        })
    }

    /** Absorbed busy-evidence cache: `busy` decays to `unknown` after the TTL;
     * the table is LRU-bounded (pending-rest/at-rest entries have no TTL exit
     * and rely on the cap). */
    state(sessionID: string): BoundaryPhase {
        const entry = this.sessions.get(sessionID)
        if (!entry) return "unknown"
        if (
            entry.phase === "busy" &&
            entry.busyAt !== undefined &&
            this.now() - entry.busyAt > BUSY_EVIDENCE_TTL_MS
        ) {
            return "unknown"
        }
        return entry.phase
    }

    dispose(sessionID: string): void {
        this.observeDeleted(sessionID)
    }

    private observeIdle(
        sessionID: string,
        entry: SessionEntry,
        source: "status" | "legacy-idle",
    ): void {
        if (entry.phase === "pending-rest") {
            this.logger.debug("Boundary duplicate idle ignored", { sessionId: sessionID, source })
            return
        }
        if (entry.phase === "at-rest") {
            if (source === "legacy-idle" && !entry.sawStatus) {
                // T3 degrade re-arm: without status events this idle is the
                // next turn's boundary, not a duplicate second leg.
                this.armWindow(sessionID, entry, "degrade-rearm")
            } else {
                this.logger.debug("Boundary duplicate idle ignored", {
                    sessionId: sessionID,
                    source,
                })
            }
            return
        }
        this.armWindow(sessionID, entry, "idle-observed")
    }

    private armWindow(sessionID: string, entry: SessionEntry, reason: string): void {
        this.cancelWindow(entry)
        entry.phase = "pending-rest"
        entry.timer = this.setTimer(() => {
            entry.timer = undefined
            void this.onWindowExpiry(sessionID, entry)
        }, BOUNDARY_QUIET_MS)
        this.refresh(sessionID, entry)
        this.logger.debug("Boundary quiet window armed", {
            sessionId: sessionID,
            reason,
            generation: entry.generation,
        })
    }

    private async onWindowExpiry(sessionID: string, entry: SessionEntry): Promise<void> {
        if (entry.phase !== "pending-rest") return
        const generation = entry.generation
        let busy: boolean | null
        try {
            busy = await this.probeBusy(sessionID)
        } catch {
            busy = null
        }
        // Probe-in-flight guard: a busy/retry/deleted event that arrived while
        // the probe was awaited bumped the generation or moved the phase — a
        // stale result must never fire. An entry that was LRU-evicted mid-flight
        // is equally stale (identity check).
        if (
            entry.phase !== "pending-rest" ||
            entry.generation !== generation ||
            this.sessions.get(sessionID) !== entry
        ) {
            this.logger.debug("Boundary probe result discarded", {
                sessionId: sessionID,
                generation,
            })
            return
        }
        if (busy === true) {
            this.transition(sessionID, entry, "busy", "probe-busy")
            return
        }
        const reason: RestFireReason = busy === false ? "window-expired" : "probe-failopen"
        const from = entry.phase
        entry.phase = "at-rest"
        this.refresh(sessionID, entry)
        this.logger.debug("Boundary transition", {
            sessionId: sessionID,
            from,
            to: "at-rest",
            reason,
        })
        this.fireAtRest(sessionID, reason)
    }

    private transition(
        sessionID: string,
        entry: SessionEntry,
        phase: "busy" | "unknown",
        reason: string,
    ): void {
        const from = entry.phase
        this.cancelWindow(entry)
        entry.phase = phase
        if (phase === "busy") entry.busyAt = this.now()
        else delete entry.busyAt
        this.refresh(sessionID, entry)
        this.logger.debug("Boundary transition", { sessionId: sessionID, from, to: phase, reason })
    }

    private cancelWindow(entry: SessionEntry): void {
        if (entry.timer !== undefined) {
            this.clearTimer(entry.timer)
            entry.timer = undefined
        }
        // Bump the generation so an in-flight expiry probe result is voided.
        entry.generation += 1
    }

    private fireAtRest(sessionID: string, reason: RestFireReason): void {
        for (const listener of this.listeners) {
            try {
                const result = listener(sessionID, reason)
                if (result instanceof Promise) {
                    result.catch((error) => {
                        this.logger.warn("At-rest listener rejected", {
                            sessionId: sessionID,
                            error: error instanceof Error ? error.message : String(error),
                        })
                    })
                }
            } catch (error) {
                this.logger.warn("At-rest listener failed", {
                    sessionId: sessionID,
                    error: error instanceof Error ? error.message : String(error),
                })
            }
        }
    }

    private entry(sessionID: string): SessionEntry {
        let entry = this.sessions.get(sessionID)
        if (!entry) {
            entry = { phase: "unknown", generation: 0, sawStatus: false }
            this.sessions.set(sessionID, entry)
            this.evictIfNeeded(sessionID)
            return entry
        }
        this.refresh(sessionID, entry)
        return entry
    }

    private refresh(sessionID: string, entry: SessionEntry): void {
        this.sessions.delete(sessionID)
        this.sessions.set(sessionID, entry)
        this.evictIfNeeded(sessionID)
    }

    private evictIfNeeded(kept: string): void {
        if (this.sessions.size <= MAX_TRACKED_SESSIONS) return
        const oldest = this.sessions.keys().next().value
        if (oldest === undefined || oldest === kept) return
        const victim = this.sessions.get(oldest)
        if (victim?.timer !== undefined) this.clearTimer(victim.timer)
        this.sessions.delete(oldest)
    }
}

/** Ceil a cooldown to whole seconds for user-facing copy. */
export function retrySeconds(retryAfterMs: number): number {
    return Math.ceil(retryAfterMs / 1000)
}

/**
 * Resolves the session ID from a host event's properties. Most events carry
 * `sessionID` directly, but some (e.g. `session.deleted`) only carry
 * `info: Session`. Returns `undefined` when neither is a non-empty string.
 */
export function eventSessionID(properties?: Record<string, any>): string | undefined {
    const direct = properties?.sessionID
    if (typeof direct === "string" && direct) return direct
    const info = properties?.info?.id
    if (typeof info === "string" && info) return info
    return undefined
}
