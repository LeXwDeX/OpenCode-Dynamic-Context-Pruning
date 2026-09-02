import assert from "node:assert/strict"
import test from "node:test"
import { PruneService } from "../lib/prune-service"
import { Logger } from "../lib/logger"
import { SummarizeCoordinator } from "../lib/summarize"
import type { SummarizeRequest } from "../lib/summarize"
import { MODEL_MESSAGES, drainUntil, fakeOpenCodeClient, flushMicrotasks } from "./fixtures"

interface Harness {
    service: PruneService
    summarizeCalls: Array<{ sessionID: string; model: unknown }>
    nativeCalls: unknown[]
    client: any
    coordinator: SummarizeCoordinator
    setNow: (at: number) => void
    /** Fire the armed quiet-window timers, driving pending windows to the
     * expiry probe and (when it says not busy) the at-rest classification. */
    reachBoundary: () => Promise<void>
}

function fakeLogger() {
    const entries: Array<{ level: "debug" | "warn"; message: string }> = []
    const logger = {
        debug: (message: string) => {
            entries.push({ level: "debug", message })
        },
        warn: (message: string) => {
            entries.push({ level: "warn", message })
        },
    }
    return { logger: logger as any, entries }
}

function build(
    options: {
        messages?: unknown[]
        native?: () => Promise<unknown>
        logger?: any
        summarize?: (request: SummarizeRequest) => Promise<unknown>
    } = {},
): Harness {
    let clock = 0
    const now = () => clock
    let handle = 0
    const timers = new Map<number, () => void>()
    const summarizeCalls: Array<{ sessionID: string; model: unknown }> = []
    const { client, nativeCalls } = fakeOpenCodeClient(options)
    const logger = options.logger ?? new Logger(false)

    const coordinator = new SummarizeCoordinator(client, logger, {
        failureCooldownMs: 30_000,
        now,
    })
    const summarize = options.summarize
        ? ({
              summarize: async (request: SummarizeRequest) => {
                  summarizeCalls.push(request)
                  return options.summarize!(request)
              },
          } as any)
        : new Proxy(coordinator, {
              get(target, property, receiver) {
                  if (property === "summarize") {
                      return async (request: SummarizeRequest) => {
                          summarizeCalls.push(request)
                          return target.summarize(request)
                      }
                  }
                  return Reflect.get(target, property, receiver)
              },
          })
    const service = new PruneService({
        client,
        summarize,
        logger,
        now,
        setTimer: (fn: () => void, ms: number) => {
            handle += 1
            timers.set(handle, fn)
            return handle
        },
        clearTimer: (t: unknown) => {
            timers.delete(t as number)
        },
        probeTimeoutMs: 50,
    })

    const fireTimers = () => {
        const fns = [...timers.values()]
        timers.clear()
        for (const fn of fns) fn()
    }

    return {
        service,
        summarizeCalls,
        nativeCalls,
        client,
        coordinator,
        setNow: (at) => {
            clock = at
        },
        reachBoundary: async () => {
            fireTimers()
            await flushMicrotasks(50)
        },
    }
}

function idleEvent(sessionID: string) {
    return { type: "session.idle", properties: { sessionID } }
}

async function drain(h: Harness, expectedCalls: number): Promise<void> {
    await drainUntil(() => h.nativeCalls.length >= expectedCalls)
}

/** Queue a deferred prune, deliver an idle observation, and drive the quiet
 * window through expiry so the drain runs at the at-rest classification. */
async function deferAndReachAtRest(h: Harness, sessionID: string): Promise<void> {
    await h.service.request({ sessionID, onBusy: "defer" })
    h.service.observeEvent("session.idle", { sessionID })
    await h.reachBoundary()
}

test("defer queues the prune on an unknown-state session and fires at the at-rest boundary", async () => {
    const h = build()

    const outcome = await h.service.request({ sessionID: "ses_a", onBusy: "defer" })
    assert.deepEqual(outcome, { status: "deferred" })
    assert.equal(h.nativeCalls.length, 0)

    await deferAndReachAtRest(h, "ses_a")
    await drain(h, 1)

    assert.equal(h.nativeCalls.length, 1)
    assert.deepEqual(h.summarizeCalls[0].model, {
        providerID: "anthropic",
        modelID: "claude-sonnet",
    })
})

test("defer queues on an observed-busy session instead of interrupting the turn", async () => {
    const h = build()
    h.service.observeEvent("session.status", {
        sessionID: "ses_b",
        status: { type: "busy" },
    })

    const outcome = await h.service.request({ sessionID: "ses_b", onBusy: "defer" })
    assert.deepEqual(outcome, { status: "deferred" })
    assert.equal(h.nativeCalls.length, 0)
})

test("defer always queues, even when idle was just observed", async () => {
    const h = build()
    h.service.observeEvent("session.idle", { sessionID: "ses_c" })

    const outcome = await h.service.request({ sessionID: "ses_c", onBusy: "defer" })
    assert.deepEqual(outcome, { status: "deferred" })
    assert.equal(h.nativeCalls.length, 0)

    // A second idle leg is deduped; the armed window still expires to at-rest.
    h.service.observeEvent("session.idle", { sessionID: "ses_c" })
    await h.reachBoundary()
    await drain(h, 1)
    assert.equal(h.nativeCalls.length, 1)
})

test("proceed stands down on positive busy evidence without calling summarize", async () => {
    const h = build()
    h.service.observeEvent("session.status", {
        sessionID: "ses_d",
        status: { type: "busy" },
    })

    const outcome = await h.service.request({ sessionID: "ses_d", onBusy: "proceed" })
    assert.deepEqual(outcome, { status: "busy" })
    assert.equal(h.nativeCalls.length, 0)
})

test("proceed fires on an unknown-state session (fail-open for hosts without status events)", async () => {
    const h = build()

    const outcome = await h.service.request({ sessionID: "ses_e", onBusy: "proceed" })
    assert.deepEqual(outcome, { status: "succeeded" })
    assert.equal(h.nativeCalls.length, 1)
})

test("session.compacted cancels a queued prune instead of compacting twice", async () => {
    const h = build()
    await h.service.request({ sessionID: "ses_f", onBusy: "defer" })

    h.service.observeEvent("session.compacted", { sessionID: "ses_f" })
    h.service.observeEvent("session.idle", { sessionID: "ses_f" })
    await h.reachBoundary()
    await flushMicrotasks()

    assert.equal(h.nativeCalls.length, 0)
})

test("re-evaluates busy state after resolving the session model", async () => {
    const h = build()
    h.service.observeEvent("session.idle", { sessionID: "ses_g" })

    let resolveMessages!: (value: unknown) => void
    const gate = new Promise((resolve) => {
        resolveMessages = resolve
    })
    h.client.session.messages = async () => gate

    const pending = h.service.request({ sessionID: "ses_g", onBusy: "proceed" })
    h.service.observeEvent("session.status", {
        sessionID: "ses_g",
        status: { type: "busy" },
    })
    resolveMessages({ data: MODEL_MESSAGES })

    const outcome = await pending
    assert.deepEqual(outcome, { status: "busy" })
    assert.equal(h.nativeCalls.length, 0)
})

test("reports no-model without touching the native summarize", async () => {
    const h = build({ messages: [] })
    h.service.observeEvent("session.idle", { sessionID: "ses_h" })

    const outcome = await h.service.request({ sessionID: "ses_h", onBusy: "proceed" })
    assert.deepEqual(outcome, { status: "no-model" })
    assert.equal(h.nativeCalls.length, 0)
})

test("passes coordinator cooldown through as an outcome", async () => {
    const h = build({ native: async () => ({ error: "provider down" }) })
    h.service.observeEvent("session.idle", { sessionID: "ses_i" })

    const failed = await h.service.request({ sessionID: "ses_i", onBusy: "proceed" })
    assert.deepEqual(failed, { status: "failed", error: "provider down" })

    const cooldown = await h.service.request({ sessionID: "ses_i", onBusy: "proceed" })
    assert.equal(cooldown.status, "cooldown")
    assert.equal((cooldown as { retryAfterMs: number }).retryAfterMs, 30_000)
})

test("concurrent requests merge into one native summarize call", async () => {
    const h = build()
    let release!: (value: unknown) => void
    const gate = new Promise((resolve) => {
        release = resolve
    })
    h.client.session.summarize = async (input: unknown) => {
        h.nativeCalls.push(input)
        return gate
    }
    h.service.observeEvent("session.idle", { sessionID: "ses_j" })

    const first = h.service.request({ sessionID: "ses_j", onBusy: "proceed" })
    const second = h.service.request({ sessionID: "ses_j", onBusy: "proceed" })
    await drain(h, 1)
    release({ data: true })
    const [firstOutcome, secondOutcome] = await Promise.all([first, second])

    assert.deepEqual(firstOutcome, { status: "succeeded" })
    assert.deepEqual(secondOutcome, { status: "succeeded" })
    assert.equal(h.nativeCalls.length, 1)
})

test("queued prune merges with a direct auto prune firing on the same at-rest boundary", async () => {
    const h = build()
    let release!: (value: unknown) => void
    const gate = new Promise((resolve) => {
        release = resolve
    })
    h.client.session.summarize = async (input: unknown) => {
        h.nativeCalls.push(input)
        return gate
    }
    await h.service.request({ sessionID: "ses_k", onBusy: "defer" })
    h.service.observeEvent("session.idle", { sessionID: "ses_k" })

    const direct = h.service.request({ sessionID: "ses_k", onBusy: "proceed" })
    await drain(h, 1)
    await h.reachBoundary()
    release({ data: true })
    const directOutcome = await direct

    assert.deepEqual(directOutcome, { status: "succeeded" })
    assert.equal(h.nativeCalls.length, 1)
})

test("stale busy evidence decays to unknown after the TTL", async () => {
    const h = build()
    h.service.observeEvent("session.status", {
        sessionID: "ses_l",
        status: { type: "busy" },
    })
    assert.equal(h.service.boundary.state("ses_l"), "busy")

    h.setNow(11 * 60_000)
    assert.equal(h.service.boundary.state("ses_l"), "unknown")

    const outcome = await h.service.request({ sessionID: "ses_l", onBusy: "proceed" })
    assert.deepEqual(outcome, { status: "succeeded" })
})

test("the server probe treats a retrying turn as busy", async () => {
    const h = build()
    h.client.session.status = async () => ({
        data: { ses_retry: { type: "retry", attempt: 2, message: "rate limited", next: 500 } },
    })

    const outcome = await h.service.request({ sessionID: "ses_retry", onBusy: "proceed" })
    assert.deepEqual(outcome, { status: "busy" })
    assert.equal(h.nativeCalls.length, 0)
})

test("a busy rejection maps to the busy outcome without arming the failure cooldown", async () => {
    let calls = 0
    const h = build({
        native: async () => {
            calls++
            return { error: { message: "session is busy" } }
        },
    })
    h.service.observeEvent("session.idle", { sessionID: "ses_409" })

    const first = await h.service.request({ sessionID: "ses_409", onBusy: "proceed" })
    assert.deepEqual(first, { status: "busy" })

    const second = await h.service.request({ sessionID: "ses_409", onBusy: "proceed" })
    assert.deepEqual(second, { status: "busy" })
    assert.equal(calls, 2, "busy rejections never arm the failure cooldown")
})

test("proceed stands down when the server reports the session busy", async () => {
    const h = build()
    h.client.session.status = async () => ({
        data: { ses_probe: { type: "busy" } },
    })

    const outcome = await h.service.request({ sessionID: "ses_probe", onBusy: "proceed" })
    assert.deepEqual(outcome, { status: "busy" })
    assert.equal(h.nativeCalls.length, 0)
})

test("defer re-queues when the server reports busy despite observed idle", async () => {
    const h = build()
    h.service.observeEvent("session.idle", { sessionID: "ses_probe_defer" })
    h.client.session.status = async () => ({
        data: { ses_probe_defer: { type: "busy" } },
    })

    const outcome = await h.service.request({ sessionID: "ses_probe_defer", onBusy: "defer" })
    assert.deepEqual(outcome, { status: "deferred" })
    assert.equal(h.nativeCalls.length, 0)

    // The window expires but the expiry probe sees busy: relay idle, no fire.
    h.client.session.status = async () => ({ data: {} })
    h.service.observeEvent("session.idle", { sessionID: "ses_probe_defer" })
    await h.reachBoundary()
    await drain(h, 1)
    assert.equal(h.nativeCalls.length, 1)
})

test("fails open when the host does not expose a status endpoint", async () => {
    const h = build()
    delete h.client.session.status

    const outcome = await h.service.request({ sessionID: "ses_legacy", onBusy: "proceed" })
    assert.deepEqual(outcome, { status: "succeeded" })
    assert.equal(h.nativeCalls.length, 1)
})

test("an at-rest drain on a status-less host still fires (T3 fail-open boundary)", async () => {
    const h = build()
    delete h.client.session.status

    await deferAndReachAtRest(h, "ses_t3")
    await drain(h, 1)
    assert.equal(h.nativeCalls.length, 1, "the probe failing open still classifies at-rest")
})

test("a busy rejection from the host maps to the busy outcome, not failed", async () => {
    const h = build({ native: async () => ({ error: "Session is busy" }) })
    h.service.observeEvent("session.idle", { sessionID: "ses_409" })

    const outcome = await h.service.request({ sessionID: "ses_409", onBusy: "proceed" })
    assert.deepEqual(outcome, { status: "busy" })
})

test("a queued prune that loses the busy race re-queues for the next at-rest", async () => {
    const h = build()
    await h.service.request({ sessionID: "ses_rq", onBusy: "defer" })

    h.client.session.status = async () => ({ data: { ses_rq: { type: "busy" } } })
    h.service.observeEvent("session.idle", { sessionID: "ses_rq" })
    await h.reachBoundary()
    await flushMicrotasks()
    assert.equal(h.nativeCalls.length, 0, "drain stood down without calling the native endpoint")

    h.client.session.status = async () => ({ data: {} })
    h.service.observeEvent("session.idle", { sessionID: "ses_rq" })
    await h.reachBoundary()
    await drain(h, 1)
    assert.equal(h.nativeCalls.length, 1, "the re-queued prune executed at the next at-rest")
})

test("a relay idle during the quiet window cancels the drain entirely", async () => {
    const h = build()
    await h.service.request({ sessionID: "ses_relay", onBusy: "defer" })

    h.service.observeEvent("session.idle", { sessionID: "ses_relay" })
    h.service.observeEvent("session.status", {
        sessionID: "ses_relay",
        status: { type: "busy" },
    })
    await h.reachBoundary()
    await flushMicrotasks()

    assert.equal(h.nativeCalls.length, 0, "a cancelled window must not drain")
    // The deferred prune survives and drains at the next real at-rest.
    h.service.observeEvent("session.status", {
        sessionID: "ses_relay",
        status: { type: "idle" },
    })
    await h.reachBoundary()
    await drain(h, 1)
    assert.equal(h.nativeCalls.length, 1)
})

test("events without a sessionID never touch the queue", async () => {
    const h = build()
    h.service.observeEvent("session.idle", {})
    h.service.observeEvent("message.updated", { sessionID: "ses_m" })

    assert.equal(h.nativeCalls.length, 0)
    const outcome = await h.service.request({ sessionID: "ses_m", onBusy: "proceed" })
    assert.deepEqual(outcome, { status: "succeeded" })
})

test("session.deleted with the SDK info shape cancels the queue and drops tracker state", async () => {
    const h = build()
    await h.service.request({ sessionID: "ses_del", onBusy: "defer" })
    h.service.observeEvent("session.status", {
        sessionID: "ses_del",
        status: { type: "busy" },
    })
    assert.equal(h.service.boundary.state("ses_del"), "busy")

    h.service.observeEvent("session.deleted", { info: { id: "ses_del" } })
    assert.equal(
        h.service.boundary.state("ses_del"),
        "unknown",
        "state must drop for the info shape",
    )

    h.service.observeEvent("session.idle", { sessionID: "ses_del" })
    await h.reachBoundary()
    await flushMicrotasks()
    assert.equal(h.nativeCalls.length, 0, "the cancelled queued prune must not execute")
})

test("session.deleted mid-window cancels the pending boundary (never fire after deleted)", async () => {
    const h = build()
    await h.service.request({ sessionID: "ses_del_win", onBusy: "defer" })
    h.service.observeEvent("session.idle", { sessionID: "ses_del_win" })
    h.service.observeEvent("session.deleted", { sessionID: "ses_del_win" })
    await h.reachBoundary()
    await flushMicrotasks()

    assert.equal(h.nativeCalls.length, 0)
})

test("a failed drain outcome is observable and never re-queued", async () => {
    const log = fakeLogger()
    const h = build({ native: async () => ({ error: "provider down" }), logger: log.logger })
    await deferAndReachAtRest(h, "ses_drain_fail")
    await drain(h, 1)
    await flushMicrotasks()
    assert.equal(h.nativeCalls.length, 1)
    assert.ok(
        log.entries.some((entry) => entry.level === "warn"),
        "the failure is visible in the logs",
    )

    h.service.observeEvent("session.idle", { sessionID: "ses_drain_fail" })
    await h.reachBoundary()
    await flushMicrotasks()
    assert.equal(h.nativeCalls.length, 1, "a failed terminal outcome is not retried")
})

test("a throwing drain is observable and never re-queued", async () => {
    const log = fakeLogger()
    const h = build({
        logger: log.logger,
        summarize: async () => {
            throw new Error("summarize exploded")
        },
    })
    await deferAndReachAtRest(h, "ses_drain_throw")
    await flushMicrotasks()
    assert.equal(h.nativeCalls.length, 0)
    assert.ok(
        log.entries.some((entry) => entry.level === "warn" && /drain/i.test(entry.message)),
        "the throw is visible in the logs",
    )

    h.service.observeEvent("session.idle", { sessionID: "ses_drain_throw" })
    await h.reachBoundary()
    await flushMicrotasks()
    assert.equal(h.nativeCalls.length, 0, "a throwing drain is not retried")
})

test("a never-returning probe releases the boundary within the timeout (R2/I5)", async () => {
    const h = build()
    h.client.session.status = () => new Promise(() => {})
    await h.service.request({ sessionID: "ses_hang", onBusy: "defer" })
    h.service.observeEvent("session.idle", { sessionID: "ses_hang" })

    // Drive the window expiry; the expiry probe hangs and must be cut short by
    // the 50ms injected deadline, fail open to at-rest, and drain.
    await h.reachBoundary()
    await new Promise((resolve) => setTimeout(resolve, 150))
    await drainUntil(() => h.nativeCalls.length > 0)

    assert.equal(h.nativeCalls.length, 1, "the hung probe must fail open to at-rest and drain")
})
