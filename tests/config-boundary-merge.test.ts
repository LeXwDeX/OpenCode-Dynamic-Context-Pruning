import assert from "node:assert/strict"
import { mkdtempSync, mkdirSync, writeFileSync, existsSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import test from "node:test"

const configHome = mkdtempSync(join(tmpdir(), "opencode-dcp-config-"))
process.env.XDG_CONFIG_HOME = configHome

function buildProjectConfig(projectDir: string, boundaryNudge: boolean): void {
    const opencodeDir = join(projectDir, ".opencode")
    mkdirSync(opencodeDir, { recursive: true })
    writeFileSync(
        join(opencodeDir, "dcp.jsonc"),
        `{ "compress": { "boundaryNudge": ${boundaryNudge} } }`,
        "utf-8",
    )
}

function buildCtx(projectDir: string) {
    return {
        directory: projectDir,
        client: { tui: { showToast: async () => {} } },
    } as any
}

test("project config boundaryNudge=false overrides the true default", async () => {
    const projectDir = mkdtempSync(join(tmpdir(), "opencode-dcp-project-"))
    buildProjectConfig(projectDir, false)
    const { getConfig } = await import("../lib/config")
    const config = getConfig(buildCtx(projectDir))

    assert.equal(config.compress.boundaryNudge, false)
})

test("missing boundaryNudge resolves to the true default", async () => {
    const withoutBoundary = mkdtempSync(join(tmpdir(), "opencode-dcp-plain-"))
    const { getConfig } = await import("../lib/config")
    const config = getConfig(buildCtx(withoutBoundary))

    assert.equal(config.compress.boundaryNudge, true)
})

test("global default config file was created inside the isolated config home", async () => {
    const projectDir = mkdtempSync(join(tmpdir(), "opencode-dcp-project-"))
    const { getConfig } = await import("../lib/config")
    getConfig(buildCtx(projectDir))

    assert.equal(existsSync(join(configHome, "opencode", "dcp.jsonc")), true)
})
