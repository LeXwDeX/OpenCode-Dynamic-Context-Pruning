import { spawnSync } from "node:child_process"
import { existsSync } from "node:fs"
import { dirname, resolve } from "node:path"
import { fileURLToPath } from "node:url"

// This is the host implementation under test, not an SDK-only compatibility check.
export const HOST_COMMIT = "8d9972908c308da1836a004cebe27c7c23db1acc"

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..")
const host = process.env.OPENCODE_SOURCE_ROOT && resolve(process.env.OPENCODE_SOURCE_ROOT)
if (!host || !existsSync(resolve(host, "packages/opencode/src/session/message-v2.ts"))) {
    throw new Error("OPENCODE_SOURCE_ROOT must point to the pinned OpenCode-GraphAgent checkout")
}
const revision = spawnSync("git", ["rev-parse", "HEAD"], { cwd: host, encoding: "utf8" })
if (revision.status !== 0 || revision.stdout.trim() !== HOST_COMMIT) {
    throw new Error(`Host integration requires OpenCode-GraphAgent commit ${HOST_COMMIT}`)
}
const changes = spawnSync("git", ["status", "--porcelain"], { cwd: host, encoding: "utf8" })
if (changes.status !== 0 || changes.stdout.trim()) {
    throw new Error("Host integration requires an unchanged host checkout")
}
const build = spawnSync("npm", ["run", "build"], { cwd: root, stdio: "inherit" })
if (build.error) throw build.error
if (build.status !== 0) process.exit(build.status ?? 1)
const result = spawnSync(
    process.execPath,
    ["--test", resolve(root, "tests/host/contract.test.mjs")],
    {
        cwd: resolve(host, "packages/opencode"),
        env: {
            ...process.env,
            DCP_HOST_ROOT: host,
        },
        stdio: "inherit",
    },
)
if (result.error) throw result.error
process.exitCode = result.status ?? 1
