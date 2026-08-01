import { tool } from "@opencode-ai/plugin"
import type { ToolContext } from "./types"
import { countTokens } from "../token-utils"
import { buildMessageFormatExtension } from "../prompts/extensions/tool"
import { formatIssues, formatResult, resolveMessages, validateArgs } from "./message-utils"
import { finalizeSession, prepareSession, type NotificationEntry } from "./pipeline"
import { appendProtectedPromptInfo, appendProtectedTools } from "./protected-content"
import {
    allocateBlockId,
    allocateRunId,
    applyCompressionState,
    wrapCompressedSummary,
} from "./state"
import type { CompressMessageToolArgs, SearchContext } from "./types"
import { generateSummaryViaExternal } from "./external-inference"
import { runWithConcurrency, serializeMessagesForExternalSummary } from "./external-content"

function buildSchema(externalModelEnabled: boolean) {
    const summaryField = externalModelEnabled
        ? tool.schema
              .string()
              .optional()
              .describe(
                  "Complete technical summary replacing that one message (optional when external model is configured)",
              )
        : tool.schema.string().describe("Complete technical summary replacing that one message")

    return {
        topic: tool.schema
            .string()
            .describe(
                "Short label (3-5 words) for the overall batch - e.g., 'Closed Research Notes'",
            ),
        content: tool.schema
            .array(
                tool.schema.object({
                    messageId: tool.schema
                        .string()
                        .describe("Raw message ID to compress (e.g. m0001)"),
                    topic: tool.schema
                        .string()
                        .describe("Short label (3-5 words) for this one message summary"),
                    summary: summaryField,
                }),
            )
            .describe("Batch of individual message summaries to create in one tool call"),
    }
}

export function createCompressMessageTool(ctx: ToolContext): ReturnType<typeof tool> {
    ctx.prompts.reload()
    const runtimePrompts = ctx.prompts.getRuntimePrompts()
    const externalModelEnabled = ctx.config.compress.externalModel !== undefined

    return tool({
        description:
            runtimePrompts.compressMessage + buildMessageFormatExtension(externalModelEnabled),
        args: buildSchema(externalModelEnabled),
        async execute(args, toolCtx) {
            const input = args as CompressMessageToolArgs
            validateArgs(input)
            const callId =
                typeof (toolCtx as unknown as { callID?: unknown }).callID === "string"
                    ? (toolCtx as unknown as { callID: string }).callID
                    : undefined

            const { state, rawMessages, searchContext } = await prepareSession(
                ctx,
                toolCtx,
                `Compress Message: ${input.topic}`,
            )
            const { plans, skippedIssues, skippedCount } = resolveMessages(
                input,
                searchContext,
                state,
                ctx.config,
            )

            if (plans.length === 0 && skippedCount > 0) {
                throw new Error(formatIssues(skippedIssues, skippedCount))
            }

            const externalModel = ctx.config.compress.externalModel
            if (externalModel) {
                await runWithConcurrency(plans, 3, async (plan) => {
                    if (plan.entry.summary === undefined) {
                        const message = searchContext.rawMessagesById.get(plan.entry.messageId)
                        const userContent = serializeMessagesForExternalSummary(
                            message ? [message] : [],
                        )
                        const generated = await generateSummaryViaExternal(externalModel, {
                            systemPrompt: runtimePrompts.compressMessage,
                            userContent,
                        })
                        plan.entry.summary = generated
                    }
                })
            }

            const notifications: NotificationEntry[] = []

            const preparedPlans: Array<{
                plan: (typeof plans)[number]
                summaryWithTools: string
            }> = []

            for (const plan of plans) {
                if (plan.entry.summary === undefined) {
                    throw new Error(
                        "缺少 summary：未配置外部模型，请提供 summary 或配置 OPENCODE_DCP_EXTERNAL_COMPRESS_URL/MODEL",
                    )
                }
                const summaryWithPromptInfo = appendProtectedPromptInfo(
                    plan.entry.summary,
                    plan.selection,
                    searchContext,
                    state,
                    ctx.config.compress.protectTags,
                )

                const summaryWithTools = await appendProtectedTools(
                    ctx.client,
                    state,
                    ctx.config.experimental.allowSubAgents,
                    summaryWithPromptInfo,
                    plan.selection,
                    searchContext,
                    ctx.config.compress.protectedTools,
                    ctx.config.protectedFilePatterns,
                )

                preparedPlans.push({
                    plan,
                    summaryWithTools,
                })
            }

            const runId = allocateRunId(state)

            for (const { plan, summaryWithTools } of preparedPlans) {
                const blockId = allocateBlockId(state)
                const storedSummary = wrapCompressedSummary(blockId, summaryWithTools)
                const summaryTokens = countTokens(storedSummary)

                applyCompressionState(
                    state,
                    {
                        topic: plan.entry.topic,
                        batchTopic: input.topic,
                        startId: plan.entry.messageId,
                        endId: plan.entry.messageId,
                        mode: "message",
                        runId,
                        compressMessageId: toolCtx.messageID,
                        compressCallId: callId,
                        summaryTokens,
                    },
                    plan.selection,
                    plan.anchorMessageId,
                    blockId,
                    storedSummary,
                    [],
                )

                notifications.push({
                    blockId,
                    runId,
                    summary: summaryWithTools,
                    summaryTokens,
                })
            }

            await finalizeSession(ctx, state, toolCtx, rawMessages, notifications, input.topic)

            return formatResult(plans.length, skippedIssues, skippedCount)
        },
    })
}
