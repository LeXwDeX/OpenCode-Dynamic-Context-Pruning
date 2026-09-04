import { appendFile, mkdir } from "node:fs/promises"
import { join } from "node:path"
import { homedir } from "node:os"

/** Debug-only operational metadata. Message bodies are never captured here. */
export class Logger {
    private readonly directory: string

    constructor(public readonly enabled: boolean) {
        this.directory = join(
            process.env.XDG_CONFIG_HOME || join(homedir(), ".config"),
            "opencode",
            "logs",
            "dcp",
        )
    }

    private async write(level: string, message: string, data?: unknown): Promise<void> {
        if (!this.enabled) return
        try {
            const time = new Date().toISOString()
            const line = JSON.stringify({ time, level, message, data }) + "\n"
            await mkdir(this.directory, { recursive: true })
            await appendFile(join(this.directory, time.slice(0, 10) + ".log"), line)
        } catch {
            // A diagnostic failure cannot affect a model request.
        }
    }

    info(message: string, data?: unknown): Promise<void> {
        return this.write("info", message, data)
    }

    debug(message: string, data?: unknown): Promise<void> {
        return this.write("debug", message, data)
    }

    warn(message: string, data?: unknown): Promise<void> {
        return this.write("warn", message, data)
    }

    error(message: string, data?: unknown): Promise<void> {
        return this.write("error", message, data)
    }
}
