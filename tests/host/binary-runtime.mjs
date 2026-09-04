import assert from "node:assert/strict"
import { createHash } from "node:crypto"
import { readFile, mkdir, writeFile, realpath } from "node:fs/promises"
import { isAbsolute, join } from "node:path"
import { spawn } from "node:child_process"
import { setTimeout as delay } from "node:timers/promises"

export function parseBinaryArguments(args) {
    const accepted = new Set(["binary", "version", "sha256", "output"])
    const options = {}
    for (let index = 0; index < args.length; index += 2) {
        const key = args[index]?.replace(/^--/, "")
        const value = args[index + 1]
        assert.ok(accepted.has(key) && args[index].startsWith("--"), "unknown binary test option")
        assert.ok(
            value && !value.startsWith("--") && options[key] === undefined,
            `invalid --${key}`,
        )
        options[key] = value
    }
    for (const key of accepted) assert.ok(options[key], `--${key} is required`)
    assert.ok(isAbsolute(options.binary) && isAbsolute(options.output), "paths must be absolute")
    assert.match(options.sha256, /^[a-f0-9]{64}$/, "--sha256 must be an exact lowercase SHA-256")
    return options
}

export async function fileIdentity(path) {
    const resolved = await realpath(path)
    return {
        path: resolved,
        sha256: createHash("sha256")
            .update(await readFile(resolved))
            .digest("hex"),
    }
}

export function binaryEnvironment(scratch, native, path) {
    const environment = { PATH: path, HOME: join(scratch, "home"), SHELL: "/bin/sh" }
    for (const key of [
        "XDG_DATA_HOME",
        "XDG_CACHE_HOME",
        "XDG_CONFIG_HOME",
        "XDG_STATE_HOME",
        "OPENCODE_TEST_HOME",
        "OPENCODE_TEST_MANAGED_CONFIG_DIR",
        "OPENCODE_CONFIG_DIR",
    ])
        environment[key] = join(scratch, key)
    return {
        ...environment,
        OPENCODE_DB: join(scratch, "host.sqlite"),
        OPENCODE_MODELS_PATH: join(scratch, "models-api.json"),
        OPENCODE_DISABLE_MODELS_FETCH: "true",
        OPENCODE_DISABLE_DEFAULT_PLUGINS: "true",
        OPENCODE_DISABLE_LSP_DOWNLOAD: "true",
        OPENCODE_EXPERIMENTAL_EVENT_SYSTEM: "true",
        OPENCODE_EXPERIMENTAL_NATIVE_LLM: String(native),
        OPENCODE_PRINT_LOGS: "1",
        OPENCODE_LOG_LEVEL: "ERROR",
    }
}

export function binarySettingsFrom(environment) {
    if (!environment.DCP_BINARY_PATH) return undefined
    for (const key of ["DCP_BINARY_NATIVE", "DCP_BINARY_ENABLED"])
        assert.ok(["true", "false"].includes(environment[key]), `${key} must be explicit`)
    assert.ok(isAbsolute(environment.DCP_BINARY_PATH), "binary path must be absolute")
    assert.ok(isAbsolute(environment.DCP_BINARY_OUTPUT ?? ""), "binary output must be absolute")
    return {
        path: environment.DCP_BINARY_PATH,
        native: environment.DCP_BINARY_NATIVE === "true",
        enabled: environment.DCP_BINARY_ENABLED === "true",
        output: environment.DCP_BINARY_OUTPUT,
    }
}

/** Only the explicitly selected disposable server is ever signalled. */
export async function startBinaryHost({ binary, project, port, environment, output }) {
    await mkdir(environment.HOME, { recursive: true })
    const child = spawn(binary, ["serve", "--hostname", "127.0.0.1", "--port", String(port)], {
        cwd: project,
        env: environment,
        stdio: ["ignore", "pipe", "pipe"],
    })
    let log = ""
    let startupError
    const exited = new Promise((resolve) => {
        child.once("error", (error) => {
            startupError = error
            resolve()
        })
        child.once("exit", resolve)
    })
    for (const stream of [child.stdout, child.stderr])
        stream.on("data", (data) => {
            log = (log + data.toString()).slice(-1024 * 1024)
        })
    const stop = async () => {
        if (child.exitCode === null && child.signalCode === null && !startupError) {
            child.kill("SIGTERM")
            const stopped = await Promise.race([
                exited.then(() => true),
                delay(5000, undefined, { ref: false }).then(() => false),
            ])
            if (!stopped) {
                child.kill("SIGKILL")
                await exited
            }
        }
        await writeFile(join(output, "server.log"), log)
    }
    const url = `http://127.0.0.1:${port}`
    try {
        const deadline = Date.now() + 30_000
        while (Date.now() < deadline) {
            if (startupError) throw startupError
            assert.ok(child.exitCode === null && child.signalCode === null, `host exited: ${log}`)
            try {
                const response = await fetch(`${url}/global/health`, {
                    signal: AbortSignal.timeout(1000),
                })
                // Wait for our child's successful bind, so an unrelated service
                // that won the port reservation race cannot become the target.
                if (response.ok && log.includes(`opencode server listening on ${url}`))
                    return {
                        url,
                        stop,
                        assertRunning: () =>
                            assert.ok(
                                child.exitCode === null && child.signalCode === null,
                                "the selected isolated host has exited",
                            ),
                    }
            } catch {}
            await delay(100)
        }
        throw new Error(`isolated binary failed to listen: ${log}`)
    } catch (error) {
        await stop()
        throw error
    }
}
