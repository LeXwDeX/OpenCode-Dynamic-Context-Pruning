import type { Plugin } from "@opencode-ai/plugin"
import { getConfig } from "./lib/config"
import { createCommandExecuteHandler, createSessionCompactingHandler } from "./lib/hooks"
import { Logger } from "./lib/logger"
import { PromptStore } from "./lib/prompts/store"
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

    logger.info("DCP initialized with native compaction", {
        commands: config.commands.enabled,
        customPrompts: config.experimental.customPrompts,
    })
    startAutoUpdate(ctx, config.autoUpdate)

    return {
        "experimental.session.compacting": createSessionCompactingHandler(prompts, logger),
        ...(config.commands.enabled && {
            "command.execute.before": createCommandExecuteHandler(ctx.client, summarize, logger),
        }),
        config: async (opencodeConfig) => {
            if (!config.commands.enabled) return
            opencodeConfig.command ??= {}
            opencodeConfig.command.dcp = {
                template: "",
                description: "Run semantic context pruning with native compaction",
            }
        },
    }
}) satisfies Plugin

export default server
