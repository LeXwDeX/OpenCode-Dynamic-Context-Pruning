import assert from "node:assert/strict"
import test from "node:test"
import { applyExternalModelEnvOverride } from "../lib/config-env-override"
import { getInvalidConfigKeys, validateConfigTypes, type PluginConfig } from "../lib/config"

function buildConfigFixture(): PluginConfig {
    return {
        enabled: true,
        autoUpdate: true,
        debug: false,
        pruneNotification: "off",
        pruneNotificationType: "chat",
        commands: {
            enabled: true,
            protectedTools: [],
        },
        manualMode: {
            enabled: false,
            automaticStrategies: true,
        },
        turnProtection: {
            enabled: false,
            turns: 4,
        },
        experimental: {
            allowSubAgents: false,
            customPrompts: false,
        },
        protectedFilePatterns: [],
        compress: {
            mode: "range",
            permission: "allow",
            showCompression: false,
            summaryBuffer: true,
            maxContextLimit: 150000,
            minContextLimit: 50000,
            nudgeFrequency: 5,
            iterationNudgeThreshold: 15,
            nudgeForce: "soft",
            protectedTools: [],
            protectTags: false,
            protectUserMessages: false,
            externalModel: undefined,
        },
        strategies: {
            deduplication: {
                enabled: true,
                protectedTools: [],
            },
            purgeErrors: {
                enabled: true,
                turns: 4,
                protectedTools: [],
            },
        },
    }
}

function withEnv(vars: Record<string, string | undefined>, fn: () => void): void {
    const previous: Record<string, string | undefined> = {}
    for (const key of Object.keys(vars)) {
        previous[key] = process.env[key]
        if (vars[key] === undefined) {
            delete process.env[key]
        } else {
            process.env[key] = vars[key]
        }
    }
    try {
        fn()
    } finally {
        for (const key of Object.keys(previous)) {
            if (previous[key] === undefined) {
                delete process.env[key]
            } else {
                process.env[key] = previous[key]
            }
        }
    }
}

test("env vars build externalModel when both url and model are present", () => {
    withEnv(
        {
            OPENCODE_DCP_EXTERNAL_COMPRESS_URL: "http://localhost:11434/v1",
            OPENCODE_DCP_EXTERNAL_COMPRESS_KEY: "test-key-123",
            OPENCODE_DCP_EXTERNAL_COMPRESS_MODEL: "qwen2.5:7b",
            OPENCODE_DCP_EXTERNAL_COMPRESS_TIMEOUT: "60000",
            OPENCODE_DCP_EXTERNAL_COMPRESS_RETRIES: "2",
        },
        () => {
            const config = buildConfigFixture()
            applyExternalModelEnvOverride(config)
            assert.ok(config.compress.externalModel)
            const ext = config.compress.externalModel!
            assert.equal(ext.url, "http://localhost:11434/v1")
            assert.equal(ext.apiKey, "test-key-123")
            assert.equal(ext.model, "qwen2.5:7b")
            assert.equal(ext.timeout, 60000)
            assert.equal(ext.retries, 2)
        },
    )
})

test("env var externalModel not created when env vars are not set", () => {
    withEnv(
        {
            OPENCODE_DCP_EXTERNAL_COMPRESS_URL: undefined,
            OPENCODE_DCP_EXTERNAL_COMPRESS_KEY: undefined,
            OPENCODE_DCP_EXTERNAL_COMPRESS_MODEL: undefined,
            OPENCODE_DCP_EXTERNAL_COMPRESS_TIMEOUT: undefined,
            OPENCODE_DCP_EXTERNAL_COMPRESS_RETRIES: undefined,
        },
        () => {
            const config = buildConfigFixture()
            applyExternalModelEnvOverride(config)
            assert.equal(config.compress.externalModel, undefined)
        },
    )
})

test("env var externalModel not created when only url is set (missing model)", () => {
    withEnv(
        {
            OPENCODE_DCP_EXTERNAL_COMPRESS_URL: "http://localhost:11434/v1",
            OPENCODE_DCP_EXTERNAL_COMPRESS_KEY: undefined,
            OPENCODE_DCP_EXTERNAL_COMPRESS_MODEL: undefined,
            OPENCODE_DCP_EXTERNAL_COMPRESS_TIMEOUT: undefined,
            OPENCODE_DCP_EXTERNAL_COMPRESS_RETRIES: undefined,
        },
        () => {
            const config = buildConfigFixture()
            applyExternalModelEnvOverride(config)
            assert.equal(config.compress.externalModel, undefined)
        },
    )
})

test("env var externalModel not created when only model is set (missing url)", () => {
    withEnv(
        {
            OPENCODE_DCP_EXTERNAL_COMPRESS_URL: undefined,
            OPENCODE_DCP_EXTERNAL_COMPRESS_KEY: undefined,
            OPENCODE_DCP_EXTERNAL_COMPRESS_MODEL: "qwen2.5:7b",
            OPENCODE_DCP_EXTERNAL_COMPRESS_TIMEOUT: undefined,
            OPENCODE_DCP_EXTERNAL_COMPRESS_RETRIES: undefined,
        },
        () => {
            const config = buildConfigFixture()
            applyExternalModelEnvOverride(config)
            assert.equal(config.compress.externalModel, undefined)
        },
    )
})

test("env var externalModel ignores invalid timeout value", () => {
    withEnv(
        {
            OPENCODE_DCP_EXTERNAL_COMPRESS_URL: "http://localhost:11434/v1",
            OPENCODE_DCP_EXTERNAL_COMPRESS_KEY: undefined,
            OPENCODE_DCP_EXTERNAL_COMPRESS_MODEL: "qwen2.5:7b",
            OPENCODE_DCP_EXTERNAL_COMPRESS_TIMEOUT: "not-a-number",
            OPENCODE_DCP_EXTERNAL_COMPRESS_RETRIES: undefined,
        },
        () => {
            const config = buildConfigFixture()
            applyExternalModelEnvOverride(config)
            assert.ok(config.compress.externalModel)
            assert.equal(config.compress.externalModel!.timeout, undefined)
        },
    )
})

test("env var externalModel ignores zero or negative timeout", () => {
    withEnv(
        {
            OPENCODE_DCP_EXTERNAL_COMPRESS_URL: "http://localhost:11434/v1",
            OPENCODE_DCP_EXTERNAL_COMPRESS_KEY: undefined,
            OPENCODE_DCP_EXTERNAL_COMPRESS_MODEL: "qwen2.5:7b",
            OPENCODE_DCP_EXTERNAL_COMPRESS_TIMEOUT: "0",
            OPENCODE_DCP_EXTERNAL_COMPRESS_RETRIES: undefined,
        },
        () => {
            const config = buildConfigFixture()
            applyExternalModelEnvOverride(config)
            assert.ok(config.compress.externalModel)
            assert.equal(config.compress.externalModel!.timeout, undefined)
        },
    )
})

test("env var externalModel accepts retries of 0", () => {
    withEnv(
        {
            OPENCODE_DCP_EXTERNAL_COMPRESS_URL: "http://localhost:11434/v1",
            OPENCODE_DCP_EXTERNAL_COMPRESS_KEY: undefined,
            OPENCODE_DCP_EXTERNAL_COMPRESS_MODEL: "qwen2.5:7b",
            OPENCODE_DCP_EXTERNAL_COMPRESS_TIMEOUT: undefined,
            OPENCODE_DCP_EXTERNAL_COMPRESS_RETRIES: "0",
        },
        () => {
            const config = buildConfigFixture()
            applyExternalModelEnvOverride(config)
            assert.ok(config.compress.externalModel)
            assert.equal(config.compress.externalModel!.retries, 0)
        },
    )
})

test("env var externalModel builds without optional fields when only url+model provided", () => {
    withEnv(
        {
            OPENCODE_DCP_EXTERNAL_COMPRESS_URL: "http://localhost:11434/v1",
            OPENCODE_DCP_EXTERNAL_COMPRESS_KEY: undefined,
            OPENCODE_DCP_EXTERNAL_COMPRESS_MODEL: "qwen2.5:7b",
            OPENCODE_DCP_EXTERNAL_COMPRESS_TIMEOUT: undefined,
            OPENCODE_DCP_EXTERNAL_COMPRESS_RETRIES: undefined,
        },
        () => {
            const config = buildConfigFixture()
            applyExternalModelEnvOverride(config)
            assert.ok(config.compress.externalModel)
            const ext = config.compress.externalModel!
            assert.equal(ext.url, "http://localhost:11434/v1")
            assert.equal(ext.model, "qwen2.5:7b")
            assert.equal(ext.apiKey, undefined)
            assert.equal(ext.timeout, undefined)
            assert.equal(ext.retries, undefined)
        },
    )
})

test("externalModel nested configuration keys are recognized", () => {
    assert.deepEqual(
        getInvalidConfigKeys({
            compress: {
                externalModel: {
                    url: "http://localhost:11434/v1",
                    model: "qwen",
                    apiKey: "secret",
                    timeout: 1000,
                    retries: 2,
                },
            },
        }),
        [],
    )
})

test("externalModel rejects invalid timeout and retries", () => {
    const errors = validateConfigTypes({
        compress: {
            externalModel: {
                url: "",
                model: "",
                timeout: 0,
                retries: -1,
            },
        },
    })

    assert.deepEqual(
        errors.map((error) => error.key),
        [
            "compress.externalModel.url",
            "compress.externalModel.model",
            "compress.externalModel.timeout",
            "compress.externalModel.retries",
        ],
    )
})
