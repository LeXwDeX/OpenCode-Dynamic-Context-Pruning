export const MODEL_MESSAGES = [
    {
        info: {
            role: "user",
            model: { providerID: "anthropic", modelID: "claude-sonnet" },
        },
    },
]

export function textParts(text: string): unknown[] {
    return [{ type: "text", text }]
}

export interface FakeClient {
    client: any
    nativeCalls: unknown[]
}

/** Fake OpenCode SDK client: session messages/summarize/status, tui toasts, with a live status map. */
export function fakeOpenCodeClient(
    options: {
        messages?: unknown[]
        native?: () => Promise<unknown>
        onToast?: (input: unknown) => void
    } = {},
): FakeClient {
    const nativeCalls: unknown[] = []
    const client = {
        session: {
            messages: async () => ({ data: options.messages ?? MODEL_MESSAGES }),
            summarize: async (input: unknown) => {
                nativeCalls.push(input)
                if (options.native) return options.native()
                return { data: true }
            },
            status: async () => ({ data: {} as Record<string, { type: string }> }),
        },
        tui: {
            showToast: async (input: unknown) => {
                options.onToast?.(input)
            },
        },
    }
    return { client, nativeCalls }
}

/** Spin the microtask queue until `probe` turns true (fire-and-forget drains). */
export async function drainUntil(probe: () => boolean, spins = 200): Promise<void> {
    for (let index = 0; index < spins && !probe(); index++) {
        await Promise.resolve()
    }
}

/** Let a fixed number of microtasks run (asserting something does NOT happen). */
export async function flushMicrotasks(count = 20): Promise<void> {
    for (let index = 0; index < count; index++) {
        await Promise.resolve()
    }
}
