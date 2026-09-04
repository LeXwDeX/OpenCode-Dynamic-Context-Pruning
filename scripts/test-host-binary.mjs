import assert from "node:assert/strict"
import { spawn, spawnSync } from "node:child_process"
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises"
import { dirname, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import {
    binaryEnvironment,
    fileIdentity,
    parseBinaryArguments,
} from "../tests/host/binary-runtime.mjs"

const options = parseBinaryArguments(process.argv.slice(2))
const root = resolve(dirname(fileURLToPath(import.meta.url)), "..")
const binary = await fileIdentity(options.binary)
assert.equal(binary.sha256, options.sha256, "binary SHA-256 differs from the selected artifact")
await mkdir(options.output, { recursive: true })
const output = await mkdtemp(join(options.output, "binary-"))
const versionEnvironment = binaryEnvironment(join(output, "version"), false, process.env.PATH)
await mkdir(versionEnvironment.HOME, { recursive: true })
const version = spawnSync(binary.path, ["--version"], {
    cwd: versionEnvironment.HOME,
    env: versionEnvironment,
    encoding: "utf8",
    timeout: 30_000,
})
assert.ifError(version.error)
assert.equal(version.status, 0, version.stderr)
assert.equal(
    version.stdout.trim(),
    options.version,
    "binary version differs from the selected artifact",
)
const build = spawnSync("npm", ["run", "build"], { cwd: root, stdio: "inherit" })
assert.ifError(build.error)
assert.equal(build.status, 0, "build the current plugin before testing its host boundary")
const plugin = JSON.parse(await readFile(join(root, "package.json"), "utf8"))
const peer = JSON.parse(
    await readFile(join(root, "node_modules/@opencode-ai/plugin/package.json"), "utf8"),
)
const pluginBuild = await fileIdentity(join(root, "dist/index.js"))
const revision = spawnSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" })
const sourceState = spawnSync("git", ["status", "--porcelain"], { cwd: root, encoding: "utf8" })

async function runCase(native, enabled) {
    const name = `${native ? "native" : "ai-sdk"}-dcp-${enabled ? "on" : "off"}`
    const directory = join(output, name)
    await mkdir(directory)
    const child = spawn("bun", [join(root, "tests/host/public-loop.mjs"), "native-slow-tool"], {
        cwd: root,
        detached: process.platform !== "win32",
        env: {
            ...binaryEnvironment(directory, native, process.env.PATH),
            DCP_BINARY_PATH: binary.path,
            DCP_BINARY_NATIVE: String(native),
            DCP_BINARY_ENABLED: String(enabled),
            DCP_BINARY_OUTPUT: directory,
        },
        stdio: ["ignore", "pipe", "pipe"],
    })
    let log = ""
    let timedOut = false
    let spawnError
    const terminate = () => {
        if (!child.pid) return
        try {
            if (process.platform === "win32") child.kill("SIGKILL")
            else process.kill(-child.pid, "SIGKILL")
        } catch (error) {
            if (error.code !== "ESRCH") throw error
        }
    }
    for (const stream of [child.stdout, child.stderr])
        stream.on("data", (data) => {
            log = (log + data.toString()).slice(-2 * 1024 * 1024)
        })
    const timer = setTimeout(() => {
        timedOut = true
        terminate()
    }, 180_000)
    const interrupted = () => {
        terminate()
        process.exit(130)
    }
    process.once("SIGINT", interrupted)
    process.once("SIGTERM", interrupted)
    const exit = await new Promise((done) => {
        child.once("error", (error) => {
            spawnError = error.message
        })
        child.once("close", (code, signal) => done({ code, signal }))
    })
    clearTimeout(timer)
    process.removeListener("SIGINT", interrupted)
    process.removeListener("SIGTERM", interrupted)
    await writeFile(join(directory, "runner.log"), log)
    let details
    try {
        details = JSON.parse(await readFile(join(directory, "result.json"), "utf8"))
    } catch {}
    const passed = exit.code === 0 && details?.ok === true && !timedOut && !spawnError
    return {
        name,
        runtime: native ? "native" : "ai-sdk",
        dcpEnabled: enabled,
        status: passed ? "passed" : details?.checks?.length ? "failed" : "infrastructure-error",
        exit,
        timedOut,
        ...(!details?.checks?.length ? { error: spawnError ?? log.slice(-2000) } : {}),
        evidence: directory,
        details,
    }
}

const cases = []
for (const native of [true, false])
    for (const enabled of [true, false]) cases.push(await runCase(native, enabled))
const unchanged = (await fileIdentity(binary.path)).sha256 === binary.sha256
const report = {
    kind: "binary-host-compatibility",
    generatedAt: new Date().toISOString(),
    artifact: { ...binary, version: options.version, unchanged },
    plugin: {
        name: plugin.name,
        version: plugin.version,
        commit: revision.status === 0 ? revision.stdout.trim() : null,
        workingTreeChanges: sourceState.status === 0 ? Boolean(sourceState.stdout.trim()) : null,
        build: pluginBuild,
    },
    peer: {
        name: peer.name,
        version: peer.version,
        source: "DCP lockfile npm development dependency",
    },
    allPassed: unchanged && cases.every((item) => item.status === "passed"),
    cases,
    limits: [
        "The caller supplies the artifact version and digest; release provenance must be verified separately.",
        "The binary and its configured Native/AI SDK modes are tested, not a source checkout.",
        "Scripted model usage exercises lifecycle behavior; it does not certify tokenization or semantic task quality.",
        "A failed or unsupported case remains failed; this report does not replace the required pinned-source gate.",
    ],
}
await writeFile(join(output, "report.json"), JSON.stringify(report, null, 2) + "\n")
process.stdout.write(
    JSON.stringify({
        report: join(output, "report.json"),
        allPassed: report.allPassed,
        cases: cases.map(({ name, status }) => ({ name, status })),
    }) + "\n",
)
process.exitCode = report.allPassed ? 0 : 1
