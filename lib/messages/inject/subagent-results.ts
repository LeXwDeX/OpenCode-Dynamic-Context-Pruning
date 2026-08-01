import type { Logger } from "../../logger"
import type { SessionState, WithParts } from "../../state"
import { filterMessages } from "../shape"
import {
    buildSubagentResultText,
    getSubAgentId,
    mergeSubagentResult,
} from "../../subagents/subagent-results"
import { stripHallucinationsFromString } from "../utils"
import { runWithConcurrency } from "../../concurrency"
import { cacheSubAgentResult, getCachedSubAgentResult } from "../../state/utils"
import type { OpenCodeClient } from "../../opencode-client"

async function fetchSubAgentMessages(
    client: OpenCodeClient,
    sessionId: string,
): Promise<WithParts[]> {
    const response = await client.session.messages({
        path: { id: sessionId },
    })

    return filterMessages(response?.data || response)
}

export const injectExtendedSubAgentResults = async (
    client: OpenCodeClient,
    state: SessionState,
    logger: Logger,
    messages: WithParts[],
    allowSubAgents: boolean,
): Promise<void> => {
    if (!allowSubAgents) {
        return
    }

    type CompletedToolPart = Extract<WithParts["parts"][number], { type: "tool" }> & {
        state: { status: "completed"; output: string }
    }
    const tasks: Array<{ part: CompletedToolPart }> = []
    for (const message of messages) {
        const parts = Array.isArray(message.parts) ? message.parts : []

        for (const part of parts) {
            if (part.type !== "tool" || part.tool !== "task" || !part.callID) {
                continue
            }
            if (state.prune.tools.has(part.callID)) {
                continue
            }
            if (part.state?.status !== "completed" || typeof part.state.output !== "string") {
                continue
            }

            tasks.push({ part: part as CompletedToolPart })
        }
    }

    await runWithConcurrency(tasks, 4, async ({ part }) => {
        const cachedResult = getCachedSubAgentResult(state, part.callID)
        if (cachedResult !== undefined) {
            if (cachedResult) {
                part.state.output = stripHallucinationsFromString(
                    mergeSubagentResult(part.state.output, cachedResult),
                )
            }
            return
        }

        const subAgentSessionId = getSubAgentId(part)
        if (!subAgentSessionId) {
            return
        }

        let subAgentMessages: WithParts[] = []
        try {
            subAgentMessages = await fetchSubAgentMessages(client, subAgentSessionId)
        } catch (error) {
            logger.warn("Failed to fetch subagent session for output expansion", {
                subAgentSessionId,
                callID: part.callID,
                error: error instanceof Error ? error.message : String(error),
            })
            return
        }

        const subAgentResultText = buildSubagentResultText(subAgentMessages)
        if (!subAgentResultText) {
            return
        }

        const cached = cacheSubAgentResult(state, part.callID, subAgentResultText)
        part.state.output = stripHallucinationsFromString(
            mergeSubagentResult(part.state.output, cached),
        )
    })
}
