import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs"
import { homedir } from "node:os"
import { dirname, join } from "node:path"
import type { Logger } from "../logger"
import { getCompactionPrompt } from "./compaction"

export interface RuntimePrompts {
    compaction: string
}

interface PromptPaths {
    defaultsDir: string
    overrides: string[]
}

function findOpencodeDir(startDir: string): string | null {
    let current = startDir
    while (current !== "/") {
        const candidate = join(current, ".opencode")
        if (existsSync(candidate) && statSync(candidate).isDirectory()) return candidate
        const parent = dirname(current)
        if (parent === current) break
        current = parent
    }
    return null
}

function resolvePaths(workingDirectory: string): PromptPaths {
    const configHome = process.env.XDG_CONFIG_HOME || join(homedir(), ".config")
    const globalRoot = join(configHome, "opencode", "dcp-prompts")
    const opencodeDir = findOpencodeDir(workingDirectory)
    return {
        defaultsDir: join(globalRoot, "defaults"),
        overrides: [
            opencodeDir ? join(opencodeDir, "dcp-prompts", "overrides", "compaction.md") : "",
            process.env.OPENCODE_CONFIG_DIR
                ? join(process.env.OPENCODE_CONFIG_DIR, "dcp-prompts", "overrides", "compaction.md")
                : "",
            join(globalRoot, "overrides", "compaction.md"),
        ].filter(Boolean),
    }
}

function normalize(content: string): string {
    return content
        .replace(/^\uFEFF/, "")
        .replace(/\r\n?/g, "\n")
        .replace(/<!--[\s\S]*?-->/g, "")
        .trim()
}

export class PromptStore {
    private readonly paths: PromptPaths
    private readonly defaultPrompt: string
    private runtime: RuntimePrompts
    private lastReloadAt = 0

    constructor(
        private readonly logger: Logger,
        workingDirectory: string,
        private readonly customPromptsEnabled = false,
        language?: string,
    ) {
        this.paths = resolvePaths(workingDirectory)
        this.defaultPrompt = getCompactionPrompt(language)
        this.runtime = { compaction: this.defaultPrompt }
        if (customPromptsEnabled) this.ensureDefaults()
        this.reload()
    }

    getRuntimePrompts(): RuntimePrompts {
        return { ...this.runtime }
    }

    reload(): void {
        const now = Date.now()
        if (now - this.lastReloadAt < 1000) return
        this.lastReloadAt = now
        this.runtime = { compaction: this.defaultPrompt }
        if (!this.customPromptsEnabled) return

        for (const path of this.paths.overrides) {
            if (!existsSync(path)) continue
            try {
                const prompt = normalize(readFileSync(path, "utf-8"))
                if (prompt) this.runtime = { compaction: prompt }
                return
            } catch (error) {
                this.logger.warn("Failed to load compaction prompt override", {
                    path,
                    error: error instanceof Error ? error.message : String(error),
                })
            }
        }
    }

    private ensureDefaults(): void {
        try {
            mkdirSync(this.paths.defaultsDir, { recursive: true })
            writeFileSync(
                join(this.paths.defaultsDir, "compaction.md"),
                `${this.defaultPrompt.trim()}\n`,
            )
            writeFileSync(
                join(this.paths.defaultsDir, "README.md"),
                "# DCP compaction prompt\n\nCopy `compaction.md` to an `overrides` directory and restart OpenCode.\n",
            )
        } catch (error) {
            this.logger.warn("Failed to write bundled compaction prompt", {
                error: error instanceof Error ? error.message : String(error),
            })
        }
    }
}
