import type { Plugin } from "@opencode-ai/plugin"
import { getConfig } from "./lib/config"
import { DtcState } from "./lib/dtc/state"
import {
    createChatParamsHandler,
    createEventHandler,
    createSessionCompactingHandler,
    createTransformHandler,
} from "./lib/hooks"
import { Logger } from "./lib/logger"
import { PRUNE_TOOL_NAME, createPruneTool } from "./lib/prune-tool"
import { startAutoUpdate } from "./lib/update"

const server: Plugin = (async (ctx) => {
    const config = getConfig(ctx)
    if (!config.enabled) return {}
    const logger = new Logger(config.debug)
    startAutoUpdate(ctx, config.autoUpdate)
    if (!config.dtc.enabled) return {}

    const state = new DtcState()
    logger.info("DCP initialized", { tool: config.tool.enabled })
    return {
        "experimental.chat.messages.transform": createTransformHandler({
            client: ctx.client,
            state,
            config: config.dtc,
            logger,
        }),
        "experimental.session.compacting": createSessionCompactingHandler({ state, logger }),
        "chat.params": createChatParamsHandler({ state, logger }),
        event: createEventHandler({ state, logger }),
        ...(config.tool.enabled && {
            tool: { [PRUNE_TOOL_NAME]: createPruneTool({ state, logger }) },
        }),
    }
}) satisfies Plugin

export default server
