import assert from "node:assert/strict"
import { spawnSync } from "node:child_process"
import { readFileSync } from "node:fs"
import { fileURLToPath } from "node:url"
import test from "node:test"

const script = fileURLToPath(new URL("../scripts/verify-release.mjs", import.meta.url))
const { version } = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"))

test("release accepts only the exact package version tag", () => {
    const result = spawnSync(process.execPath, [script], {
        env: { ...process.env, GITHUB_REF: `refs/tags/v${version}` },
        encoding: "utf8",
    })
    assert.ifError(result.error)
    assert.equal(result.status, 0, result.stderr)
    assert.ok(result.stdout.includes(version))
})

test("release rejects mismatched tags, branch dispatch and absent Git identity", () => {
    for (const ref of ["refs/tags/v0.0.0", "refs/tags/latest", "refs/heads/master", ""]) {
        const result = spawnSync(process.execPath, [script], {
            env: { ...process.env, GITHUB_REF: ref },
            encoding: "utf8",
        })
        assert.ifError(result.error)
        assert.equal(result.status, 1)
        assert.match(result.stderr, /Release requires refs\/tags\/v/)
    }
})
