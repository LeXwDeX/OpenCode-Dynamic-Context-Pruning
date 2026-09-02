import assert from "node:assert/strict"
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import test from "node:test"

const configHome = mkdtempSync(join(tmpdir(), "opencode-dcp-migration-"))
process.env.XDG_CONFIG_HOME = configHome
mkdirSync(join(configHome, "opencode"), { recursive: true })

const LEGACY_CONFIG = {
    compress: {
        mode: "message",
        permission: "ask",
        showCompression: true,
        summaryBuffer: false,
        maxContextLimit: "80%",
        minContextLimit: "40%",
        boundaryNudge: false,
        nudgeFrequency: 3,
        iterationNudgeThreshold: 10,
        nudgeForce: "soft",
        protectedTools: ["task"],
        protectTags: true,
        protectUserMessages: true,
        externalModel: { url: "http://localhost:1234/v1", model: "local" },
    },
    manualMode: { enabled: true, automaticStrategies: false },
}

function buildCtx() {
    return {
        directory: mkdtempSync(join(tmpdir(), "opencode-dcp-migration-project-")),
        client: { tui: { showToast: async () => {} } },
    } as any
}

test("legacy compress and manualMode keys are reported as deprecated", async () => {
    const { getDeprecatedConfigKeys } = await import("../lib/config")
    const deprecated = getDeprecatedConfigKeys(LEGACY_CONFIG as any)

    assert.ok(deprecated.includes("compress"))
    assert.ok(deprecated.includes("compress.mode"))
    assert.ok(deprecated.includes("compress.permission"))
    assert.ok(deprecated.includes("compress.externalModel.url"))
    assert.ok(deprecated.includes("manualMode"))
    assert.ok(deprecated.includes("manualMode.enabled"))
})

test("deprecated keys are not reported as unknown keys", async () => {
    const { getInvalidConfigKeys, getDeprecatedConfigKeys } = await import("../lib/config")
    const input = { ...LEGACY_CONFIG, totallyUnknown: 1 } as any

    const invalid = getInvalidConfigKeys(input)
    const deprecated = getDeprecatedConfigKeys(input)

    for (const key of deprecated) {
        assert.equal(invalid.includes(key), false, `${key} is deprecated, not unknown`)
    }
    assert.ok(invalid.includes("totallyUnknown"))
})

test("VALID_CONFIG_KEYS no longer contains legacy compression keys", async () => {
    const { VALID_CONFIG_KEYS } = await import("../lib/config")

    for (const key of [
        "compress",
        "compress.mode",
        "compress.permission",
        "compress.nudgeFrequency",
        "compress.externalModel",
        "manualMode",
        "manualMode.enabled",
    ]) {
        assert.equal(VALID_CONFIG_KEYS.has(key), false, `${key} must be removed from valid keys`)
    }
})

test("getConfig ignores legacy keys and still applies supported ones", async () => {
    writeFileSync(
        join(configHome, "opencode", "dcp.jsonc"),
        JSON.stringify({
            autoUpdate: false,
            strategies: { purgeErrors: { turns: 8 } },
            ...LEGACY_CONFIG,
        }),
        "utf-8",
    )

    const { getConfig } = await import("../lib/config")
    const config = getConfig(buildCtx())

    assert.equal(config.autoUpdate, false)
    assert.equal("strategies" in config, false, "legacy strategies must be dropped")
    assert.equal("compress" in config, false, "compress section must be dropped")
    assert.equal("manualMode" in config, false, "manualMode section must be dropped")
})

test("default config no longer exposes compression or manual mode", async () => {
    writeFileSync(join(configHome, "opencode", "dcp.jsonc"), "{}", "utf-8")

    const { getConfig } = await import("../lib/config")
    const config = getConfig(buildCtx())

    assert.equal("compress" in config, false)
    assert.equal("manualMode" in config, false)
    assert.equal("summarize" in config, false)
    assert.equal("autoPrune" in config, false)
    assert.equal("language" in config, false)
    assert.equal("experimental" in config, false)
    assert.equal(config.enabled, true)
    assert.equal(config.commands.enabled, true)
    assert.equal(config.dtc.enabled, true)
    assert.equal(config.dtc.tailTurns, 4)
})

test("autoPrune, summarize, language and experimental keys are deprecated, not unknown", async () => {
    const { getDeprecatedConfigKeys, getInvalidConfigKeys } = await import("../lib/config")
    const input = {
        autoPrune: { enabled: true, signals: { topicDrift: true }, cooldownMs: 1000 },
        summarize: { failureCooldownMs: 30_000 },
        language: "zh",
        experimental: { customPrompts: true },
    }
    const deprecated = getDeprecatedConfigKeys(input)
    const invalid = getInvalidConfigKeys(input)
    assert.ok(deprecated.includes("autoPrune"))
    assert.ok(deprecated.includes("autoPrune.signals.topicDrift"))
    assert.ok(deprecated.includes("summarize.failureCooldownMs"))
    assert.ok(deprecated.includes("language"))
    assert.ok(deprecated.includes("experimental"))
    assert.ok(deprecated.includes("experimental.customPrompts"))
    assert.equal(invalid.length, 0)
})

test("legacy autoPrune.driftThreshold migrates to dtc.driftThreshold", async () => {
    writeFileSync(
        join(configHome, "opencode", "dcp.jsonc"),
        JSON.stringify({ autoPrune: { driftThreshold: 0.1 } }),
        "utf-8",
    )

    const { getConfig } = await import("../lib/config")
    const config = getConfig(buildCtx())

    assert.equal(config.dtc.driftThreshold, 0.1)
    writeFileSync(join(configHome, "opencode", "dcp.jsonc"), "{}", "utf-8")
})

test("an explicit dtc.driftThreshold wins over the legacy key", async () => {
    writeFileSync(
        join(configHome, "opencode", "dcp.jsonc"),
        JSON.stringify({ dtc: { driftThreshold: 0.3 }, autoPrune: { driftThreshold: 0.1 } }),
        "utf-8",
    )

    const { getConfig } = await import("../lib/config")
    const config = getConfig(buildCtx())

    assert.equal(config.dtc.driftThreshold, 0.3)
    writeFileSync(join(configHome, "opencode", "dcp.jsonc"), "{}", "utf-8")
})

test("dtc keys are valid and type-checked", async () => {
    const { VALID_CONFIG_KEYS, validateConfigTypes } = await import("../lib/config")
    for (const key of [
        "dtc",
        "dtc.enabled",
        "dtc.tailTurns",
        "dtc.lowWatermarkRatio",
        "dtc.targetRatio",
        "dtc.driftThreshold",
        "dtc.toolOutputKeepChars",
    ]) {
        assert.equal(VALID_CONFIG_KEYS.has(key), true, `${key} must be a valid config key`)
    }
    const errors = validateConfigTypes({
        dtc: { enabled: "yes", tailTurns: -1, targetRatio: 5 },
    })
    assert.ok(errors.some((e) => e.key === "dtc.enabled"))
    assert.ok(errors.some((e) => e.key === "dtc.tailTurns"))
    assert.ok(errors.some((e) => e.key === "dtc.targetRatio"))
})

test("invalid supported values warn but do not replace safe defaults", async () => {
    writeFileSync(
        join(configHome, "opencode", "dcp.jsonc"),
        JSON.stringify({
            enabled: "yes",
            commands: { enabled: "yes" },
            dtc: { tailTurns: -3, toolOutputKeepChars: 10 },
        }),
        "utf-8",
    )

    const { getConfig } = await import("../lib/config")
    const config = getConfig(buildCtx())

    assert.equal(config.enabled, true)
    assert.equal(config.commands.enabled, true)
    assert.equal(config.dtc.tailTurns, 4)
    assert.equal(config.dtc.toolOutputKeepChars, 4000)
    writeFileSync(join(configHome, "opencode", "dcp.jsonc"), "{}", "utf-8")
})
