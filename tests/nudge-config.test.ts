import assert from "node:assert/strict"
import test from "node:test"
import type { PluginConfig } from "../lib/config"
import { getIterationNudgeThreshold, getNudgeFrequency } from "../lib/messages/inject/utils"

test("nudge helpers honor configured intervals", () => {
    const config = {
        compress: {
            nudgeFrequency: 100,
            iterationNudgeThreshold: 250,
        },
    } as PluginConfig

    assert.equal(getNudgeFrequency(config), 100)
    assert.equal(getIterationNudgeThreshold(config), 250)
})

test("nudge helpers fall back safely for non-finite intervals", () => {
    const config = {
        compress: {
            nudgeFrequency: Number.NaN,
            iterationNudgeThreshold: Number.POSITIVE_INFINITY,
        },
    } as PluginConfig

    assert.equal(getNudgeFrequency(config), 1)
    assert.equal(getIterationNudgeThreshold(config), 1)
})
