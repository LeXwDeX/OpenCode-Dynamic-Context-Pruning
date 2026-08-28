import type { SessionActivityTracker } from "./activity"
import type { Logger } from "./logger"
import type { OpenCodeClient } from "./opencode-client"
import { resolveSessionModel } from "./session-model"
import type { SummarizeCoordinator } from "./summarize"

/**
 * How a trigger surface wants the service to react when the session is (or may
 * be) mid-turn:
 * - `"defer"`: compaction must never interrupt a running turn. Queue the prune
 *   and execute it at the next observed turn boundary. Used by the
 *   model-invokable tool, which by definition executes mid-turn.
 * - `"proceed"`: fire at turn boundaries anyway; only stand down on positive
 *   busy evidence. Used by idle-driven auto prune and the manual command.
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
    activity: SessionActivityTracker
    logger: Logger
}

type Admission = { action: "go" } | { action: "defer" } | { action: "stand-down" }

/** Host event names this service derives safety decisions from. */
export type PruneEventName =
    | "session.idle"
    | "session.status"
    | "session.compacted"
    | "session.deleted"
    | (string & {})

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

/**
 * The single compression entry point. Every trigger surface (model tool,
 * heuristic auto prune, manual command) goes through `request`; the service
 * owns everything a caller must not have to know: session busy state, the
 * never-interrupt-a-running-turn invariant, deferral to the next turn
 * boundary, session model resolution, and delegation to the native
 * summarize coordinator (single-flight + failure cooldown).
 *
 * `request` never rejects: every failure mode is a `PruneOutcome`.
 */
export class PruneService {
    private readonly deferred = new Set<string>()
    private readonly client: OpenCodeClient
    private readonly summarize: SummarizeCoordinator
    private readonly activity: SessionActivityTracker
    private readonly logger: Logger

    constructor(deps: PruneServiceDeps) {
        this.client = deps.client
        this.summarize = deps.summarize
        this.activity = deps.activity
        this.logger = deps.logger
    }

    /**
     * Feed every host event through here. Drains the deferral queue on
     * `session.idle` and forgets queued prunes once a compaction (or the
     * session itself) is gone.
     */
    observeEvent(type: PruneEventName, properties?: Record<string, any>): void {
        this.activity.observe(type, properties)
        const sessionID = eventSessionID(properties)
        if (!sessionID) return

        if (type === "session.idle") {
            if (!this.deferred.delete(sessionID)) return
            void this.drainQueued(sessionID)
            return
        }
        if (type === "session.compacted") {
            this.deferred.delete(sessionID)
            return
        }
        if (type === "session.deleted") {
            this.deferred.delete(sessionID)
            this.activity.dropSession(sessionID)
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
        // race window between "we saw idle" and "the host mutates the session"
        // to a single back-to-back HTTP hop. Fail open when the host does not
        // expose the status endpoint.
        const serverBusy = await this.isBusyOnServer(request.sessionID)
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
     * Executes a queued prune at the idle boundary. The tool already promised
     * its caller this prune would run; losing the busy race must not silently
     * break that promise, so a busy outcome re-queues for the next idle
     * boundary. Every other outcome is terminal: it is logged and never
     * retried — new prune demand arrives through new triggers only.
     * Execution is re-guarded on every attempt, so re-queueing never violates
     * the never-interrupt invariant.
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
        this.logger.debug("Prune deferred to the next session idle boundary", {
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
        if (this.activity.state(request.sessionID) === "busy") return { action: "stand-down" }
        return { action: "go" }
    }

    /**
     * Queries the host's live session status. Returns `null` when the answer
     * is unknown (endpoint or SDK method missing, request failed) — callers
     * must fail open in that case.
     */
    private async isBusyOnServer(sessionID: string): Promise<boolean | null> {
        try {
            const statusFn = (this.client.session as unknown as Record<string, unknown>).status
            if (typeof statusFn !== "function") return null
            const response = await (statusFn as (input?: unknown) => Promise<unknown>).call(
                this.client.session,
            )
            const map = (response as { data?: unknown })?.data ?? response
            const info = (map as Record<string, { type?: unknown }>)?.[sessionID]
            // `retry` is an active turn between attempts — never compact it.
            return info?.type === "busy" || info?.type === "retry"
        } catch {
            return null
        }
    }
}
