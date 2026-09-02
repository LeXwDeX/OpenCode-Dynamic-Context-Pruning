/**
 * Loose structural types for session messages as delivered by the host's
 * `experimental.chat.messages.transform` hook. Deliberately duck-typed: the
 * engine only reads roles/part types and rewrites string payloads, so it
 * stays compatible across host versions without importing their schemas.
 */

export interface MessageInfoLike {
    id?: string
    role?: string
    sessionID?: string
    time?: { created?: number }
    summary?: boolean
}

export interface ToolStateLike {
    status?: string
    output?: string
    error?: unknown
    input?: Record<string, unknown>
    time?: { compacted?: number } & Record<string, unknown>
    metadata?: Record<string, unknown>
}

export interface PartLike {
    type?: string
    id?: string
    text?: string
    tool?: string
    state?: ToolStateLike
    [key: string]: unknown
}

export interface MessageLike {
    info?: MessageInfoLike
    parts?: PartLike[]
}

/** A turn = a user message plus everything up to the next user message. */
export interface Turn {
    /** Index of the user message that opens the turn. */
    start: number
    /** Exclusive end index in the message array. */
    end: number
}
