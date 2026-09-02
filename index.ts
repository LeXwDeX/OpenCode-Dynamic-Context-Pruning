import type { Plugin } from "@opencode-ai/plugin"
import { getConfig } from "./lib/config"
import { DtcState } from "./lib/dtc/state"
import {
    createChatParamsHandler,
    createCommandExecuteHandler,
    createConfigHandler,
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
    // All DTC runtime state is in-memory and request-scoped by design: the
    // engine never writes to the session, so there is nothing to persist.
    const state = new DtcState()

    logger.info("DCP initialized", {
        commands: config.commands.enabled,
        dtc: config.dtc.enabled,
        tool: config.tool.enabled,
    })
    startAutoUpdate(ctx, config.autoUpdate)

    return {
        // THE compression surface: dynamic tiered folding on every model
        // request, plus the chat.params feed that teaches the engine each
        // session's context-window size. The compacting hook rides along
        // solely to keep the host's native compaction input unfolded — the
        // native prompt is never touched. With DTC off, DCP registers no
        // compaction-adjacent hook at all.
        ...(config.dtc.enabled && {
            "experimental.chat.messages.transform": createTransformHandler({
                state,
                config: config.dtc,
                logger,
            }),
            "chat.params": createChatParamsHandler({ state, logger }),
            "experimental.session.compacting": createSessionCompactingHandler({ state, logger }),
        }),
        // Lifecycle cleanup for DTC session state (LRU-bounded regardless).
        event: createEventHandler({ state, logger }),
        ...(config.tool.enabled && {
            tool: { [PRUNE_TOOL_NAME]: createPruneTool({ state, logger }) },
        }),
        ...(config.commands.enabled && {
            "command.execute.before": createCommandExecuteHandler({
                client: ctx.client,
                state,
                config: config.dtc,
                logger,
            }),
        }),
        // Always registered: besides the optional /dcp command it raises the
        // host's compaction tail protection to DCP's tiered defaults.
        config: createConfigHandler(config, logger),
    }
}) satisfies Plugin

export default server
