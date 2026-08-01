import assert from "node:assert/strict"
import test from "node:test"
import {
    resolveCompressBaseUrl,
    generateSummaryViaExternal,
    ExternalModelError,
} from "../lib/compress/external-inference"

test("resolveCompressBaseUrl appends /chat/completions to base URL", () => {
    const result = resolveCompressBaseUrl("http://localhost:8000/v1")
    assert.equal(result, "http://localhost:8000/v1/chat/completions")
})

test("resolveCompressBaseUrl preserves URL that already ends with /chat/completions", () => {
    const result = resolveCompressBaseUrl("http://localhost:8000/v1/chat/completions")
    assert.equal(result, "http://localhost:8000/v1/chat/completions")
})

test("resolveCompressBaseUrl handles trailing slash on base URL", () => {
    const result = resolveCompressBaseUrl("http://localhost:8000/v1/")
    assert.equal(result, "http://localhost:8000/v1/chat/completions")
})

function mockFetch(
    responses: Array<{
        status: number | null
        body?: unknown
        throwError?: Error
    }>,
): { restore: () => void; calls: RequestInfo[] } {
    const calls: RequestInfo[] = []
    let callIndex = 0
    const originalFetch = globalThis.fetch

    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
        calls.push(input as RequestInfo)
        const response = responses[callIndex]
        callIndex++

        if (!response) {
            throw new Error(`Unexpected fetch call #${callIndex}`)
        }

        if (response.throwError) {
            throw response.throwError
        }

        return new Response(JSON.stringify(response.body), {
            status: response.status!,
            headers: { "Content-Type": "application/json" },
        })
    }) as typeof fetch

    return {
        restore() {
            globalThis.fetch = originalFetch
        },
        calls,
    }
}

test("generateSummaryViaExternal rejects malformed runtime configuration", async () => {
    const request = { systemPrompt: "Summarize.", userContent: "Content." }
    await assert.rejects(
        generateSummaryViaExternal({ url: " ", model: "test" }, request),
        /url 必须是非空字符串/,
    )
    await assert.rejects(
        generateSummaryViaExternal({ url: "http://localhost", model: " " }, request),
        /model 必须是非空字符串/,
    )
})

test("generateSummaryViaExternal returns summary string on 200 OK", async () => {
    const mock = mockFetch([
        {
            status: 200,
            body: {
                choices: [
                    {
                        message: {
                            content: "Generated summary text.",
                        },
                    },
                ],
            },
        },
    ])

    try {
        const result = await generateSummaryViaExternal(
            {
                url: "http://localhost:8000/v1",
                apiKey: "test-key",
                model: "qwen2.5:7b",
            },
            {
                systemPrompt: "Summarize the conversation.",
                userContent: "Original message content.",
            },
        )
        assert.equal(result, "Generated summary text.")
    } finally {
        mock.restore()
    }
})

test("generateSummaryViaExternal throws ExternalModelError kind=empty on empty content", async () => {
    const mock = mockFetch([
        {
            status: 200,
            body: {
                choices: [
                    {
                        message: {
                            content: "",
                        },
                    },
                ],
            },
        },
        {
            status: 200,
            body: {
                choices: [
                    {
                        message: {
                            content: "",
                        },
                    },
                ],
            },
        },
    ])

    try {
        await assert.rejects(
            generateSummaryViaExternal(
                {
                    url: "http://localhost:8000/v1",
                    model: "test-model",
                    retries: 0,
                },
                {
                    systemPrompt: "Summarize.",
                    userContent: "Content.",
                },
            ),
            (error: unknown) => {
                assert.ok(error instanceof ExternalModelError)
                assert.equal(error.kind, "empty")
                return true
            },
        )
    } finally {
        mock.restore()
    }
})

test("generateSummaryViaExternal throws ExternalModelError kind=http on 500", async () => {
    const mock = mockFetch([
        {
            status: 500,
            body: { error: "internal server error" },
        },
        {
            status: 500,
            body: { error: "internal server error" },
        },
    ])

    try {
        await assert.rejects(
            generateSummaryViaExternal(
                {
                    url: "http://localhost:8000/v1",
                    model: "test-model",
                    retries: 0,
                },
                {
                    systemPrompt: "Summarize.",
                    userContent: "Content.",
                },
            ),
            (error: unknown) => {
                assert.ok(error instanceof ExternalModelError)
                assert.equal(error.kind, "http")
                assert.match(error.message, /500/)
                return true
            },
        )
    } finally {
        mock.restore()
    }
})

test("generateSummaryViaExternal throws ExternalModelError kind=network on fetch error", async () => {
    const mock = mockFetch([
        {
            status: null,
            throwError: new TypeError("Failed to fetch"),
        },
        {
            status: null,
            throwError: new TypeError("Failed to fetch"),
        },
    ])

    try {
        await assert.rejects(
            generateSummaryViaExternal(
                {
                    url: "http://localhost:8000/v1",
                    model: "test-model",
                },
                {
                    systemPrompt: "Summarize.",
                    userContent: "Content.",
                },
            ),
            (error: unknown) => {
                assert.ok(error instanceof ExternalModelError)
                assert.equal(error.kind, "network")
                return true
            },
        )
    } finally {
        mock.restore()
    }
})

test("generateSummaryViaExternal throws ExternalModelError kind=timeout on AbortError", async () => {
    const mock = mockFetch([
        {
            status: null,
            throwError: Object.assign(new Error("The operation was aborted"), {
                name: "AbortError",
            }),
        },
        {
            status: null,
            throwError: Object.assign(new Error("The operation was aborted"), {
                name: "AbortError",
            }),
        },
    ])

    try {
        await assert.rejects(
            generateSummaryViaExternal(
                {
                    url: "http://localhost:8000/v1",
                    model: "test-model",
                },
                {
                    systemPrompt: "Summarize.",
                    userContent: "Content.",
                },
            ),
            (error: unknown) => {
                assert.ok(error instanceof ExternalModelError)
                assert.equal(error.kind, "timeout")
                return true
            },
        )
    } finally {
        mock.restore()
    }
})

test("generateSummaryViaExternal retries once on failure then succeeds", async () => {
    const mock = mockFetch([
        {
            status: null,
            throwError: new TypeError("network failure"),
        },
        {
            status: 200,
            body: {
                choices: [
                    {
                        message: {
                            content: "Retried and succeeded summary.",
                        },
                    },
                ],
            },
        },
    ])

    try {
        const result = await generateSummaryViaExternal(
            {
                url: "http://localhost:8000/v1",
                model: "test-model",
            },
            {
                systemPrompt: "Summarize.",
                userContent: "Content.",
            },
        )
        assert.equal(result, "Retried and succeeded summary.")
    } finally {
        mock.restore()
    }
})

test("generateSummaryViaExternal sends correct request body to the API", async () => {
    let capturedBody: string | undefined

    const originalFetch = globalThis.fetch
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
        capturedBody = init?.body as string | undefined
        return new Response(
            JSON.stringify({
                choices: [{ message: { content: "ok" } }],
            }),
            { status: 200 },
        )
    }) as typeof fetch

    try {
        await generateSummaryViaExternal(
            {
                url: "http://localhost:8000/v1",
                apiKey: "sk-test",
                model: "gpt-4o-mini",
                timeout: 5000,
            },
            {
                systemPrompt: "You are a summarizer.",
                userContent: "Some conversation content.",
            },
        )

        assert.ok(capturedBody)
        const parsed = JSON.parse(capturedBody)
        assert.equal(parsed.model, "gpt-4o-mini")
        assert.equal(parsed.temperature, 0)
        assert.equal(parsed.messages.length, 2)
        assert.equal(parsed.messages[0].role, "system")
        assert.equal(parsed.messages[0].content, "You are a summarizer.")
        assert.equal(parsed.messages[1].role, "user")
        assert.equal(parsed.messages[1].content, "Some conversation content.")
    } finally {
        globalThis.fetch = originalFetch
    }
})

test("generateSummaryViaExternal throws kind=parse on invalid JSON", async () => {
    const originalFetch = globalThis.fetch
    globalThis.fetch = (async () => {
        return new Response("not-json", { status: 200 })
    }) as typeof fetch

    try {
        await assert.rejects(
            generateSummaryViaExternal(
                {
                    url: "http://localhost:8000/v1",
                    model: "test-model",
                },
                {
                    systemPrompt: "Summarize.",
                    userContent: "Content.",
                },
            ),
            (error: unknown) => {
                assert.ok(error instanceof ExternalModelError)
                assert.equal(error.kind, "parse")
                return true
            },
        )
    } finally {
        globalThis.fetch = originalFetch
    }
})
