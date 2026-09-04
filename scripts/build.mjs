import { readFile } from "node:fs/promises"
import { build } from "esbuild"

const manifest = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8"))

await build({
    entryPoints: ["index.ts"],
    outdir: "dist",
    platform: "node",
    format: "esm",
    target: "es2022",
    bundle: true,
    splitting: true,
    sourcemap: true,
    mainFields: ["module", "main"],
    external: Object.keys({ ...manifest.dependencies, ...manifest.peerDependencies }).filter(
        (name) => name !== "jsonc-parser",
    ),
})
