import type { MessageLike, PartLike } from "../lib/dtc/types"

let seq = 0
function nextID(prefix: string): string {
    seq += 1
    return `${prefix}_${seq.toString(36).padStart(6, "0")}`
}

export function textPart(text: string): PartLike {
    return { type: "text", id: nextID("part"), text }
}

export function reasoningPart(text: string): PartLike {
    return { type: "reasoning", id: nextID("part"), text }
}

export function toolPart(options: {
    tool?: string
    output?: string
    status?: string
    input?: Record<string, unknown>
    error?: string
}): PartLike {
    return {
        type: "tool",
        id: nextID("part"),
        tool: options.tool ?? "bash",
        state: {
            status: options.status ?? "completed",
            output: options.output ?? "",
            ...(options.error !== undefined ? { error: options.error } : {}),
            input: options.input ?? { command: "echo hi" },
            time: {},
        },
    }
}

export function userMessage(text: string, created = 0): MessageLike {
    return {
        info: {
            id: nextID("msg"),
            role: "user",
            sessionID: "ses_test",
            time: { created },
        },
        parts: [textPart(text)],
    }
}

export function assistantMessage(parts: PartLike[]): MessageLike {
    return {
        info: { id: nextID("msg"), role: "assistant", sessionID: "ses_test" },
        parts,
    }
}

export function compactionUserMessage(): MessageLike {
    return {
        info: { id: nextID("msg"), role: "user", sessionID: "ses_test", time: { created: 0 } },
        parts: [{ type: "compaction", id: nextID("part") }],
    }
}

/** Builds `count` turns of user + assistant(text + tool + reasoning). */
export function buildTurns(
    count: number,
    options: { toolOutputChars?: number; textChars?: number; sessionID?: string } = {},
): MessageLike[] {
    const toolOutputChars = options.toolOutputChars ?? 50
    const textChars = options.textChars ?? 60
    const messages: MessageLike[] = []
    for (let t = 1; t <= count; t++) {
        const user = userMessage(
            `任务${t}：处理模块 m${t} 的接口改造需求，第 ${t} 轮用户请求内容填充`.slice(
                0,
                textChars,
            ),
            t * 1000,
        )
        if (options.sessionID) user.info!.sessionID = options.sessionID
        messages.push(user)
        const assistant = assistantMessage([
            reasoningPart(`推理过程 m${t} ${"r".repeat(textChars)}`),
            toolPart({
                tool: "bash",
                output: `output-${t}-${"x".repeat(toolOutputChars)}`,
                input: { command: `echo step-${t}`, filePath: `/src/m${t}.ts` },
            }),
            textPart(`第 ${t} 轮完成：模块 m${t} 接口已改造并通过测试 ${"y".repeat(textChars)}`),
        ])
        if (options.sessionID) assistant.info!.sessionID = options.sessionID
        messages.push(assistant)
    }
    return messages
}

export function snapshotStructure(messages: MessageLike[]): string {
    return JSON.stringify(
        messages.map((m) => ({
            id: m.info?.id,
            role: m.info?.role,
            parts: (m.parts ?? []).map((p) => ({ id: p.id, type: p.type, tool: p.tool })),
        })),
    )
}

export function deepCloneMessages(messages: MessageLike[]): MessageLike[] {
    return JSON.parse(JSON.stringify(messages))
}

export interface FakeClient {
    client: any
    toasts: Array<{ body: { title: string; message: string; variant?: string } }>
}

export function fakeOpenCodeClient(options: { messages?: unknown[] } = {}): FakeClient {
    const toasts: FakeClient["toasts"] = []
    const client = {
        session: {
            messages: async () => ({ data: options.messages ?? [] }),
        },
        tui: {
            showToast: async (input: any) => {
                toasts.push(input)
            },
        },
    }
    return { client, toasts }
}

export function fakeLogger() {
    const entries: Array<{ level: "debug" | "warn" | "info"; message: string }> = []
    const logger = {
        debug: (message: string) => entries.push({ level: "debug", message }),
        warn: (message: string) => entries.push({ level: "warn", message }),
        info: (message: string) => entries.push({ level: "info", message }),
    }
    return { logger: logger as any, entries }
}

/** Fork hosts strip id/sessionID out of message payloads (both live in
 * database columns there); simulate that shape to exercise the engine's
 * chat.params correlation fallback. */
export function toForkShape(messages: MessageLike[]): MessageLike[] {
    for (const message of messages) {
        const info = message.info as Record<string, unknown> | undefined
        if (info) {
            delete info.sessionID
            delete info.id
        }
    }
    return messages
}
