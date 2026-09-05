import assert from "node:assert/strict"
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import test from "node:test"
import Ajv from "ajv"
import * as jsoncParser from "jsonc-parser"
import { getConfig, getDeprecatedConfigKeys, validateConfigTypes } from "../lib/config"

const schema = JSON.parse(readFileSync(new URL("../dcp.schema.json", import.meta.url), "utf8"))
const validateSchema = new Ajv().compile(schema)

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
    assert.equal(validateSchema(config), true)
    const schemaDefaults = { dtc: {}, tool: {} }
    assert.equal(new Ajv({ useDefaults: true }).compile(schema)(schemaDefaults), true)
    assert.deepEqual(schemaDefaults, config)
    assert.equal(existsSync(join(root, "global")), false)
})

test("both README examples are the built-in policy without manual tuning", (t) => {
    const { ctx } = workspace(t)
    const config = getConfig(ctx)
    for (const file of ["README.md", "README.en.md"]) {
        const readme = readFileSync(new URL(`../${file}`, import.meta.url), "utf8")
        const example = [...readme.matchAll(/```jsonc\n([\s\S]*?)\n```/g)].find((match) =>
            match[1]!.includes('"protectRecentSteps"'),
        )
        assert.ok(example, `${file} must show the default configuration`)
        const { $schema, ...documented } = jsoncParser.parse(example[1]!)
        assert.equal(typeof $schema, "string")
        assert.deepEqual(documented, config, `${file} must match zero-configuration behavior`)
    }
})

test("schema and runtime agree on supported integer option boundaries", () => {
    for (const [field, minimum] of [
        ["protectRecentSteps", 1],
        ["protectRecentTokens", 0],
        ["minimumSavingsTokens", 1],
    ] as const) {
        for (const [value, accepted] of [
            [minimum, true],
            [minimum + 1, true],
            [Number.MAX_SAFE_INTEGER, true],
            [minimum - 1, false],
            [minimum + 0.5, false],
            [Number.MAX_SAFE_INTEGER + 1, false],
            [1e100, false],
            ["1", false],
            [null, false],
        ] as const) {
            const config = { dtc: { [field]: value } }
            const label = `${field}: ${JSON.stringify(value)}`
            assert.equal(validateConfigTypes(config).length === 0, accepted, `runtime ${label}`)
            assert.equal(validateSchema(config), accepted, `schema ${label}`)
        }
    }
})

test("schema and runtime agree on tool names containing non-whitespace text", () => {
    for (const [value, accepted] of [
        [[], true],
        [["bash"], true],
        [[" bash ", "\tgrep\n", "bash"], true],
        [["工具"], true],
        [[""], false],
        [[" "], false],
        [["\t\r\n"], false],
        [["\u00a0\u2003\ufeff"], false],
        [["bash", " "], false],
        [[42], false],
        ["bash", false],
        [null, false],
    ] as const) {
        const config = { dtc: { protectedTools: value } }
        const label = JSON.stringify(value)
        assert.equal(validateConfigTypes(config).length === 0, accepted, `runtime ${label}`)
        assert.equal(validateSchema(config), accepted, `schema ${label}`)
    }
})

test("schema boundaries preserve valid lower layers and accepted values still merge", (t) => {
    const { root, project, ctx, write } = workspace(t)
    const lower = {
        protectRecentSteps: 6,
        protectRecentTokens: 12000,
        minimumSavingsTokens: 800,
        protectedTools: ["bash"],
    }
    write(join(root, "global", "opencode"), JSON.stringify({ dtc: lower }))
    const invalid = {
        dtc: {
            protectRecentSteps: Number.MAX_SAFE_INTEGER + 1,
            protectRecentTokens: Number.MAX_SAFE_INTEGER + 1,
            minimumSavingsTokens: Number.MAX_SAFE_INTEGER + 1,
            protectedTools: [" "],
            targetRatio: 0.8,
        },
    }
    assert.equal(validateSchema(invalid), false)
    assert.equal(validateConfigTypes(invalid).length, 4)
    write(join(project, ".opencode"), JSON.stringify(invalid))
    const ignored = getConfig(ctx)
    for (const key of Object.keys(lower) as Array<keyof typeof lower>) {
        assert.deepEqual(ignored.dtc[key], lower[key])
    }
    assert.equal(ignored.dtc.targetRatio, 0.8)

    const accepted = {
        dtc: {
            protectRecentSteps: Number.MAX_SAFE_INTEGER,
            protectRecentTokens: Number.MAX_SAFE_INTEGER,
            minimumSavingsTokens: Number.MAX_SAFE_INTEGER,
            protectedTools: [" bash ", "\tgrep\n", "bash"],
        },
    }
    assert.equal(validateSchema(accepted), true)
    assert.deepEqual(validateConfigTypes(accepted), [])
    write(join(project, ".opencode"), JSON.stringify(accepted))
    const merged = getConfig(ctx)
    assert.equal(merged.dtc.protectRecentSteps, Number.MAX_SAFE_INTEGER)
    assert.equal(merged.dtc.protectRecentTokens, Number.MAX_SAFE_INTEGER)
    assert.equal(merged.dtc.minimumSavingsTokens, Number.MAX_SAFE_INTEGER)
    assert.deepEqual(merged.dtc.protectedTools, ["bash", "grep"])
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
