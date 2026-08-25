import type { Plugin } from "@opencode-ai/plugin"
import { AutoPruner } from "./lib/auto-prune"
import { getConfig } from "./lib/config"
import {
    createChatMessageHandler,
    createCommandExecuteHandler,
    createEventHandler,
    createSessionCompactingHandler,
} from "./lib/hooks"
import { Logger } from "./lib/logger"
import { PromptStore } from "./lib/prompts/store"
import { PRUNE_TOOL_NAME, createPruneTool } from "./lib/prune-tool"
import { SummarizeCoordinator } from "./lib/summarize"
import { startAutoUpdate } from "./lib/update"

const server: Plugin = (async (ctx) => {
    const config = getConfig(ctx)
    if (!config.enabled) return {}

    const logger = new Logger(config.debug)
    const prompts = new PromptStore(logger, ctx.directory, config.experimental.customPrompts)
    const summarize = new SummarizeCoordinator(ctx.client, logger, {
        failureCooldownMs: config.summarize.failureCooldownMs,
    })
    const autoPruner = new AutoPruner(config.autoPrune)

    logger.info("DCP initialized", {
        commands: config.commands.enabled,
        autoPrune: config.autoPrune.enabled,
        tool: config.tool.enabled,
        customPrompts: config.experimental.customPrompts,
    })
    startAutoUpdate(ctx, config.autoUpdate)

    return {
        "experimental.session.compacting": createSessionCompactingHandler(prompts, logger),
        ...(config.autoPrune.enabled && {
            "chat.message": createChatMessageHandler(autoPruner),
            event: createEventHandler({
                client: ctx.client,
                summarize,
                autoPruner,
                config: config.autoPrune,
                logger,
            }),
        }),
        ...(config.tool.enabled && {
            tool: { [PRUNE_TOOL_NAME]: createPruneTool({ client: ctx.client, summarize, logger }) },
        }),
        ...(config.commands.enabled && {
            "command.execute.before": createCommandExecuteHandler(ctx.client, summarize, logger),
            config: async (opencodeConfig) => {
                opencodeConfig.command ??= {}
                opencodeConfig.command.dcp = {
                    template: "",
                    description: "Run semantic context pruning with native compaction",
                }
            },
        }),
    }
}) satisfies Plugin

export default server
