import assert from "node:assert/strict"
import test from "node:test"
import { AutoPruner, jaccard, tokenize } from "../lib/auto-prune"
import type { AutoPruneConfig } from "../lib/config"
import { textParts } from "./fixtures"

function config(overrides: Partial<AutoPruneConfig> = {}): AutoPruneConfig {
    return {
        enabled: true,
        minMessages: 4,
        volumeThreshold: 30,
        driftThreshold: 0.18,
        idleGapMs: 60_000,
        cooldownMs: 0,
        ...overrides,
    }
}

const SAME_TOPIC = [
    "帮我修复登录页面的样式问题",
    "登录页面的按钮还是偏了，继续修复样式",
    "样式修好了，再检查一下登录页面的输入框",
]
const OTHER_TOPIC = "部署 Kubernetes 集群并配置数据库定时备份"

test("tokenize lowercases latin words", () => {
    assert.deepEqual([...tokenize("Fix Login Page")].sort(), ["fix", "login", "page"])
})

test("tokenize splits CJK runs into character bigrams", () => {
    const tokens = tokenize("上下文")
    assert.equal(tokens.size, 2)
    assert.ok(tokens.has("上下"))
    assert.ok(tokens.has("下文"))
})

test("jaccard is 1 for identical sets and 0 for disjoint sets", () => {
    const a = tokenize("修复登录页面")
    assert.equal(jaccard(a, a), 1)
    assert.equal(jaccard(a, tokenize("部署数据库集群")), 0)
})

test("no signal fires before minMessages", () => {
    const pruner = new AutoPruner(config({ minMessages: 10 }))
    for (let index = 0; index < 9; index++) {
        const result = pruner.observeUserMessage("s1", textParts(`消息 ${index}`), index * 1000)
        assert.deepEqual(result.signals, [])
    }
})

test("topic change after an established thread signals topic-drift", () => {
    const pruner = new AutoPruner(config())
    for (let index = 0; index < SAME_TOPIC.length; index++) {
        pruner.observeUserMessage("s1", textParts(SAME_TOPIC[index]), index * 1000)
    }
    const result = pruner.observeUserMessage("s1", textParts(OTHER_TOPIC), 4000)
    assert.deepEqual(result.signals, ["topic-drift"])
})

test("short follow-up messages do not fake a topic change", () => {
    const pruner = new AutoPruner(config())
    for (let index = 0; index < SAME_TOPIC.length; index++) {
        pruner.observeUserMessage("s1", textParts(SAME_TOPIC[index]), index * 1000)
    }
    const result = pruner.observeUserMessage("s1", textParts("继续"), 4000)
    assert.deepEqual(result.signals, [])
})

test("a real topic change right after short follow-ups still signals drift", () => {
    const pruner = new AutoPruner(config())
    for (let index = 0; index < SAME_TOPIC.length; index++) {
        pruner.observeUserMessage("s1", textParts(SAME_TOPIC[index]), index * 1000)
    }
    pruner.observeUserMessage("s1", textParts("继续"), 4000)
    const result = pruner.observeUserMessage("s1", textParts(OTHER_TOPIC), 5000)
    assert.deepEqual(result.signals, ["topic-drift"])
})

test("continuing the same topic does not signal drift", () => {
    const pruner = new AutoPruner(config())
    for (let index = 0; index < SAME_TOPIC.length; index++) {
        pruner.observeUserMessage("s1", textParts(SAME_TOPIC[index]), index * 1000)
    }
    const result = pruner.observeUserMessage(
        "s1",
        textParts("登录页面的样式已经全部修复，提交代码"),
        4000,
    )
    assert.deepEqual(result.signals, [])
})

test("volume threshold signals when reached since the last prune", () => {
    const pruner = new AutoPruner(config({ minMessages: 1, volumeThreshold: 3 }))
    pruner.observeUserMessage("s1", textParts("一"), 0)
    pruner.observeUserMessage("s1", textParts("二"), 1000)
    const third = pruner.observeUserMessage("s1", textParts("三"), 2000)
    assert.deepEqual(third.signals, ["volume"])

    pruner.markPruned("s1", 3000)
    const after = pruner.observeUserMessage("s1", textParts("四"), 4000)
    assert.deepEqual(after.signals, [])
})

test("long idle gap signals resume-after-break once enough history exists", () => {
    const pruner = new AutoPruner(config({ idleGapMs: 5_000 }))
    for (let index = 0; index < 3; index++) {
        pruner.observeUserMessage("s1", textParts(SAME_TOPIC[index]), index * 1000)
    }
    const result = pruner.observeUserMessage("s1", textParts("继续之前的任务"), 60_000)
    assert.ok(result.signals.includes("idle-gap"))
})

test("consumePending returns signals once and clears them", () => {
    const pruner = new AutoPruner(config({ minMessages: 1, volumeThreshold: 2 }))
    pruner.observeUserMessage("s1", textParts("一"), 0)
    pruner.observeUserMessage("s1", textParts("二"), 1000)

    const first = pruner.consumePending("s1")
    assert.ok(first)
    assert.deepEqual(first, ["volume"])
    assert.equal(pruner.consumePending("s1"), null)
})

test("consumePending drops pending signals while cooling down", () => {
    const pruner = new AutoPruner(
        config({ minMessages: 1, volumeThreshold: 2, cooldownMs: 10_000 }),
    )
    pruner.markPruned("s1", 0)
    pruner.observeUserMessage("s1", textParts("一"), 1000)
    pruner.observeUserMessage("s1", textParts("二"), 2000)
    assert.deepEqual(pruner.consumePending("s1", 3000), null)
    assert.equal(pruner.consumePending("s1", 3000), null)
})

test("markPruned resets counters so volume does not refire immediately", () => {
    const pruner = new AutoPruner(config({ minMessages: 1, volumeThreshold: 2 }))
    pruner.observeUserMessage("s1", textParts("一"), 0)
    pruner.observeUserMessage("s1", textParts("二"), 1000)
    pruner.consumePending("s1")

    pruner.markPruned("s1", 2000)
    const result = pruner.observeUserMessage("s1", textParts("三"), 3000)
    assert.deepEqual(result.signals, [])
})

test("sessions are independent", () => {
    const pruner = new AutoPruner(config({ minMessages: 1, volumeThreshold: 2 }))
    pruner.observeUserMessage("s1", textParts("一"), 0)
    pruner.observeUserMessage("s1", textParts("二"), 1000)
    assert.ok(pruner.consumePending("s1"))
    assert.equal(pruner.consumePending("s2"), null)
})

test("dropSession forgets all state for the session", () => {
    const pruner = new AutoPruner(config({ minMessages: 1, volumeThreshold: 2 }))
    pruner.observeUserMessage("s1", textParts("一"), 0)
    pruner.observeUserMessage("s1", textParts("二"), 1000)
    pruner.dropSession("s1")
    assert.equal(pruner.consumePending("s1"), null)
})
