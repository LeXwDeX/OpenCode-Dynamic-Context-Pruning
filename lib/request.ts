import { types } from "node:util"
import type { OpenCodeClient } from "./opencode-client"

export interface ModelReference {
    providerID: string
    modelID: string
}

function record(value: unknown): value is Record<string, any> {
    if (!value || typeof value !== "object" || types.isProxy(value)) return false
    const prototype = Object.getPrototypeOf(value)
    return prototype === Object.prototype || prototype === null
}

function positive(value: unknown): value is number {
    return typeof value === "number" && Number.isFinite(value) && value > 0
}

function text(value: unknown): value is string {
    return typeof value === "string" && value.length > 0
}

/** Identity comes only from the host's explicit message fields. */
export function sessionIDFor(messages: unknown[]): string | undefined {
    let sessionID: string | undefined
    for (const message of messages) {
        if (!record(message) || !record(message.info) || !text(message.info.sessionID)) return
        if (sessionID !== undefined && sessionID !== message.info.sessionID) return
        sessionID = message.info.sessionID
    }
    return sessionID
}

/** Compaction can reorder history. Match the host's created-time/ID ordering. */
export function modelFor(messages: unknown[]): ModelReference | undefined {
    let latest: Record<string, any> | undefined
    for (const message of messages) {
        if (!record(message) || !record(message.info)) return
        const info = message.info
        if (info.role !== "user") continue
        if (!Array.isArray(message.parts)) return
        if (message.parts.some((part: unknown) => record(part) && part.type === "compaction"))
            continue
        if (!record(info.time) || !Number.isFinite(info.time.created) || !text(info.id)) return
        if (
            !latest ||
            info.time.created > latest.time.created ||
            (info.time.created === latest.time.created && info.id > latest.id)
        )
            latest = info
    }
    if (!latest || !record(latest.model)) return
    const { providerID, modelID } = latest.model
    if (!text(providerID) || !text(modelID)) return
    return { providerID, modelID }
}

function outputTokenMax(): number {
    const configured = Number(process.env.OPENCODE_EXPERIMENTAL_OUTPUT_TOKEN_MAX)
    return positive(configured) && Number.isInteger(configured) ? configured : 32_000
}

/**
 * Resolve configured limits for this request, after the host has initialized
 * its provider service. The SDK wrapper is deliberate: missing/error response
 * data never falls back to a catalog or a previous request's model.
 * This budget reserves output but does not count later system/tool additions.
 */
export async function inputBudgetFor(
    client: OpenCodeClient,
    reference: ModelReference,
    maximumOutput = outputTokenMax(),
): Promise<number | undefined> {
    try {
        if (!positive(maximumOutput)) return
        const response: unknown = await client.config.providers({
            signal: AbortSignal.timeout(2000),
        })
        if (
            !record(response) ||
            response.error !== undefined ||
            !record(response.data) ||
            !Array.isArray(response.data.providers)
        )
            return
        const providers = response.data.providers.filter(
            (provider: unknown) => record(provider) && provider.id === reference.providerID,
        )
        if (providers.length !== 1 || !record(providers[0].models)) return
        const model = providers[0].models[reference.modelID]
        if (!record(model) || model.id !== reference.modelID || !record(model.limit)) return
        if (model.providerID !== undefined && model.providerID !== reference.providerID) return
        const { context, input, output } = model.limit
        if (!positive(context) || !positive(output)) return
        if (input !== undefined && !positive(input)) return
        const budget = Math.floor(
            Math.min(input ?? context, context - Math.min(output, maximumOutput)),
        )
        return positive(budget) ? budget : undefined
    } catch {
        return undefined
    }
}

/** Ordinary dense writable arrays can be replaced elementwise without setters. */
export function canCommitMessages(value: unknown): value is unknown[] {
    if (
        !Array.isArray(value) ||
        types.isProxy(value) ||
        Object.getPrototypeOf(value) !== Array.prototype
    )
        return false
    for (let index = 0; index < value.length; index++) {
        const descriptor = Object.getOwnPropertyDescriptor(value, String(index))
        if (!descriptor || !("value" in descriptor) || !descriptor.writable) return false
    }
    return true
}
