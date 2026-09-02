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
