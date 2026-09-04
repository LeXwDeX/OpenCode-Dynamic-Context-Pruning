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

test("public host HTTP: concurrent real tool loops, model switches, history and native compaction", () => {
    const result = spawnSync(
        "bun",
        [fileURLToPath(new URL("./public-loop.mjs", import.meta.url))],
        {
            encoding: "utf8",
            timeout: 180_000,
            maxBuffer: 16 * 1024 * 1024,
        },
    )
    assert.ifError(result.error)
    assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`)
    assert.deepEqual(JSON.parse(result.stdout.trim().split("\n").at(-1)), {
        scenario: "public-host-loop",
        ok: true,
    })
})
