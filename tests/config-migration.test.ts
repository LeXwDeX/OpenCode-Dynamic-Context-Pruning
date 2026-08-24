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
    assert.equal(config.enabled, true)
    assert.equal(config.commands.enabled, true)
    assert.equal(config.experimental.customPrompts, false)
    assert.equal(config.summarize.failureCooldownMs, 30_000)
})

test("invalid supported values warn but do not replace safe defaults", async () => {
    writeFileSync(
        join(configHome, "opencode", "dcp.jsonc"),
        JSON.stringify({
            enabled: "yes",
            commands: { enabled: "yes" },
            summarize: { failureCooldownMs: -1 },
        }),
        "utf-8",
    )

    const { getConfig } = await import("../lib/config")
    const config = getConfig(buildCtx())

    assert.equal(config.enabled, true)
    assert.equal(config.commands.enabled, true)
    assert.equal(config.summarize.failureCooldownMs, 30_000)
})
