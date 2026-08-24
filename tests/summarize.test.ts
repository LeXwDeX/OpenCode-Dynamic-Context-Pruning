import assert from "node:assert/strict"
import test from "node:test"
import { Logger } from "../lib/logger"
import { SummarizeCoordinator } from "../lib/summarize"

const MODEL = { providerID: "anthropic", modelID: "claude-sonnet" }

function deferred<T>() {
    let resolve!: (value: T) => void
    let reject!: (reason?: unknown) => void
    const promise = new Promise<T>((resolvePromise, rejectPromise) => {
        resolve = resolvePromise
        reject = rejectPromise
    })
    return { promise, resolve, reject }
}

function coordinator(
    summarize: (input: unknown) => Promise<unknown>,
    options: { failureCooldownMs?: number; now?: () => number } = {},
) {
    const client = { session: { summarize } } as any
    return new SummarizeCoordinator(client, new Logger(false), {
        failureCooldownMs: options.failureCooldownMs ?? 30_000,
        now: options.now,
    })
}

test("summarize delegates checkpoint creation to the native session endpoint", async () => {
    const calls: unknown[] = []
    const subject = coordinator(async (input) => {
        calls.push(input)
        return { data: true }
    })

    const result = await subject.summarize({ sessionID: "ses_native", model: MODEL })

    assert.deepEqual(result, { status: "succeeded" })
    assert.deepEqual(calls, [
        {
            path: { id: "ses_native" },
            body: MODEL,
        },
    ])
})

test("same-session concurrent requests share one native compaction", async () => {
    const pending = deferred<unknown>()
    let calls = 0
    const subject = coordinator(async () => {
        calls++
        return pending.promise
    })

    const first = subject.summarize({ sessionID: "ses_one", model: MODEL })
    const second = subject.summarize({ sessionID: "ses_one", model: MODEL })

    assert.equal(first, second)
    assert.equal(calls, 1)
    pending.resolve({ data: true })
    assert.deepEqual(await first, { status: "succeeded" })
    assert.deepEqual(await second, { status: "succeeded" })
})

test("different sessions compact independently", async () => {
    const calls: string[] = []
    const subject = coordinator(async (input: any) => {
        calls.push(input.path.id)
        return { data: true }
    })

    await Promise.all([
        subject.summarize({ sessionID: "ses_a", model: MODEL }),
        subject.summarize({ sessionID: "ses_b", model: MODEL }),
    ])

    assert.deepEqual(calls.sort(), ["ses_a", "ses_b"])
})

test("failure is fail-open and starts a per-session cooldown", async () => {
    let now = 1_000
    let calls = 0
    const subject = coordinator(
        async () => {
            calls++
            throw new Error("native compaction failed")
        },
        { failureCooldownMs: 500, now: () => now },
    )

    assert.deepEqual(await subject.summarize({ sessionID: "ses_fail", model: MODEL }), {
        status: "failed",
        error: "native compaction failed",
    })
    assert.deepEqual(await subject.summarize({ sessionID: "ses_fail", model: MODEL }), {
        status: "cooldown",
        retryAfterMs: 500,
    })
    assert.equal(calls, 1)

    now += 500
    await subject.summarize({ sessionID: "ses_fail", model: MODEL })
    assert.equal(calls, 2)
})

test("native false/error responses never report a committed checkpoint", async (t) => {
    await t.test("false data", async () => {
        const subject = coordinator(async () => ({ data: false }))
        const result = await subject.summarize({ sessionID: "ses_false", model: MODEL })
        assert.equal(result.status, "failed")
    })

    await t.test("structured error", async () => {
        const subject = coordinator(async () => ({ error: { message: "provider error" } }))
        const result = await subject.summarize({ sessionID: "ses_error", model: MODEL })
        assert.equal(result.status, "failed")
    })
})

test("plugin restart has no checkpoint state to restore", async () => {
    let calls = 0
    const invoke = async () => {
        calls++
        return { data: true }
    }

    await coordinator(invoke).summarize({ sessionID: "ses_restart", model: MODEL })
    await coordinator(invoke).summarize({ sessionID: "ses_restart", model: MODEL })

    assert.equal(calls, 2, "each process delegates current checkpoint ownership to OpenCode")
})
