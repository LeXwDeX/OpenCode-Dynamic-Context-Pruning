import { existsSync, readFileSync, statSync } from "node:fs"
import { dirname, join } from "node:path"
import { homedir } from "node:os"
import type { PluginInput } from "@opencode-ai/plugin"
import * as jsoncParser from "jsonc-parser"
import { DTC_DEFAULTS, type DtcConfig } from "./dtc/engine"

export interface DtcPluginConfig extends DtcConfig {
    enabled: boolean
}

export interface PluginConfig {
    enabled: boolean
    autoUpdate: boolean
    debug: boolean
    dtc: DtcPluginConfig
    tool: { enabled: boolean }
}

export const DEFAULT_DTC: DtcPluginConfig = { enabled: true, ...DTC_DEFAULTS }

type RecordValue = Record<string, unknown>
type Rule = { expected: string; accepts: (value: unknown) => boolean }
const boolean: Rule = { expected: "boolean", accepts: (value) => typeof value === "boolean" }
const integer = (minimum: number): Rule => ({
    expected: `integer >= ${minimum}`,
    accepts: (value) =>
        typeof value === "number" && Number.isSafeInteger(value) && value >= minimum,
})
const rules: Record<string, Rule> = {
    enabled: boolean,
    autoUpdate: boolean,
    debug: boolean,
    "dtc.enabled": boolean,
    "dtc.protectRecentSteps": integer(1),
    "dtc.protectRecentTokens": integer(0),
    "dtc.targetRatio": {
        expected: "number in (0, 1]",
        accepts: (value) =>
            typeof value === "number" && Number.isFinite(value) && value > 0 && value <= 1,
    },
    "dtc.minimumSavingsTokens": integer(1),
    "dtc.protectedTools": {
        expected: "array of nonempty tool names",
        accepts: (value) =>
            Array.isArray(value) &&
            value.every((item) => typeof item === "string" && item.trim().length > 0),
    },
    "tool.enabled": boolean,
}

export const VALID_CONFIG_KEYS = new Set(["$schema", "dtc", "tool", ...Object.keys(rules)])

/** Migration diagnostics only: no legacy behavior is retained. */
export const DEPRECATED_CONFIG_KEYS = new Set([
    "commands",
    "compress",
    "manualMode",
    "strategies",
    "turnProtection",
    "pruneNotification",
    "pruneNotificationType",
    "protectedFilePatterns",
    "experimental",
    "language",
    "summarize",
    "autoPrune",
    "dtc.tailTurns",
    "dtc.lowWatermarkRatio",
    "dtc.driftThreshold",
    "dtc.toolOutputKeepChars",
    "dtc.mergeRuns",
])

function record(value: unknown): value is RecordValue {
    return value !== null && typeof value === "object" && !Array.isArray(value)
}

function keyPaths(value: RecordValue, prefix = ""): string[] {
    return Object.entries(value).flatMap(([key, child]) => {
        const path = prefix ? `${prefix}.${key}` : key
        return [path, ...(record(child) ? keyPaths(child, path) : [])]
    })
}

function retired(key: string): boolean {
    return [...DEPRECATED_CONFIG_KEYS].some(
        (prefix) => key === prefix || key.startsWith(prefix + "."),
    )
}

export function getDeprecatedConfigKeys(config: RecordValue): string[] {
    return keyPaths(config).filter(retired)
}

export function getInvalidConfigKeys(config: RecordValue): string[] {
    return keyPaths(config).filter((key) => !VALID_CONFIG_KEYS.has(key) && !retired(key))
}

function valueAt(config: RecordValue, key: string): unknown {
    const [section, field] = key.split(".")
    const value = config[section!]
    return field ? (record(value) ? value[field] : undefined) : value
}

export function validateConfigTypes(
    config: RecordValue,
): Array<{ key: string; expected: string; actual: string }> {
    const errors: Array<{ key: string; expected: string; actual: string }> = []
    for (const key of ["dtc", "tool"]) {
        if (config[key] !== undefined && !record(config[key])) {
            errors.push({ key, expected: "object", actual: typeof config[key] })
        }
    }
    for (const [key, rule] of Object.entries(rules)) {
        const value = valueAt(config, key)
        if (value !== undefined && !rule.accepts(value)) {
            errors.push({
                key,
                expected: rule.expected,
                actual: Array.isArray(value) ? "array" : typeof value,
            })
        }
    }
    return errors
}

function defaults(): PluginConfig {
    return {
        enabled: true,
        autoUpdate: true,
        debug: false,
        dtc: { ...DEFAULT_DTC, protectedTools: [...DTC_DEFAULTS.protectedTools] },
        tool: { enabled: true },
    }
}

function merge(base: PluginConfig, layer: RecordValue): void {
    for (const [key, rule] of Object.entries(rules)) {
        const value = valueAt(layer, key)
        if (value === undefined || !rule.accepts(value)) continue
        const [section, field] = key.split(".")
        // Writes are restricted to the validated, fixed rules above.
        const target = field
            ? (base[section as "dtc" | "tool"] as unknown as RecordValue)
            : (base as unknown as RecordValue)
        target[field ?? section!] = Array.isArray(value)
            ? [...new Set(value.map((item: string) => item.trim()))]
            : value
    }
}

function configFile(directory: string): string | undefined {
    return ["dcp.jsonc", "dcp.json"].map((name) => join(directory, name)).find(existsSync)
}

function projectConfig(directory: string): string | undefined {
    for (let current = directory; ; current = dirname(current)) {
        const candidate = join(current, ".opencode")
        if (existsSync(candidate) && statSync(candidate).isDirectory()) {
            const path = configFile(candidate)
            if (path) return path
        }
        if (dirname(current) === current) return undefined
    }
}

function warn(ctx: PluginInput, message: string): void {
    // Diagnostics never delay plugin initialization or create unhandled rejections.
    try {
        void Promise.resolve(
            ctx.client.tui.showToast({
                body: { title: "DCP configuration", message, variant: "warning", duration: 7000 },
            }),
        ).catch(() => undefined)
    } catch {}
}

export function getConfig(ctx: PluginInput): PluginConfig {
    const config = defaults()
    const globalDirectory = join(
        process.env.XDG_CONFIG_HOME || join(homedir(), ".config"),
        "opencode",
    )
    const paths = [
        configFile(globalDirectory),
        process.env.OPENCODE_CONFIG_DIR ? configFile(process.env.OPENCODE_CONFIG_DIR) : undefined,
        projectConfig(ctx.directory),
    ]
    for (const path of new Set(paths)) {
        if (!path) continue
        try {
            const errors: jsoncParser.ParseError[] = []
            const data: unknown = jsoncParser.parse(readFileSync(path, "utf8"), errors, {
                allowTrailingComma: true,
            })
            if (errors.length || !record(data)) {
                warn(ctx, `${path}: invalid JSONC object; this layer was ignored.`)
                continue
            }
            const deprecated = getDeprecatedConfigKeys(data)
            const invalid = getInvalidConfigKeys(data)
            const types = validateConfigTypes(data)
            const notices: string[] = []
            if (deprecated.length)
                notices.push(
                    `Retired options ignored: ${deprecated.join(", ")}. See the v6 migration guide; manual folding uses dcp_prune.`,
                )
            if (invalid.length) notices.push(`Unknown options ignored: ${invalid.join(", ")}.`)
            if (types.length)
                notices.push(
                    `Invalid values ignored: ${types.map(({ key, expected }) => `${key} (${expected})`).join(", ")}.`,
                )
            if (notices.length) warn(ctx, `${path}\n${notices.join("\n")}`)
            merge(config, data)
        } catch {
            warn(ctx, `${path}: unable to read configuration; this layer was ignored.`)
        }
    }
    return config
}
