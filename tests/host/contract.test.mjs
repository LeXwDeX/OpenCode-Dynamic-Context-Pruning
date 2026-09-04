import assert from "node:assert/strict"
import { spawnSync } from "node:child_process"
import { fileURLToPath } from "node:url"
import test from "node:test"

function hostScenario(name) {
    const result = spawnSync(
        "bun",
        [fileURLToPath(new URL("./worker.mjs", import.meta.url)), name],
        { encoding: "utf8", timeout: 60_000, maxBuffer: 8 * 1024 * 1024 },
    )
    assert.ifError(result.error)
    assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`)
    const lines = result.stdout.trim().split("\n")
    assert.deepEqual(JSON.parse(lines.at(-1)), { scenario: name, ok: true })
}

test("host components: loader and dispatcher preserve the compaction prompt", () => {
    hostScenario("compaction-guard")
})

test("host components: 100 seeded tools hydrate, project, serialize and leave DB unchanged", () => {
    hostScenario("autonomous-task-wire")
})

test("host components: explicit model changes avoid stale session limits", () => {
    hostScenario("model-switch")
})

test("host compaction implementation: guard order and prompt with boundary doubles", () => {
    hostScenario("native-compaction-order")
})

test("host components: filterCompacted checkpoint prefix remains intact", () => {
    hostScenario("post-compaction-prefix")
})

function publicHostScenario(scenario = "public-host-loop") {
    const result = spawnSync(
        "bun",
        [fileURLToPath(new URL("./public-loop.mjs", import.meta.url)), scenario],
        {
            encoding: "utf8",
            timeout: 180_000,
            maxBuffer: 16 * 1024 * 1024,
        },
    )
    assert.ifError(result.error)
    assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`)
    const report = JSON.parse(result.stdout.trim().split("\n").at(-1))
    assert.equal(report.scenario, scenario)
    assert.equal(report.ok, true)
    return report
}

test("public host HTTP: concurrent real tool loops, model switches, history and native compaction", () => {
    publicHostScenario()
})

test("public host HTTP: default 64K auto compaction follows DCP with plain and file-reference prompts", () => {
    const { metrics } = publicHostScenario("automatic-64k")
    assert.equal(metrics.length, 2)
    for (const result of metrics) {
        assert.ok(result.prunedBeforeSummary > 0)
        assert.ok(result.summaries > 0)
        assert.equal(result.completed, result.tools)
    }
})

test("public host HTTP: default 32K recent protection permits repeated native summaries and completion", () => {
    const { metrics } = publicHostScenario("automatic-32k")
    assert.equal(metrics.length, 1)
    assert.ok(metrics[0].summaries >= 2)
    assert.equal(metrics[0].completed, metrics[0].tools)
})

test("public host HTTP: native automatic compaction settles a slow bash; explicit abort still cancels", () => {
    const { metrics } = publicHostScenario("native-slow-tool")
    assert.equal(metrics.length, 2)
    assert.equal(metrics[0].completed, metrics[0].tools)
    assert.equal(metrics[1].explicitlyCancelled, true)
})
