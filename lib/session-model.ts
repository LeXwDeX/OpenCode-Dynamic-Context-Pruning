import type { OpenCodeClient } from "./opencode-client"

export interface SessionModel {
    providerID: string
    modelID: string
}

export function latestUserModel(messages: unknown): SessionModel | null {
    if (!Array.isArray(messages)) return null

    for (let index = messages.length - 1; index >= 0; index--) {
        const info = messages[index]?.info
        if (info?.role !== "user") continue
        const providerID = info.model?.providerID
        const modelID = info.model?.modelID
        if (typeof providerID === "string" && typeof modelID === "string") {
            return { providerID, modelID }
        }
    }
    return null
}

export async function resolveSessionModel(
    client: OpenCodeClient,
    sessionID: string,
): Promise<SessionModel | null> {
    try {
        const response = await client.session.messages({ path: { id: sessionID } })
        return latestUserModel(response.data ?? response)
    } catch {
        return null
    }
}
