import { tool } from "@opencode-ai/plugin"
import type { ToolContext } from "./types"
import { countTokens } from "../token-utils"
import { buildRangeFormatExtension } from "../prompts/extensions/tool"
import { finalizeSession, prepareSession, type NotificationEntry } from "./pipeline"
import {
    appendProtectedPromptInfo,
    appendProtectedTools,
    appendProtectedUserMessages,
} from "./protected-content"
import {
    appendMissingBlockSummaries,
    injectBlockPlaceholders,
    parseBlockPlaceholders,
    resolveRanges,
    validateArgs,
    validateNonOverlapping,
    validateSummaryPlaceholders,
} from "./range-utils"
import {
    COMPRESSED_BLOCK_HEADER,
    allocateBlockId,
    allocateRunId,
    applyCompressionState,
    wrapCompressedSummary,
} from "./state"
import type { CompressRangeToolArgs, SearchContext } from "./types"
import { generateSummaryViaExternal } from "./external-inference"
import { runWithConcurrency, serializeMessagesForExternalSummary } from "./external-content"

function buildSchema(externalModelEnabled: boolean) {
    const summaryField = externalModelEnabled
        ? tool.schema
              .string()
              .optional()
              .describe(
                  "Complete technical summary replacing all content in range (optional when external model is configured)",
              )
        : tool.schema.string().describe("Complete technical summary replacing all content in range")

    return {
        topic: tool.schema
            .string()
            .describe("Short label (3-5 words) for display - e.g., 'Auth System Exploration'"),
        content: tool.schema
            .array(
                tool.schema.object({
                    startId: tool.schema
                        .string()
                        .describe(
                            "Injected message or block ID visible in the current context marking the beginning of the range. Do not invent IDs; use an exact visible mNNNN or bN boundary.",
                        ),
                    endId: tool.schema
                        .string()
                        .describe(
                            "Injected message or block ID visible in the current context marking the end of the range. Do not invent IDs; use an exact visible mNNNN or bN boundary.",
                        ),
                    summary: summaryField,
                }),
            )
            .describe(
                "One or more ranges to compress, each with start/end boundaries and a summary",
            ),
    }
}

export function createCompressRangeTool(ctx: ToolContext): ReturnType<typeof tool> {
    ctx.prompts.reload()
    const runtimePrompts = ctx.prompts.getRuntimePrompts()
    const externalModelEnabled = ctx.config.compress.externalModel !== undefined

    return tool({
        description: runtimePrompts.compressRange + buildRangeFormatExtension(externalModelEnabled),
        args: buildSchema(externalModelEnabled),
        async execute(args, toolCtx) {
            const input = args as CompressRangeToolArgs
            validateArgs(input)
            const callId =
                typeof (toolCtx as unknown as { callID?: unknown }).callID === "string"
                    ? (toolCtx as unknown as { callID: string }).callID
                    : undefined

            const { state, rawMessages, searchContext } = await prepareSession(
                ctx,
                toolCtx,
                `Compress Range: ${input.topic}`,
            )
            const resolvedPlans = resolveRanges(input, searchContext, state)
            validateNonOverlapping(resolvedPlans)

            const externalModel = ctx.config.compress.externalModel
            if (externalModel) {
                await runWithConcurrency(resolvedPlans, 3, async (plan) => {
                    if (plan.entry.summary === undefined) {
                        const selectedMessages = plan.selection.messageIds.flatMap((messageId) => {
                            const message = searchContext.rawMessagesById.get(messageId)
                            return message ? [message] : []
                        })
                        const userContent = serializeMessagesForExternalSummary(selectedMessages)
                        const generated = await generateSummaryViaExternal(externalModel, {
                            systemPrompt: runtimePrompts.compressRange,
                            userContent,
                        })
                        plan.entry.summary = generated
                    }
                })
            }

            const notifications: NotificationEntry[] = []
            const preparedPlans: Array<{
                entry: (typeof resolvedPlans)[number]["entry"]
                selection: (typeof resolvedPlans)[number]["selection"]
                anchorMessageId: string
                finalSummary: string
                consumedBlockIds: number[]
            }> = []
            let totalCompressedMessages = 0

            for (const plan of resolvedPlans) {
                if (plan.entry.summary === undefined) {
                    throw new Error(
                        "缺少 summary：未配置外部模型，请提供 summary 或配置 OPENCODE_DCP_EXTERNAL_COMPRESS_URL/MODEL",
                    )
                }
                const parsedPlaceholders = parseBlockPlaceholders(plan.entry.summary)
                const missingBlockIds = validateSummaryPlaceholders(
                    parsedPlaceholders,
                    plan.selection.requiredBlockIds,
                    plan.selection.startReference,
                    plan.selection.endReference,
                    searchContext.summaryByBlockId,
                )

                const injected = injectBlockPlaceholders(
                    plan.entry.summary,
                    parsedPlaceholders,
                    searchContext.summaryByBlockId,
                    plan.selection.startReference,
                    plan.selection.endReference,
                )

                const summaryWithUsers = appendProtectedUserMessages(
                    injected.expandedSummary,
                    plan.selection,
                    searchContext,
                    state,
                    ctx.config.compress.protectUserMessages,
                )

                const summaryWithPromptInfo = appendProtectedPromptInfo(
                    summaryWithUsers,
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

                const completedSummary = appendMissingBlockSummaries(
                    summaryWithTools,
                    missingBlockIds,
                    searchContext.summaryByBlockId,
                    injected.consumedBlockIds,
                )

                preparedPlans.push({
                    entry: plan.entry,
                    selection: plan.selection,
                    anchorMessageId: plan.anchorMessageId,
                    finalSummary: completedSummary.expandedSummary,
                    consumedBlockIds: completedSummary.consumedBlockIds,
                })
            }

            const runId = allocateRunId(state)

            for (const preparedPlan of preparedPlans) {
                const blockId = allocateBlockId(state)
                const storedSummary = wrapCompressedSummary(blockId, preparedPlan.finalSummary)
                const summaryTokens = countTokens(storedSummary)

                const applied = applyCompressionState(
                    state,
                    {
                        topic: input.topic,
                        batchTopic: input.topic,
                        startId: preparedPlan.entry.startId,
                        endId: preparedPlan.entry.endId,
                        mode: "range",
                        runId,
                        compressMessageId: toolCtx.messageID,
                        compressCallId: callId,
                        summaryTokens,
                    },
                    preparedPlan.selection,
                    preparedPlan.anchorMessageId,
                    blockId,
                    storedSummary,
                    preparedPlan.consumedBlockIds,
                )

                totalCompressedMessages += applied.messageIds.length

                notifications.push({
                    blockId,
                    runId,
                    summary: preparedPlan.finalSummary,
                    summaryTokens,
                })
            }

            await finalizeSession(ctx, state, toolCtx, rawMessages, notifications, input.topic)

            return `Compressed ${totalCompressedMessages} messages into ${COMPRESSED_BLOCK_HEADER}.`
        },
    })
}
