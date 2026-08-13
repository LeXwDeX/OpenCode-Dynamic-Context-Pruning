import type { SessionState, WithParts } from "../../state"
import type { Logger } from "../../logger"
import type { PluginConfig } from "../../config"
import type { RuntimePrompts } from "../../prompts/store"
import { formatMessageIdTag } from "../../message-ids"
import type { CompressionPriorityMap } from "../priority"
import { compressPermission } from "../../compress-permission"
import {
    getLastUserMessage,
    isIgnoredUserMessage,
    isProtectedUserMessage,
    messageHasCompress,
} from "../query"
import { saveSessionState } from "../../state/persistence"
import {
    appendToTextPart,
    appendToLastTextPart,
    appendToAllToolParts,
    createSyntheticTextPart,
    hasContent,
} from "../utils"
import {
    addAnchor,
    applyAnchoredNudges,
    countMessagesAfterIndex,
    findLastNonIgnoredMessage,
    getIterationNudgeThreshold,
    getNudgeFrequency,
    getModelInfo,
    isContextOverLimits,
} from "./utils"

function userMessagesAfterLastAnchor(state: SessionState, messages: WithParts[]): number {
    let latestAnchorIndex = -1
    for (let index = messages.length - 1; index >= 0; index--) {
        if (state.nudges.turnNudgeAnchors.has(messages[index].info.id)) {
            latestAnchorIndex = index
            break
        }
    }

    let userCount = 0
    for (let index = latestAnchorIndex + 1; index < messages.length; index++) {
        const message = messages[index]
        if (message.info.role === "user" && !isIgnoredUserMessage(message)) {
            userCount++
        }
    }

    return userCount
}

export const injectCompressNudges = (
    state: SessionState,
    config: PluginConfig,
    logger: Logger,
    messages: WithParts[],
    prompts: RuntimePrompts,
    compressionPriorities?: CompressionPriorityMap,
): void => {
    const clearPendingBoundary = (): void => {
        if (!state.nudges.boundaryPending) {
            return
        }
        state.nudges.boundaryPending = false
        if (!state.sessionId) {
            return
        }
        void saveSessionState(state, logger).catch((error) =>
            logger.warn("Failed to persist boundary nudge cleanup", {
                error: error instanceof Error ? error.message : String(error),
            }),
        )
    }

    if (compressPermission(state, config) === "deny") {
        clearPendingBoundary()
        return
    }

    if (state.manualMode) {
        clearPendingBoundary()
        return
    }

    const lastMessage = findLastNonIgnoredMessage(messages)
    const lastAssistantMessage = messages.findLast((message) => message.info.role === "assistant")

    if (lastAssistantMessage && messageHasCompress(lastAssistantMessage)) {
        const continuationReminder =
            "\n<dcp-system-reminder>\nCompression complete. Resume your previous task.\n</dcp-system-reminder>\n"

        if (lastMessage) {
            const targetMessage = lastMessage.message
            let injected = false
            for (const part of targetMessage.parts) {
                if (part.type === "text" && typeof part.text === "string") {
                    part.text += continuationReminder
                    injected = true
                    break
                }
            }
            if (!injected) {
                targetMessage.parts.push(
                    createSyntheticTextPart(targetMessage, continuationReminder),
                )
            }
        }

        state.nudges.contextLimitAnchors.clear()
        state.nudges.turnNudgeAnchors.clear()
        state.nudges.iterationNudgeAnchors.clear()
        state.nudges.boundaryPending = false
        void saveSessionState(state, logger).catch((error) =>
            logger.warn("Failed to persist context-limit nudge", {
                error: error instanceof Error ? error.message : String(error),
            }),
        )
        return
    }

    const { providerId, modelId } = getModelInfo(messages)
    const boundaryNudgeEnabled = config.compress.boundaryNudge !== false
    let anchorsChanged = false

    const { overMaxLimit, overMinLimit } = isContextOverLimits(
        config,
        state,
        providerId,
        modelId,
        messages,
    )

    if (!overMinLimit) {
        const hadIterationAnchors = state.nudges.iterationNudgeAnchors.size > 0

        if (hadIterationAnchors) {
            state.nudges.iterationNudgeAnchors.clear()
            anchorsChanged = true
        }

        if (!boundaryNudgeEnabled) {
            const hadTurnAnchors = state.nudges.turnNudgeAnchors.size > 0
            if (hadTurnAnchors) {
                state.nudges.turnNudgeAnchors.clear()
                anchorsChanged = true
            }
        }
    }

    if (overMaxLimit) {
        if (lastMessage) {
            const interval = getNudgeFrequency(config)
            const added = addAnchor(
                state.nudges.contextLimitAnchors,
                lastMessage.message.info.id,
                lastMessage.index,
                messages,
                interval,
            )
            if (added) {
                anchorsChanged = true
            }
        }
    } else if (overMinLimit) {
        const isLastMessageUser = lastMessage?.message.info.role === "user"

        if (!boundaryNudgeEnabled && isLastMessageUser && lastAssistantMessage) {
            const previousSize = state.nudges.turnNudgeAnchors.size
            state.nudges.turnNudgeAnchors.add(lastMessage.message.info.id)
            state.nudges.turnNudgeAnchors.add(lastAssistantMessage.info.id)
            if (state.nudges.turnNudgeAnchors.size !== previousSize) {
                anchorsChanged = true
            }
        }

        const lastUserMessage = getLastUserMessage(messages)
        if (lastUserMessage && lastMessage) {
            const lastUserMessageIndex = messages.findIndex(
                (message) => message.info.id === lastUserMessage.info.id,
            )
            if (lastUserMessageIndex >= 0) {
                const messagesSinceUser = countMessagesAfterIndex(messages, lastUserMessageIndex)
                const iterationThreshold = getIterationNudgeThreshold(config)

                if (
                    lastMessage.index > lastUserMessageIndex &&
                    messagesSinceUser >= iterationThreshold
                ) {
                    const interval = getNudgeFrequency(config)
                    const added = addAnchor(
                        state.nudges.iterationNudgeAnchors,
                        lastMessage.message.info.id,
                        lastMessage.index,
                        messages,
                        interval,
                    )

                    if (added) {
                        anchorsChanged = true
                    }
                }
            }
        }
    }

    if (boundaryNudgeEnabled && !overMaxLimit) {
        const lastUserMessage = getLastUserMessage(messages)
        const isLastMessageUser = lastMessage?.message.info.role === "user"
        const hasPendingBoundary = state.nudges.boundaryPending

        if (lastUserMessage && lastAssistantMessage) {
            const lastUserMessageIndex = messages.findIndex(
                (message) => message.info.id === lastUserMessage.info.id,
            )
            const lastAssistantMessageIndex = messages.findIndex(
                (message) => message.info.id === lastAssistantMessage.info.id,
            )
            const alreadyAnchored =
                state.nudges.turnNudgeAnchors.has(lastUserMessage.info.id) &&
                state.nudges.turnNudgeAnchors.has(lastAssistantMessage.info.id)

            if (!alreadyAnchored && lastUserMessageIndex >= 0 && lastAssistantMessageIndex >= 0) {
                const interval = getNudgeFrequency(config)
                const shouldAnchor =
                    hasPendingBoundary ||
                    (isLastMessageUser && userMessagesAfterLastAnchor(state, messages) >= interval)

                if (shouldAnchor) {
                    state.nudges.turnNudgeAnchors.add(lastAssistantMessage.info.id)
                    state.nudges.turnNudgeAnchors.add(lastUserMessage.info.id)
                    anchorsChanged = true
                }
            }

            if (hasPendingBoundary) {
                state.nudges.boundaryPending = false
                anchorsChanged = true
            }
        }
    }

    applyAnchoredNudges(state, config, messages, prompts, compressionPriorities)

    if (anchorsChanged) {
        void saveSessionState(state, logger).catch((error) =>
            logger.warn("Failed to persist compression nudge", {
                error: error instanceof Error ? error.message : String(error),
            }),
        )
    }
}

export const injectMessageIds = (
    state: SessionState,
    config: PluginConfig,
    messages: WithParts[],
    compressionPriorities?: CompressionPriorityMap,
): void => {
    if (compressPermission(state, config) === "deny") {
        return
    }

    for (const message of messages) {
        if (isIgnoredUserMessage(message)) {
            continue
        }

        const messageRef = state.messageIds.byRawId.get(message.info.id)
        if (!messageRef) {
            continue
        }

        const isBlockedMessage = isProtectedUserMessage(config, message)
        const priority =
            config.compress.mode === "message" && !isBlockedMessage
                ? compressionPriorities?.get(message.info.id)?.priority
                : undefined
        const tag = formatMessageIdTag(
            isBlockedMessage ? "BLOCKED" : messageRef,
            priority ? { priority } : undefined,
        )

        if (message.info.role === "user") {
            let injected = false
            for (const part of message.parts) {
                if (part.type === "text") {
                    injected = appendToTextPart(part, tag) || injected
                }
            }

            if (injected) {
                continue
            }

            message.parts.push(createSyntheticTextPart(message, tag))
            continue
        }

        if (message.info.role !== "assistant") {
            continue
        }

        if (!hasContent(message)) {
            continue
        }

        if (appendToAllToolParts(message, tag)) {
            continue
        }

        if (appendToLastTextPart(message, tag)) {
            continue
        }

        const syntheticPart = createSyntheticTextPart(message, tag)
        const firstToolIndex = message.parts.findIndex((p) => p.type === "tool")
        if (firstToolIndex === -1) {
            message.parts.push(syntheticPart)
        } else {
            message.parts.splice(firstToolIndex, 0, syntheticPart)
        }
    }
}
