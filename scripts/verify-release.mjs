import { readFileSync } from "node:fs"

const { version } = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"))
const expected = `refs/tags/v${version}`
if (process.env.GITHUB_REF !== expected) {
    throw new Error(
        `Release requires ${expected}; received ${process.env.GITHUB_REF || "no Git ref"}. ` +
            "For workflow_dispatch, select the matching version tag.",
    )
}
console.log(`Release tag matches package version ${version}`)
