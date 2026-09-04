/** Host-owned message payloads. The projection only adds native compacted
 * timestamps on successful tool states; all other fields survive unchanged. */
export interface MessageInfoLike {
    id?: string
    role?: string
    sessionID?: string
    time?: { created?: number }
    summary?: boolean
    [key: string]: unknown
}

export interface ToolStateLike {
    status?: string
    output?: string
    error?: unknown
    input?: Record<string, unknown>
    time?: { compacted?: number } & Record<string, unknown>
    metadata?: Record<string, unknown>
    attachments?: unknown
    [key: string]: unknown
}

export interface PartLike {
    type?: string
    id?: string
    callID?: string
    text?: string
    tool?: string
    state?: ToolStateLike
    [key: string]: unknown
}

export interface MessageLike {
    info?: MessageInfoLike
    parts?: PartLike[]
    [key: string]: unknown
}
