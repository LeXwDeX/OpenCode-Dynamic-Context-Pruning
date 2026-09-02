import type { Logger } from "./logger"
import type { OpenCodeClient } from "./opencode-client"
import { resolveSessionModel } from "./session-model"
import {
    PROBE_TIMEOUT_MS,
    SessionBoundaryTracker,
    eventSessionID,
    retrySeconds,
} from "./session-boundary"
import type { SummarizeCoordinator } from "./summarize"

export { eventSessionID, retrySeconds } from "./session-boundary"

/**
 * How a trigger surface wants the service to react when the session is (or may
 * be) mid-turn:
 * - `"defer"`: compaction must never interrupt a running turn. Queue the prune
 *   and execute it at the next confirmed at-rest boundary. Used by the
 *   model-invokable tool, which by definition executes mid-turn.
 * - `"proceed"`: fire at turn boundaries anyway; only stand down on positive
 *   busy evidence. Used by at-rest-driven auto prune and the manual command.
 */
export type PruneBusyPolicy = "defer" | "proceed"

export type PruneOutcome =
    | { status: "succeeded" }
    | { status: "deferred" }
    | { status: "busy" }
    | { status: "no-model" }
    | { status: "cooldown"; retryAfterMs: number }
    | { status: "failed"; error: string }

export interface PruneRequest {
    sessionID: string
    onBusy: PruneBusyPolicy
}

export interface PruneServiceDeps {
    client: OpenCodeClient
    summarize: SummarizeCoordinator
    logger: Logger
    /** Injectable clock/timers (tests). BOUNDARY_QUIET_MS stays a code constant. */
    now?: () => number
    setTimer?: (fn: () => void, ms: number) => unknown
    clearTimer?: (t: unknown) => void
    /** Injectable probe deadline (tests only; defaults to PROBE_TIMEOUT_MS). */
    probeTimeoutMs?: number
}

type Admission = { action: "go" } | { action: "defer" } | { action: "stand-down" }

/** Host event names this service derives safety decisions from. */
export type PruneEventName =
    | "session.idle"
    | "session.status"
    | "session.compacted"
    | "session.deleted"
    | (string & {})

/**
 * The single compression entry point. Every trigger surface (model tool,
 * heuristic auto prune, manual command) goes through `request`; the service
 * owns everything a caller must not have to know: session busy state, the
 * never-interrupt-a-running-turn invariant, deferral to the next confirmed
 * at-rest boundary, session model resolution, and delegation to the native
 * summarize coordinator (single-flight + failure cooldown).
 *
 * `request` never rejects: every failure mode is a `PruneOutcome`.
 */
export class PruneService {
    private readonly deferred = new Set<string>()
    private readonly client: OpenCodeClient
    private readonly summarize: SummarizeCoordinator
    private readonly logger: Logger
    private readonly probeTimeoutMs: number
    /** THE single busy/idle event state machine (absorbed the former
     * SessionActivityTracker — no second busy cache may exist). */
    readonly boundary: SessionBoundaryTracker

    constructor(deps: PruneServiceDeps) {
        this.client = deps.client
        this.summarize = deps.summarize
        this.logger = deps.logger
        this.probeTimeoutMs = deps.probeTimeoutMs ?? PROBE_TIMEOUT_MS
        this.boundary = new SessionBoundaryTracker({
            probeBusy: (sessionID) => this.probeBusy(sessionID),
            logger: deps.logger,
            now: deps.now,
            setTimer: deps.setTimer,
            clearTimer: deps.clearTimer,
        })
        // At-rest listener #1: drain deferred (tool) prunes at the confirmed
        // boundary. Registration order matters — the drain runs before the
        // heuristic auto-prune listener the plugin entry registers.
        this.boundary.onAtRest((sessionID) => {
            if (!this.deferred.delete(sessionID)) return
            void this.drainQueued(sessionID)
        })
    }

    /**
     * Feed every host event through here. `session.status` and legacy
     * `session.idle` feed the boundary tracker (quiet window + expiry probe);
     * the deferral queue drains at the confirmed at-rest classification, and
     * queued prunes are forgotten once a compaction (or the session itself)
     * is gone.
     */
    observeEvent(type: PruneEventName, properties?: Record<string, any>): void {
        const sessionID = eventSessionID(properties)
        if (type === "session.status") {
            this.boundary.observeStatus(sessionID, properties?.status?.type)
            return
        }
        if (type === "session.idle") {
            // Legacy first-class input: dual-published legs are absorbed by
            // the dedup; on status-less hosts it is the only boundary signal.
            this.boundary.observeLegacyIdle(sessionID)
            return
        }
        if (!sessionID) return
        if (type === "session.compacted") {
            this.deferred.delete(sessionID)
            this.boundary.observeCompacted(sessionID)
            return
        }
        if (type === "session.deleted") {
            this.deferred.delete(sessionID)
            this.boundary.observeDeleted(sessionID)
        }
    }

    async request(request: PruneRequest): Promise<PruneOutcome> {
        const beforeModel = await this.gate(request)
        if (beforeModel) return beforeModel

        const model = await resolveSessionModel(this.client, request.sessionID)
        if (!model) return { status: "no-model" }

        // Session activity may have flipped while the model was being
        // resolved; re-evaluate so a turn that just started is never
        // interrupted.
        const afterModel = await this.gate(request)
        if (afterModel) return afterModel

        // Last line of defense: ask the host for its live session status right
        // before the native call. Event-derived state can lag; this shrinks the
        // race window between "we saw rest" and "the host mutates the session"
        // to a single back-to-back HTTP hop. Fail open when the host does not
        // expose the status endpoint.
        const serverBusy = await this.probeBusy(request.sessionID)
        if (serverBusy === true) {
            const fallback = await this.outcomeFor(request, { action: "stand-down" })
            if (fallback) return fallback
        }

        const result = await this.summarize.summarize({ sessionID: request.sessionID, model })
        // A host that guards its summarize endpoint rejects the collision
        // instead of silently corrupting the run; the coordinator surfaces
        // that without arming the failure cooldown, and it is a `busy` prune
        // outcome, not a failure.
        if (result.status === "rejected") {
            return { status: "busy" }
        }
        return result
    }

    /** One admission check; `null` means the request may proceed. */
    private gate(request: PruneRequest): Promise<PruneOutcome | null> {
        return this.outcomeFor(request, this.admit(request))
    }

    /**
     * Executes a queued prune at the confirmed at-rest boundary. The tool
     * already promised its caller this prune would run; losing the busy race
     * must not silently break that promise, so a busy outcome re-queues for
     * the next at-rest boundary. Every other outcome is terminal: it is
     * logged and never retried — new prune demand arrives through new
     * triggers only. Execution is re-guarded on every attempt, so re-queueing
     * never violates the never-interrupt invariant.
     */
    private async drainQueued(sessionID: string): Promise<void> {
        let outcome: PruneOutcome
        try {
            outcome = await this.request({ sessionID, onBusy: "proceed" })
        } catch (error) {
            this.logger.warn("Queued prune drain failed; the prune was not retried", {
                sessionId: sessionID,
                error: error instanceof Error ? error.message : String(error),
            })
            return
        }
        if (outcome.status === "busy") {
            this.deferred.add(sessionID)
            return
        }
        this.logger.debug("Queued prune drain finished", {
            sessionId: sessionID,
            status: outcome.status,
        })
    }

    /**
     * Turns an admission decision into a terminal outcome, or `null` when the
     * request may proceed. Deferral additionally enqueues the session.
     */
    private async outcomeFor(
        request: PruneRequest,
        admission: Admission,
    ): Promise<PruneOutcome | null> {
        if (admission.action === "go") return null
        if (admission.action === "stand-down") return { status: "busy" }
        this.deferred.add(request.sessionID)
        this.logger.debug("Prune deferred to the next session at-rest boundary", {
            sessionId: request.sessionID,
        })
        return { status: "deferred" }
    }

    private admit(request: PruneRequest): Admission {
        // `defer` is unconditional: the tool executes inside a running turn by
        // construction, so event-derived "idle" is stale by definition and the
        // call must queue for the next turn boundary. Only the event feed can
        // drain it, which is why the event hook stays on whenever the tool is.
        if (request.onBusy === "defer") return { action: "defer" }
        if (this.boundary.state(request.sessionID) === "busy") return { action: "stand-down" }
        return { action: "go" }
    }

    /**
     * THE single live busy probe, reused verbatim by the boundary tracker's
     * expiry check. Bounded by a finite deadline: a never-returning probe
     * resolves `null` within the timeout (fail-open). Returns `null` when the
     * answer is unknown (endpoint or SDK method missing, request failed,
     * timeout) — callers must fail open in that case.
     */
    async probeBusy(sessionID: string): Promise<boolean | null> {
        const statusFn = (this.client.session as unknown as Record<string, unknown>).status
        if (typeof statusFn !== "function") return null
        const query = (async () => {
            try {
                return await (statusFn as (input?: unknown) => Promise<unknown>).call(
                    this.client.session,
                )
            } catch {
                return null
            }
        })()
        const response = await Promise.race([
            query,
            new Promise<null>((resolve) => setTimeout(() => resolve(null), this.probeTimeoutMs)),
        ])
        const map = (response as { data?: unknown })?.data ?? response
        const info = (map as Record<string, { type?: unknown }>)?.[sessionID]
        // `retry` is an active turn between attempts — never compact it.
        return info?.type === "busy" || info?.type === "retry"
    }
}
