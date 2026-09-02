import { readFileSync, writeFileSync, existsSync, mkdirSync, statSync } from "fs"
import { join, dirname } from "path"
import { homedir } from "os"
import * as jsoncParser from "jsonc-parser"
import type { PluginInput } from "@opencode-ai/plugin"
import { DTC_DEFAULTS, type DtcConfig } from "./dtc/engine"

export interface Commands {
    enabled: boolean
}

export interface ExperimentalConfig {
    customPrompts: boolean
}

/** DTC engine knobs plus the master switch for request-time compression. */
export interface DtcPluginConfig extends DtcConfig {
    enabled: boolean
}

export interface ToolConfig {
    enabled: boolean
}

export type DcpLanguage = "zh" | "en"

export interface PluginConfig {
    enabled: boolean
    autoUpdate: boolean
    debug: boolean
    language: DcpLanguage
    commands: Commands
    experimental: ExperimentalConfig
    dtc: DtcPluginConfig
    tool: ToolConfig
}

export const DEFAULT_DTC: DtcPluginConfig = {
    enabled: true,
    ...DTC_DEFAULTS,
}

export const VALID_CONFIG_KEYS = new Set([
    "$schema",
    "enabled",
    "autoUpdate",
    "debug",
    "language",
    "commands",
    "commands.enabled",
    "experimental",
    "experimental.customPrompts",
    "dtc",
    "dtc.enabled",
    "dtc.tailTurns",
    "dtc.lowWatermarkRatio",
    "dtc.targetRatio",
    "dtc.driftThreshold",
    "dtc.toolOutputKeepChars",
    "tool",
    "tool.enabled",
])

// Keys that only existed in earlier plugin-owned compression architectures.
// They are recognized so users get a migration hint instead of an "unknown
// key" warning; their values are dropped. autoPrune.* is superseded by the
// always-on request-time DTC engine; driftThreshold migrates to dtc.*.
export const DEPRECATED_CONFIG_KEYS = new Set([
    "compress",
    "compress.mode",
    "compress.permission",
    "compress.showCompression",
    "compress.summaryBuffer",
    "compress.maxContextLimit",
    "compress.minContextLimit",
    "compress.boundaryNudge",
    "compress.modelMaxLimits",
    "compress.modelMinLimits",
    "compress.nudgeFrequency",
    "compress.iterationNudgeThreshold",
    "compress.nudgeForce",
    "compress.protectedTools",
    "compress.protectTags",
    "compress.protectUserMessages",
    "compress.externalModel",
    "compress.externalModel.url",
    "compress.externalModel.model",
    "compress.externalModel.apiKey",
    "compress.externalModel.timeout",
    "compress.externalModel.retries",
    "manualMode",
    "manualMode.enabled",
    "manualMode.automaticStrategies",
    "strategies",
    "strategies.deduplication",
    "strategies.deduplication.enabled",
    "strategies.deduplication.protectedTools",
    "strategies.purgeErrors",
    "strategies.purgeErrors.enabled",
    "strategies.purgeErrors.turns",
    "strategies.purgeErrors.protectedTools",
    "turnProtection",
    "turnProtection.enabled",
    "turnProtection.turns",
    "pruneNotification",
    "pruneNotificationType",
    "protectedFilePatterns",
    "commands.protectedTools",
    "experimental.allowSubAgents",
    "summarize",
    "summarize.failureCooldownMs",
    "autoPrune",
    "autoPrune.enabled",
    "autoPrune.signals",
    "autoPrune.signals.topicDrift",
    "autoPrune.signals.volume",
    "autoPrune.signals.idleGap",
    "autoPrune.autoContinue",
    "autoPrune.minMessages",
    "autoPrune.volumeThreshold",
    "autoPrune.driftThreshold",
    "autoPrune.idleGapMs",
    "autoPrune.cooldownMs",
])

function getConfigKeyPaths(obj: Record<string, any>, prefix = ""): string[] {
    const keys: string[] = []
    for (const key of Object.keys(obj)) {
        const fullKey = prefix ? `${prefix}.${key}` : key
        keys.push(fullKey)

        if (obj[key] && typeof obj[key] === "object" && !Array.isArray(obj[key])) {
            keys.push(...getConfigKeyPaths(obj[key], fullKey))
        }
    }
    return keys
}

export function getDeprecatedConfigKeys(userConfig: Record<string, any>): string[] {
    return getConfigKeyPaths(userConfig).filter((key) => DEPRECATED_CONFIG_KEYS.has(key))
}

export function getInvalidConfigKeys(userConfig: Record<string, any>): string[] {
    return getConfigKeyPaths(userConfig).filter(
        (key) => !VALID_CONFIG_KEYS.has(key) && !DEPRECATED_CONFIG_KEYS.has(key),
    )
}

interface ValidationError {
    key: string
    expected: string
    actual: string
}

export function validateConfigTypes(config: Record<string, any>): ValidationError[] {
    const errors: ValidationError[] = []

    if (config.enabled !== undefined && typeof config.enabled !== "boolean") {
        errors.push({ key: "enabled", expected: "boolean", actual: typeof config.enabled })
    }

    if (config.autoUpdate !== undefined && typeof config.autoUpdate !== "boolean") {
        errors.push({ key: "autoUpdate", expected: "boolean", actual: typeof config.autoUpdate })
    }

    if (config.debug !== undefined && typeof config.debug !== "boolean") {
        errors.push({ key: "debug", expected: "boolean", actual: typeof config.debug })
    }

    if (config.language !== undefined && config.language !== "zh" && config.language !== "en") {
        errors.push({
            key: "language",
            expected: '"zh" or "en"',
            actual: JSON.stringify(config.language),
        })
    }

    const commands = config.commands
    if (commands !== undefined) {
        if (typeof commands !== "object" || commands === null || Array.isArray(commands)) {
            errors.push({ key: "commands", expected: "object", actual: typeof commands })
        } else if (commands.enabled !== undefined && typeof commands.enabled !== "boolean") {
            errors.push({
                key: "commands.enabled",
                expected: "boolean",
                actual: typeof commands.enabled,
            })
        }
    }

    const experimental = config.experimental
    if (experimental !== undefined) {
        if (
            typeof experimental !== "object" ||
            experimental === null ||
            Array.isArray(experimental)
        ) {
            errors.push({ key: "experimental", expected: "object", actual: typeof experimental })
        } else if (
            experimental.customPrompts !== undefined &&
            typeof experimental.customPrompts !== "boolean"
        ) {
            errors.push({
                key: "experimental.customPrompts",
                expected: "boolean",
                actual: typeof experimental.customPrompts,
            })
        }
    }

    const dtc = config.dtc
    if (dtc !== undefined) {
        if (typeof dtc !== "object" || dtc === null || Array.isArray(dtc)) {
            errors.push({ key: "dtc", expected: "object", actual: typeof dtc })
        } else {
            if (dtc.enabled !== undefined && typeof dtc.enabled !== "boolean") {
                errors.push({ key: "dtc.enabled", expected: "boolean", actual: typeof dtc.enabled })
            }
            const numericKeys: Array<[string, number, number]> = [
                ["tailTurns", 0, Number.POSITIVE_INFINITY],
                ["lowWatermarkRatio", 0, 1],
                ["targetRatio", 0, 1],
                ["driftThreshold", 0, 1],
                ["toolOutputKeepChars", 200, Number.POSITIVE_INFINITY],
            ]
            for (const [key, min, max] of numericKeys) {
                const value = (dtc as Record<string, any>)[key]
                if (
                    value !== undefined &&
                    (typeof value !== "number" ||
                        !Number.isFinite(value) ||
                        value < min ||
                        value > max)
                ) {
                    errors.push({
                        key: `dtc.${key}`,
                        expected: `number in [${min}, ${max === Number.POSITIVE_INFINITY ? "∞" : max}]`,
                        actual: JSON.stringify(value),
                    })
                }
            }
        }
    }

    const tool = config.tool
    if (tool !== undefined) {
        if (typeof tool !== "object" || tool === null || Array.isArray(tool)) {
            errors.push({ key: "tool", expected: "object", actual: typeof tool })
        } else if (tool.enabled !== undefined && typeof tool.enabled !== "boolean") {
            errors.push({ key: "tool.enabled", expected: "boolean", actual: typeof tool.enabled })
        }
    }

    return errors
}

/** Legacy autoPrune.driftThreshold migrates to dtc.driftThreshold. */
export function legacyDriftThreshold(configData: Record<string, any>): number | undefined {
    const autoPrune = configData.autoPrune
    if (autoPrune === null || typeof autoPrune !== "object" || Array.isArray(autoPrune)) {
        return undefined
    }
    const value = (autoPrune as Record<string, any>).driftThreshold
    return typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 1
        ? value
        : undefined
}

function showConfigWarnings(
    ctx: PluginInput,
    configPath: string,
    configData: Record<string, any>,
    isProject: boolean,
): void {
    const invalidKeys = getInvalidConfigKeys(configData)
    const deprecatedKeys = getDeprecatedConfigKeys(configData)
    const typeErrors = validateConfigTypes(configData)

    if (invalidKeys.length === 0 && deprecatedKeys.length === 0 && typeErrors.length === 0) {
        return
    }

    const configType = isProject ? "project config" : "config"
    const messages: string[] = []

    if (deprecatedKeys.length > 0) {
        const keyList = deprecatedKeys.slice(0, 3).join(", ")
        const suffix = deprecatedKeys.length > 3 ? ` (+${deprecatedKeys.length - 3} more)` : ""
        messages.push(
            `Removed legacy keys are ignored: ${keyList}${suffix}. Compression now runs as dynamic request-time folding (dtc.*).`,
        )
    }

    if (invalidKeys.length > 0) {
        const keyList = invalidKeys.slice(0, 3).join(", ")
        const suffix = invalidKeys.length > 3 ? ` (+${invalidKeys.length - 3} more)` : ""
        messages.push(`Unknown keys: ${keyList}${suffix}`)
    }

    if (typeErrors.length > 0) {
        for (const err of typeErrors.slice(0, 2)) {
            messages.push(`${err.key}: expected ${err.expected}, got ${err.actual}`)
        }
        if (typeErrors.length > 2) {
            messages.push(`(+${typeErrors.length - 2} more type errors)`)
        }
    }

    setTimeout(() => {
        try {
            ctx.client.tui.showToast({
                body: {
                    title: `DCP: ${configType} warning`,
                    message: `${configPath}\n${messages.join("\n")}`,
                    variant: "warning",
                    duration: 7000,
                },
            })
        } catch {}
    }, 7000)
}

const defaultConfig: PluginConfig = {
    enabled: true,
    autoUpdate: true,
    debug: false,
    language: "zh",
    commands: {
        enabled: true,
    },
    experimental: {
        customPrompts: false,
    },
    dtc: { ...DEFAULT_DTC },
    tool: {
        enabled: true,
    },
}

const GLOBAL_CONFIG_DIR = process.env.XDG_CONFIG_HOME
    ? join(process.env.XDG_CONFIG_HOME, "opencode")
    : join(homedir(), ".config", "opencode")
const GLOBAL_CONFIG_PATH_JSONC = join(GLOBAL_CONFIG_DIR, "dcp.jsonc")
const GLOBAL_CONFIG_PATH_JSON = join(GLOBAL_CONFIG_DIR, "dcp.json")

function findOpencodeDir(startDir: string): string | null {
    let current = startDir
    while (current !== "/") {
        const candidate = join(current, ".opencode")
        if (existsSync(candidate) && statSync(candidate).isDirectory()) {
            return candidate
        }
        const parent = dirname(current)
        if (parent === current) {
            break
        }
        current = parent
    }
    return null
}

function getConfigPaths(ctx?: PluginInput): {
    global: string | null
    configDir: string | null
    project: string | null
} {
    const global = existsSync(GLOBAL_CONFIG_PATH_JSONC)
        ? GLOBAL_CONFIG_PATH_JSONC
        : existsSync(GLOBAL_CONFIG_PATH_JSON)
          ? GLOBAL_CONFIG_PATH_JSON
          : null

    let configDir: string | null = null
    const opencodeConfigDir = process.env.OPENCODE_CONFIG_DIR
    if (opencodeConfigDir) {
        const configJsonc = join(opencodeConfigDir, "dcp.jsonc")
        const configJson = join(opencodeConfigDir, "dcp.json")
        configDir = existsSync(configJsonc)
            ? configJsonc
            : existsSync(configJson)
              ? configJson
              : null
    }

    let project: string | null = null
    if (ctx?.directory) {
        const opencodeDir = findOpencodeDir(ctx.directory)
        if (opencodeDir) {
            const projectJsonc = join(opencodeDir, "dcp.jsonc")
            const projectJson = join(opencodeDir, "dcp.json")
            project = existsSync(projectJsonc)
                ? projectJsonc
                : existsSync(projectJson)
                  ? projectJson
                  : null
        }
    }

    return { global, configDir, project }
}

function createDefaultConfig(): void {
    if (!existsSync(GLOBAL_CONFIG_DIR)) {
        mkdirSync(GLOBAL_CONFIG_DIR, { recursive: true })
    }

    const configContent = `{
  "$schema": "https://raw.githubusercontent.com/LeXwDeX/opencode-dynamic-context-pruning/master/dcp.schema.json"
}
`
    writeFileSync(GLOBAL_CONFIG_PATH_JSONC, configContent, "utf-8")
}

interface ConfigLoadResult {
    data: Record<string, any> | null
    parseError?: string
}

function loadConfigFile(configPath: string): ConfigLoadResult {
    let fileContent = ""
    try {
        fileContent = readFileSync(configPath, "utf-8")
    } catch {
        return { data: null }
    }

    try {
        const parsed = jsoncParser.parse(fileContent, undefined, { allowTrailingComma: true })
        if (parsed === undefined || parsed === null) {
            return { data: null, parseError: "Config file is empty or invalid" }
        }
        return { data: parsed }
    } catch (error: any) {
        return { data: null, parseError: error.message || "Failed to parse config" }
    }
}

function mergeCommands(
    base: PluginConfig["commands"],
    override?: Partial<PluginConfig["commands"]>,
): PluginConfig["commands"] {
    if (!override) {
        return base
    }

    return {
        enabled: typeof override.enabled === "boolean" ? override.enabled : base.enabled,
    }
}

function mergeExperimental(
    base: PluginConfig["experimental"],
    override?: Partial<PluginConfig["experimental"]>,
): PluginConfig["experimental"] {
    if (!override) {
        return base
    }

    return {
        customPrompts:
            typeof override.customPrompts === "boolean"
                ? override.customPrompts
                : base.customPrompts,
    }
}

function mergeDtc(
    base: DtcPluginConfig,
    override?: Record<string, any>,
    legacyDrift?: number,
): DtcPluginConfig {
    const driftFallback = legacyDrift ?? base.driftThreshold
    if (!override || typeof override !== "object" || Array.isArray(override)) {
        return { ...base, driftThreshold: driftFallback }
    }

    const number = (key: keyof DtcConfig, min: number, max: number): number =>
        typeof override[key] === "number" &&
        Number.isFinite(override[key]) &&
        override[key] >= min &&
        override[key] <= max
            ? override[key]
            : (base[key] as number)

    return {
        enabled: typeof override.enabled === "boolean" ? override.enabled : base.enabled,
        tailTurns: number("tailTurns", 0, Number.POSITIVE_INFINITY),
        lowWatermarkRatio: number("lowWatermarkRatio", 0, 1),
        targetRatio: number("targetRatio", 0, 1),
        driftThreshold:
            typeof override.driftThreshold === "number" &&
            Number.isFinite(override.driftThreshold) &&
            override.driftThreshold >= 0 &&
            override.driftThreshold <= 1
                ? override.driftThreshold
                : driftFallback,
        toolOutputKeepChars: number("toolOutputKeepChars", 200, Number.POSITIVE_INFINITY),
    }
}

function mergeTool(base: ToolConfig, override?: Partial<ToolConfig>): ToolConfig {
    if (!override) {
        return base
    }

    return {
        enabled: typeof override.enabled === "boolean" ? override.enabled : base.enabled,
    }
}

function deepCloneConfig(config: PluginConfig): PluginConfig {
    return {
        ...config,
        commands: { ...config.commands },
        experimental: { ...config.experimental },
        dtc: { ...config.dtc },
        tool: { ...config.tool },
    }
}

function mergeLayer(config: PluginConfig, data: Record<string, any>): PluginConfig {
    return {
        enabled: typeof data.enabled === "boolean" ? data.enabled : config.enabled,
        autoUpdate: typeof data.autoUpdate === "boolean" ? data.autoUpdate : config.autoUpdate,
        debug: typeof data.debug === "boolean" ? data.debug : config.debug,
        language:
            data.language === "zh" || data.language === "en" ? data.language : config.language,
        commands: mergeCommands(config.commands, data.commands),
        experimental: mergeExperimental(config.experimental, data.experimental),
        dtc: mergeDtc(config.dtc, data.dtc, legacyDriftThreshold(data)),
        tool: mergeTool(config.tool, data.tool),
    }
}

function scheduleParseWarning(ctx: PluginInput, title: string, message: string): void {
    setTimeout(() => {
        try {
            ctx.client.tui.showToast({
                body: {
                    title,
                    message,
                    variant: "warning",
                    duration: 7000,
                },
            })
        } catch {}
    }, 7000)
}

export function getConfig(ctx: PluginInput): PluginConfig {
    let config = deepCloneConfig(defaultConfig)
    const configPaths = getConfigPaths(ctx)

    if (!configPaths.global) {
        createDefaultConfig()
    }

    const layers: Array<{ path: string | null; name: string; isProject: boolean }> = [
        { path: configPaths.global, name: "config", isProject: false },
        { path: configPaths.configDir, name: "configDir config", isProject: true },
        { path: configPaths.project, name: "project config", isProject: true },
    ]

    for (const layer of layers) {
        if (!layer.path) {
            continue
        }

        const result = loadConfigFile(layer.path)
        if (result.parseError) {
            scheduleParseWarning(
                ctx,
                `DCP: Invalid ${layer.name}`,
                `${layer.path}\n${result.parseError}\nUsing previous/default values`,
            )
            continue
        }

        if (!result.data) {
            continue
        }

        showConfigWarnings(ctx, layer.path, result.data, layer.isProject)
        config = mergeLayer(config, result.data)
    }

    return config
}
