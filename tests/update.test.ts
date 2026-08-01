import { mkdir, mkdtemp, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { tmpdir } from "node:os"
import test from "node:test"
import assert from "node:assert/strict"
import { findAutoUpdateWrapperDir, isAutoUpdatableSpec, isVersionNewer } from "../lib/update"

test("isVersionNewer compares semver versions", () => {
    assert.equal(isVersionNewer("3.2.0", "3.1.9"), true)
    assert.equal(isVersionNewer("3.1.9", "3.1.9"), false)
    assert.equal(isVersionNewer("3.1.9", "3.2.0"), false)
    assert.equal(isVersionNewer("3.1.9", "3.1.9-beta.1"), true)
})

test("isAutoUpdatableSpec allows latest and ranges", () => {
    assert.equal(isAutoUpdatableSpec("latest"), true)
    assert.equal(isAutoUpdatableSpec("*"), true)
    assert.equal(isAutoUpdatableSpec("^3.1.9"), true)
    assert.equal(isAutoUpdatableSpec(">=3.1.9"), true)
})

test("isAutoUpdatableSpec rejects pinned and non-registry specs", () => {
    assert.equal(isAutoUpdatableSpec("3.1.9"), false)
    assert.equal(isAutoUpdatableSpec("file:../opencode-dcp"), false)
    assert.equal(isAutoUpdatableSpec("github:user/repo"), false)
})

test("findAutoUpdateWrapperDir detects opencode npm wrapper for latest installs", async () => {
    const rootDir = await mkdtemp(join(tmpdir(), "dcp-update-"))
    const wrapperDir = join(rootDir, "@lexwdex-org", "opencode-dcp@latest")
    const packageDir = join(wrapperDir, "node_modules", "@lexwdex-org", "opencode-dcp")
    await writePackageJson(wrapperDir, {
        dependencies: { "@lexwdex-org/opencode-dcp": "3.1.10" },
    })
    await writePackageJson(packageDir, {
        name: "@lexwdex-org/opencode-dcp",
        version: "3.1.9",
    })

    assert.equal(
        await findAutoUpdateWrapperDir(packageDir, "@lexwdex-org/opencode-dcp"),
        wrapperDir,
    )
})

test("findAutoUpdateWrapperDir skips version-locked opencode installs", async () => {
    const rootDir = await mkdtemp(join(tmpdir(), "dcp-update-"))
    const wrapperDir = join(rootDir, "@lexwdex-org", "opencode-dcp@3.1.9")
    const packageDir = join(wrapperDir, "node_modules", "@lexwdex-org", "opencode-dcp")
    await writePackageJson(wrapperDir, {
        dependencies: { "@lexwdex-org/opencode-dcp": "3.1.9" },
    })
    await writePackageJson(packageDir, {
        name: "@lexwdex-org/opencode-dcp",
        version: "3.1.9",
    })

    assert.equal(await findAutoUpdateWrapperDir(packageDir, "@lexwdex-org/opencode-dcp"), undefined)
})

async function writePackageJson(dir: string, data: Record<string, unknown>) {
    await mkdir(dir, { recursive: true })
    await writeFile(join(dir, "package.json"), `${JSON.stringify(data)}\n`, "utf-8")
}
