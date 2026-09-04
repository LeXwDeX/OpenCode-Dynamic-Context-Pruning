import assert from "node:assert/strict"
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import test from "node:test"
import { getConfig, getDeprecatedConfigKeys, validateConfigTypes } from "../lib/config"

function workspace(t: { after: (fn: () => void) => void }) {
    const root = mkdtempSync(join(tmpdir(), "dcp-config-"))
    const previous = { xdg: process.env.XDG_CONFIG_HOME, config: process.env.OPENCODE_CONFIG_DIR }
    process.env.XDG_CONFIG_HOME = join(root, "global")
    process.env.OPENCODE_CONFIG_DIR = join(root, "override")
    const project = join(root, "project")
    mkdirSync(project, { recursive: true })
    const notices: unknown[] = []
    t.after(() => {
        for (const [key, value] of [
            ["XDG_CONFIG_HOME", previous.xdg],
            ["OPENCODE_CONFIG_DIR", previous.config],
        ] as const) {
            if (value === undefined) delete process.env[key]
            else process.env[key] = value
        }
        rmSync(root, { recursive: true, force: true })
    })
    const ctx = {
        directory: project,
        client: { tui: { showToast: async (notice: unknown) => notices.push(notice) } },
    } as any
    const write = (dir: string, content: string) => {
        mkdirSync(dir, { recursive: true })
        writeFileSync(join(dir, "dcp.jsonc"), content)
    }
    return { root, project, ctx, notices, write }
}

test("defaults expose one output policy and do not create user configuration", (t) => {
    const { root, ctx } = workspace(t)
    const config = getConfig(ctx)
    assert.equal("commands" in config, false)
    assert.deepEqual(config.dtc, {
        enabled: true,
        protectRecentSteps: 4,
        protectRecentTokens: 16_000,
        targetRatio: 0.7,
        minimumSavingsTokens: 512,
        protectedTools: [],
    })
    assert.equal(existsSync(join(root, "global")), false)
})

test("configuration layers merge supported fields while retired strategies stay inactive", (t) => {
    const { root, project, ctx, write } = workspace(t)
    write(join(root, "global", "opencode"), '{"dtc":{"targetRatio":0.8},"debug":true}')
    write(join(root, "override"), '{"dtc":{"protectRecentSteps":8},"autoUpdate":false}')
    write(
        join(project, ".opencode"),
        `{
        // Old settings must never resurrect inference or command interception.
        "commands": {"enabled": true},
        "autoPrune": {"driftThreshold": 0.1},
        "dtc": {"mergeRuns": true, "tailTurns": 100, "targetRatio": 0.6,
            "protectedTools": ["custom_query"],},
    }`,
    )
    const config = getConfig(ctx)
    assert.equal(config.debug, true)
    assert.equal(config.autoUpdate, false)
    assert.equal(config.dtc.targetRatio, 0.6)
    assert.equal(config.dtc.protectRecentSteps, 8)
    assert.deepEqual(config.dtc.protectedTools, ["custom_query"])
    assert.equal("mergeRuns" in config.dtc, false)
    assert.equal("driftThreshold" in config.dtc, false)
    assert.equal("commands" in config, false)
})

test("a child .opencode directory without DCP settings preserves parent configuration", (t) => {
    const { project, ctx, write } = workspace(t)
    write(join(project, ".opencode"), '{"enabled":false,"dtc":{"protectedTools":["bash"]}}')
    const child = join(project, "packages", "child")
    const childConfig = join(child, ".opencode")
    mkdirSync(childConfig, { recursive: true })
    ctx.directory = child

    for (const unrelatedContent of [false, true]) {
        if (unrelatedContent) writeFileSync(join(childConfig, "opencode.json"), "{}")
        const config = getConfig(ctx)
        assert.equal(config.enabled, false)
        assert.deepEqual(config.dtc.protectedTools, ["bash"])
    }
})

test("the nearest DCP file replaces ancestor settings and JSONC takes precedence over JSON", (t) => {
    const { project, ctx, write } = workspace(t)
    write(
        join(project, ".opencode"),
        '{"enabled":false,"debug":true,"dtc":{"protectedTools":["bash"]}}',
    )
    const child = join(project, "packages", "child")
    const childConfig = join(child, ".opencode")
    mkdirSync(childConfig, { recursive: true })
    writeFileSync(join(childConfig, "dcp.json"), '{"dtc":{"protectedTools":["grep"]}}')
    ctx.directory = child

    const json = getConfig(ctx)
    assert.equal(json.enabled, true)
    assert.equal(json.debug, false)
    assert.deepEqual(json.dtc.protectedTools, ["grep"])

    write(childConfig, '{"enabled":false,"dtc":{"protectedTools":["read"]}}')
    const jsonc = getConfig(ctx)
    assert.equal(jsonc.enabled, false)
    assert.equal(jsonc.debug, false)
    assert.deepEqual(jsonc.dtc.protectedTools, ["read"])
})

test("malformed nearest JSONC does not fall back to JSON or ancestor settings", (t) => {
    const { project, ctx, write, notices } = workspace(t)
    write(join(project, ".opencode"), '{"enabled":false,"debug":true}')
    const child = join(project, "packages", "child")
    const childConfig = join(child, ".opencode")
    write(childConfig, '{"enabled": false, broken}')
    writeFileSync(join(childConfig, "dcp.json"), '{"enabled":false}')
    ctx.directory = child

    const config = getConfig(ctx)
    assert.equal(config.enabled, true)
    assert.equal(config.debug, false)
    assert.equal(notices.length, 1)
})

test("malformed JSONC and non-object roots never partially apply settings", (t) => {
    const { project, ctx, write, notices } = workspace(t)
    for (const content of ['{"enabled": false, broken}', "[]", "false"]) {
        write(join(project, ".opencode"), content)
        assert.equal(getConfig(ctx).enabled, true)
    }
    assert.equal(notices.length, 3)
})

test("invalid values retain safe defaults and policy counts are integral", (t) => {
    const { project, ctx, write } = workspace(t)
    const invalid = {
        enabled: "yes",
        dtc: {
            protectRecentSteps: 1.5,
            protectRecentTokens: -1,
            targetRatio: 0,
            minimumSavingsTokens: 0,
            protectedTools: [42],
        },
        tool: { enabled: "yes" },
    }
    assert.equal(validateConfigTypes(invalid).length, 7)
    write(join(project, ".opencode"), JSON.stringify(invalid))
    const config = getConfig(ctx)
    assert.equal(config.enabled, true)
    assert.equal(config.tool.enabled, true)
    assert.equal(config.dtc.protectRecentSteps, 4)
    assert.equal(config.dtc.targetRatio, 0.7)
    assert.deepEqual(config.dtc.protectedTools, [])
})

test("retired options get migration notices without retaining old implementations", () => {
    assert.deepEqual(
        getDeprecatedConfigKeys({
            commands: { enabled: true },
            autoPrune: { driftThreshold: 0.1 },
            dtc: { tailTurns: 4, mergeRuns: true, driftThreshold: 0.2 },
        }),
        [
            "commands",
            "commands.enabled",
            "autoPrune",
            "autoPrune.driftThreshold",
            "dtc.tailTurns",
            "dtc.mergeRuns",
            "dtc.driftThreshold",
        ],
    )
})
