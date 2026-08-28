import type { Plugin } from "@opencode-ai/plugin"
import { SessionActivityTracker } from "./lib/activity"
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
import { PruneService } from "./lib/prune-service"
import { SummarizeCoordinator } from "./lib/summarize"
import { startAutoUpdate } from "./lib/update"

const server: Plugin = (async (ctx) => {
    const config = getConfig(ctx)
    if (!config.enabled) return {}

    const logger = new Logger(config.debug)
    const prompts = new PromptStore(
        logger,
        ctx.directory,
        config.experimental.customPrompts,
        config.language,
    )
    const summarize = new SummarizeCoordinator(ctx.client, logger, {
        failureCooldownMs: config.summarize.failureCooldownMs,
    })
    const prune = new PruneService({
        client: ctx.client,
        summarize,
        activity: new SessionActivityTracker(),
        logger,
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
        }),
        // The event feed drives both auto prune and the tool's deferred prunes,
        // so it stays registered whenever either surface is on.
        ...((config.autoPrune.enabled || config.tool.enabled) && {
            event: createEventHandler({
                client: ctx.client,
                prune,
                autoPruner,
                config: config.autoPrune,
                logger,
            }),
        }),
        ...(config.tool.enabled && {
            tool: { [PRUNE_TOOL_NAME]: createPruneTool({ prune, logger }) },
        }),
        ...(config.commands.enabled && {
            "command.execute.before": createCommandExecuteHandler(ctx.client, prune, logger),
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
