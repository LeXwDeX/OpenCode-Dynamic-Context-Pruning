import assert from "node:assert/strict"
import test from "node:test"
import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createEventHandler } from "../lib/hooks"
import { Logger } from "../lib/logger"
import {
    checkSession,
    createSessionState,
    initializeSessionState,
    saveSessionState,
    SessionStateStore,
    type WithParts,
} from "../lib/state"

function deferred<T>() {
    let resolve!: (value: T) => void
    const promise = new Promise<T>((done) => {
        resolve = done
    })
    return { promise, resolve }
}

function messagesFor(sessionId: string, messageId: string): WithParts[] {
    return [
        {
            info: {
                id: messageId,
                role: "user",
                sessionID: sessionId,
                agent: "assistant",
                time: { created: 1 },
            } as WithParts["info"],
            parts: [],
        },
    ]
}

test("SessionStateStore isolates sessions when initialization completes out of order", async () => {
    const store = new SessionStateStore(createSessionState)
    const sessionA = deferred<{ data: { parentID: string | null } }>()
    const sessionB = deferred<{ data: { parentID: string | null } }>()
    const client = {
        session: {
            get: ({ path }: { path: { id: string } }) =>
                path.id === "session-a" ? sessionA.promise : sessionB.promise,
        },
    }

    const initializingA = initializeSessionState(
        client,
        store,
        "session-a",
        new Logger(false),
        messagesFor("session-a", "message-a"),
        false,
    )
    const initializingB = initializeSessionState(
        client,
        store,
        "session-b",
        new Logger(false),
        messagesFor("session-b", "message-b"),
        false,
    )

    sessionB.resolve({ data: { parentID: null } })
    sessionA.resolve({ data: { parentID: "parent-session" } })
    await Promise.all([initializingA, initializingB])

    const stateA = store.peek("session-a")
    const stateB = store.peek("session-b")
    assert.equal(stateA?.sessionId, "session-a")
    assert.equal(stateA?.isSubAgent, true)
    assert.equal(stateB?.sessionId, "session-b")
    assert.equal(stateB?.isSubAgent, false)
    assert.notEqual(stateA, stateB)
})

test("saveSessionState exposes filesystem failures to callers", async () => {
    const root = await mkdtemp(join(tmpdir(), "dcp-persistence-error-"))
    const blocker = join(root, "not-a-directory")
    await writeFile(blocker, "blocked", "utf-8")
    const previousDataHome = process.env.XDG_DATA_HOME
    process.env.XDG_DATA_HOME = blocker

    try {
        const state = createSessionState()
        state.sessionId = "session-write-failure"
        await assert.rejects(saveSessionState(state, new Logger(false)))
    } finally {
        if (previousDataHome === undefined) delete process.env.XDG_DATA_HOME
        else process.env.XDG_DATA_HOME = previousDataHome
        await rm(root, { recursive: true, force: true })
    }
})

test("SessionStateStore transfers timing events that arrive before session ownership", async () => {
    const store = new SessionStateStore(createSessionState)
    const handler = createEventHandler(store, new Logger(false))

    await handler({
        event: {
            type: "message.part.updated",
            time: 100,
            properties: {
                part: {
                    type: "tool",
                    tool: "compress",
                    callID: "call-1",
                    messageID: "message-late",
                    state: { status: "pending" },
                },
            },
        },
    })
    await handler({
        event: {
            type: "message.part.updated",
            time: 350,
            properties: {
                part: {
                    type: "tool",
                    tool: "compress",
                    callID: "call-1",
                    messageID: "message-late",
                    state: { status: "completed" },
                },
            },
        },
    })

    const state = await initializeSessionState(
        { session: { get: async () => ({ data: { parentID: null } }) } },
        store,
        "session-late",
        new Logger(false),
        messagesFor("session-late", "message-late"),
        false,
    )

    assert.deepEqual(state.compressionTiming.pendingByCallId.get("message-late:call-1"), {
        messageId: "message-late",
        callId: "call-1",
        durationMs: 250,
    })
})

test("checkSession registers messages added after initialization for timing events", async () => {
    const store = new SessionStateStore(createSessionState)
    const logger = new Logger(false)
    const client = { session: { get: async () => ({ data: { parentID: null } }) } }
    await initializeSessionState(
        client,
        store,
        "session-active",
        logger,
        messagesFor("session-active", "message-initial"),
        false,
    )

    await checkSession(client, store, logger, messagesFor("session-active", "message-new"), false)

    const handler = createEventHandler(store, logger)
    await handler({
        event: {
            type: "message.part.updated",
            time: 100,
            properties: {
                part: {
                    type: "tool",
                    tool: "compress",
                    callID: "call-new",
                    messageID: "message-new",
                    state: { status: "pending" },
                },
            },
        },
    })
    await handler({
        event: {
            type: "message.part.updated",
            time: 300,
            properties: {
                part: {
                    type: "tool",
                    tool: "compress",
                    callID: "call-new",
                    messageID: "message-new",
                    state: { status: "completed" },
                },
            },
        },
    })

    assert.equal(
        store.peek("session-active")?.compressionTiming.pendingByCallId.get("message-new:call-new")
            ?.durationMs,
        200,
    )
})
