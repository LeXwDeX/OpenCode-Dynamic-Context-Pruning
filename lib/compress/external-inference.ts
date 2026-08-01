import type { ExternalModelConfig } from "../config"

export type { ExternalModelConfig }

export interface ExternalSummaryRequest {
    systemPrompt: string
    userContent: string
}

export type ExternalModelErrorKind = "network" | "http" | "parse" | "empty" | "timeout"

export class ExternalModelError extends Error {
    constructor(
        message: string,
        public readonly kind: ExternalModelErrorKind,
        public readonly cause?: unknown,
    ) {
        super(message)
        this.name = "ExternalModelError"
    }
}

export function resolveCompressBaseUrl(url: string): string {
    const normalized = url.replace(/\/$/, "")
    if (normalized.endsWith("/chat/completions")) {
        return normalized
    }
    return `${normalized}/chat/completions`
}

async function callExternalModel(
    endpoint: string,
    cfg: ExternalModelConfig,
    req: ExternalSummaryRequest,
): Promise<string> {
    const controller = new AbortController()
    const timeoutMs = cfg.timeout ?? 120000
    const timeoutHandle = setTimeout(() => controller.abort(), timeoutMs)

    let response: Response
    try {
        response = await fetch(endpoint, {
            method: "POST",
            headers: {
                "Content-Type": "application/json",
                ...(cfg.apiKey ? { Authorization: `Bearer ${cfg.apiKey}` } : {}),
            },
            body: JSON.stringify({
                model: cfg.model,
                messages: [
                    { role: "system", content: req.systemPrompt },
                    { role: "user", content: req.userContent },
                ],
                temperature: 0,
            }),
            signal: controller.signal,
        })
    } catch (error: unknown) {
        if (error instanceof Error && error.name === "AbortError") {
            throw new ExternalModelError(
                `External model request timed out after ${timeoutMs}ms`,
                "timeout",
                error,
            )
        }
        throw new ExternalModelError(
            `External model request failed: ${error instanceof Error ? error.message : String(error)}`,
            "network",
            error,
        )
    } finally {
        clearTimeout(timeoutHandle)
    }

    if (!response.ok) {
        let errorBody = ""
        try {
            errorBody = await response.text()
        } catch {}
        throw new ExternalModelError(
            `External model returned HTTP ${response.status}: ${errorBody.slice(0, 200)}`,
            "http",
            { status: response.status, body: errorBody },
        )
    }

    let parsed: any
    try {
        parsed = await response.json()
    } catch (error) {
        throw new ExternalModelError("External model returned invalid JSON", "parse", error)
    }

    const content = parsed?.choices?.[0]?.message?.content
    if (typeof content !== "string" || content.trim().length === 0) {
        throw new ExternalModelError(
            "External model returned empty or missing summary content",
            "empty",
            parsed,
        )
    }

    return content
}

export async function generateSummaryViaExternal(
    cfg: ExternalModelConfig,
    req: ExternalSummaryRequest,
): Promise<string> {
    if (typeof cfg.url !== "string" || cfg.url.trim().length === 0) {
        throw new Error("外部压缩模型 url 必须是非空字符串")
    }
    if (typeof cfg.model !== "string" || cfg.model.trim().length === 0) {
        throw new Error("外部压缩模型 model 必须是非空字符串")
    }
    if (cfg.apiKey !== undefined && typeof cfg.apiKey !== "string") {
        throw new Error("外部压缩模型 apiKey 必须是字符串")
    }
    if (cfg.timeout !== undefined && (!Number.isFinite(cfg.timeout) || cfg.timeout <= 0)) {
        throw new Error("外部压缩模型 timeout 必须是正数")
    }
    if (cfg.retries !== undefined && (!Number.isInteger(cfg.retries) || cfg.retries < 0)) {
        throw new Error("外部压缩模型 retries 必须是非负整数")
    }
    const endpoint = resolveCompressBaseUrl(cfg.url)
    const maxRetries = cfg.retries ?? 1

    let lastError: unknown
    for (let attempt = 0; attempt <= maxRetries; attempt++) {
        try {
            return await callExternalModel(endpoint, cfg, req)
        } catch (error) {
            lastError = error
        }
    }

    throw lastError
}
