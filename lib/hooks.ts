import type { Logger } from "./logger"
import type { OpenCodeClient } from "./opencode-client"
import type { PromptStore } from "./prompts/store"
import type { SummarizeCoordinator } from "./summarize"

interface CompactionOutput {
    context: string[]
    prompt?: string
}

export function createSessionCompactingHandler(prompts: PromptStore, logger: Logger) {
    return async (input: { sessionID: string }, output: CompactionOutput): Promise<void> => {
        try {
            prompts.reload()
            const prompt = prompts.getRuntimePrompts().compaction
            if (!output.prompt) {
                output.prompt = prompt
            } else if (!output.context.includes(prompt)) {
                output.context.push(prompt)
            }
            logger.debug("Applied semantic pruning prompt", { sessionId: input.sessionID })
        } catch (error) {
            logger.warn("Failed to apply semantic pruning prompt; native compaction continues", {
                sessionId: input.sessionID,
                error: error instanceof Error ? error.message : String(error),
            })
        }
    }
}

function latestUserModel(messages: unknown): { providerID: string; modelID: string } | null {
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

async function showToast(
    client: OpenCodeClient,
    title: string,
    message: string,
    variant: "info" | "warning" | "error" = "info",
): Promise<void> {
    await client.tui
        .showToast({
            body: { title, message, variant, duration: 5000 },
        })
        .catch(() => undefined)
}

export function createCommandExecuteHandler(
    client: OpenCodeClient,
    summarize: SummarizeCoordinator,
    logger: Logger,
) {
    return async (
        input: {
            command: string
            sessionID: string
            arguments: string
        },
        _output?: { parts: unknown[] },
    ): Promise<void> => {
        if (input.command !== "dcp") return

        const subcommand = (input.arguments ?? "").trim().split(/\s+/, 1)[0]?.toLowerCase()
        if (subcommand !== "summarize") {
            await showToast(
                client,
                "DCP",
                "Use /dcp summarize for semantic pruning, or OpenCode's native /compact command.",
            )
            throw new Error("__DCP_HELP_HANDLED__")
        }

        const response = await client.session.messages({ path: { id: input.sessionID } })
        const model = latestUserModel(response.data ?? response)
        if (!model) {
            await showToast(
                client,
                "DCP summarize",
                "No session model is available yet.",
                "warning",
            )
            throw new Error("__DCP_SUMMARIZE_NO_MODEL__")
        }

        const result = await summarize.summarize({ sessionID: input.sessionID, model })
        if (result.status === "succeeded") {
            await showToast(client, "DCP summarize", "Semantic pruning checkpoint created.")
        } else if (result.status === "cooldown") {
            await showToast(
                client,
                "DCP summarize",
                `Previous attempt failed; retry in ${Math.ceil(result.retryAfterMs / 1000)}s.`,
                "warning",
            )
        } else {
            await showToast(
                client,
                "DCP summarize",
                "Native compaction failed; the original context was kept.",
                "error",
            )
        }
        logger.debug("Handled DCP summarize command", {
            sessionId: input.sessionID,
            status: result.status,
        })
        throw new Error("__DCP_SUMMARIZE_HANDLED__")
    }
}
