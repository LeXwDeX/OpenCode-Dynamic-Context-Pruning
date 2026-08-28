import type { Logger } from "./logger"
import type { OpenCodeClient } from "./opencode-client"

export interface SummarizeRequest {
    sessionID: string
    model: {
        providerID: string
        modelID: string
    }
}

export type SummarizeResult =
    | { status: "succeeded" }
    | { status: "rejected"; reason: "busy" }
    | { status: "failed"; error: string }
    | { status: "cooldown"; retryAfterMs: number }

interface SummarizeCoordinatorOptions {
    failureCooldownMs: number
    now?: () => number
}

interface NativeResponse {
    data?: unknown
    error?: unknown
}

function errorMessage(error: unknown): string {
    if (error instanceof Error) return error.message
    if (typeof error === "string") return error
    try {
        return JSON.stringify(error)
    } catch {
        return "Unknown native compaction error"
    }
}

/**
 * Recognizes the host's "session is busy" rejection. Such a rejection is not
 * a compaction failure: nothing went wrong, so it must not arm the failure
 * cooldown. Detection is deliberately defensive — a word-bounded "busy" in
 * the message, a structured 409 status/code, or a Busy* error name — because
 * hosts differ in how they surface it.
 */
function isBusyRejection(error: unknown): boolean {
    if (error instanceof Error && /\bbusy\b/i.test(error.message)) return true
    if (typeof error === "string" && /\bbusy\b/i.test(error)) return true
    const structured = error as {
        status?: unknown
        statusCode?: unknown
        code?: unknown
        name?: unknown
    } | null
    if (!structured || typeof structured !== "object") return false
    if (structured.status === 409 || structured.statusCode === 409 || structured.code === 409) {
        return true
    }
    return typeof structured.name === "string" && /busy/i.test(structured.name)
}

export class SummarizeCoordinator {
    private readonly inFlight = new Map<string, Promise<SummarizeResult>>()
    private readonly failedAt = new Map<string, number>()
    private readonly now: () => number

    constructor(
        private readonly client: OpenCodeClient,
        private readonly logger: Logger,
        private readonly options: SummarizeCoordinatorOptions,
    ) {
        this.now = options.now ?? Date.now
    }

    summarize(request: SummarizeRequest): Promise<SummarizeResult> {
        const active = this.inFlight.get(request.sessionID)
        if (active) return active

        const failedAt = this.failedAt.get(request.sessionID)
        if (failedAt !== undefined) {
            const retryAfterMs = this.options.failureCooldownMs - (this.now() - failedAt)
            if (retryAfterMs > 0) {
                return Promise.resolve({ status: "cooldown", retryAfterMs })
            }
            this.failedAt.delete(request.sessionID)
        }

        const promise = this.invokeNative(request).finally(() => {
            if (this.inFlight.get(request.sessionID) === promise) {
                this.inFlight.delete(request.sessionID)
            }
        })
        this.inFlight.set(request.sessionID, promise)
        return promise
    }

    private async invokeNative(request: SummarizeRequest): Promise<SummarizeResult> {
        try {
            const response = (await this.client.session.summarize({
                path: { id: request.sessionID },
                body: request.model,
            })) as NativeResponse
            // Judge the raw structured error before wrapping it: a busy
            // rejection must surface as `rejected`, not as an arming failure.
            const nativeError = response?.error
            if (nativeError && isBusyRejection(nativeError)) {
                return { status: "rejected", reason: "busy" }
            }
            if (nativeError || response?.data !== true) {
                throw new Error(errorMessage(nativeError ?? "Native summarize returned false"))
            }
            this.failedAt.delete(request.sessionID)
            return { status: "succeeded" }
        } catch (error) {
            if (isBusyRejection(error)) {
                return { status: "rejected", reason: "busy" }
            }
            this.failedAt.set(request.sessionID, this.now())
            const message = errorMessage(error)
            await this.logger.warn("Native summarize failed; context remains unchanged", {
                sessionId: request.sessionID,
                error: message,
            })
            return { status: "failed", error: message }
        }
    }
}
