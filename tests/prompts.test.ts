import assert from "node:assert/strict"
import test from "node:test"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { tmpdir } from "node:os"
import { Logger } from "../lib/logger"
import { PromptStore } from "../lib/prompts/store"
import { SYSTEM as SYSTEM_PROMPT } from "../lib/prompts/system"

function createPromptStoreFixture(overrideContent?: string, overrideFileName = "system.md") {
    const rootDir = mkdtempSync(join(tmpdir(), "opencode-dcp-prompts-"))
    const configHome = join(rootDir, "config")
    const workspaceDir = join(rootDir, "workspace")

    mkdirSync(configHome, { recursive: true })
    mkdirSync(workspaceDir, { recursive: true })

    const previousConfigHome = process.env.XDG_CONFIG_HOME
    const previousOpencodeConfigDir = process.env.OPENCODE_CONFIG_DIR

    process.env.XDG_CONFIG_HOME = configHome
    delete process.env.OPENCODE_CONFIG_DIR

    if (overrideContent !== undefined) {
        const overrideDir = join(configHome, "opencode", "dcp-prompts", "overrides")
        mkdirSync(overrideDir, { recursive: true })
        writeFileSync(join(overrideDir, overrideFileName), overrideContent, "utf-8")
    }

    const store = new PromptStore(new Logger(false), workspaceDir, true)

    return {
        store,
        cleanup() {
            if (previousConfigHome === undefined) {
                delete process.env.XDG_CONFIG_HOME
            } else {
                process.env.XDG_CONFIG_HOME = previousConfigHome
            }

            if (previousOpencodeConfigDir === undefined) {
                delete process.env.OPENCODE_CONFIG_DIR
            } else {
                process.env.OPENCODE_CONFIG_DIR = previousOpencodeConfigDir
            }

            rmSync(rootDir, { recursive: true, force: true })
        },
    }
}

test("system prompt overrides handle reminder tags safely", async (t) => {
    await t.test("plain-text mentions do not invalidate copied system prompt overrides", () => {
        const fixture = createPromptStoreFixture(
            `${SYSTEM_PROMPT.trim()}\n\nExtra override line.\n`,
        )

        try {
            const runtimeSystemPrompt = fixture.store.getRuntimePrompts().system

            assert.match(runtimeSystemPrompt, /Extra override line\./)
            assert.match(runtimeSystemPrompt, /环境注入的元数据/)
        } finally {
            fixture.cleanup()
        }
    })

    await t.test("fully wrapped overrides are normalized to a single runtime wrapper", () => {
        const fixture = createPromptStoreFixture(
            `<dcp-system-reminder>\nWrapped override body\n</dcp-system-reminder>\n`,
        )

        try {
            const runtimeSystemPrompt = fixture.store.getRuntimePrompts().system
            const openingTags = runtimeSystemPrompt.match(/<dcp-system-reminder\b[^>]*>/g) ?? []
            const closingTags = runtimeSystemPrompt.match(/<\/dcp-system-reminder>/g) ?? []

            assert.equal(openingTags.length, 1)
            assert.equal(closingTags.length, 1)
            assert.match(runtimeSystemPrompt, /Wrapped override body/)
        } finally {
            fixture.cleanup()
        }
    })

    await t.test("malformed boundary wrappers are rejected", () => {
        const baselineFixture = createPromptStoreFixture()
        const malformedFixture = createPromptStoreFixture(
            `<dcp-system-reminder>\nMalformed override body\n`,
        )

        try {
            const baselineSystemPrompt = baselineFixture.store.getRuntimePrompts().system
            const malformedSystemPrompt = malformedFixture.store.getRuntimePrompts().system

            assert.equal(malformedSystemPrompt, baselineSystemPrompt)
            assert.doesNotMatch(malformedSystemPrompt, /Malformed override body/)
        } finally {
            malformedFixture.cleanup()
            baselineFixture.cleanup()
        }
    })
})

test("prompt store exposes bundled message-mode compress prompt", () => {
    const fixture = createPromptStoreFixture()

    try {
        const runtimePrompts = fixture.store.getRuntimePrompts()

        assert.match(runtimePrompts.compressMessage, /选定的单条消息/)
        assert.match(
            runtimePrompts.compressMessage,
            /只使用.*mNNNN.*形式的原始消息 ID/,
        )
        assert.match(runtimePrompts.compressMessage, /priority.*属性/)
        assert.match(runtimePrompts.compressMessage, /高优先级消息/)
        assert.match(runtimePrompts.compressMessage, /标记为/)
        assert.match(runtimePrompts.compressMessage, /不能被压缩/)
        assert.doesNotMatch(runtimePrompts.compressMessage, /THE FORMAT OF COMPRESS/)
    } finally {
        fixture.cleanup()
    }
})

test("compress-message overrides preserve plain-text metadata mentions", () => {
    const fixture = createPromptStoreFixture(
        [
            "Override body.",
            "",
            'Each message has an ID inside XML metadata tags like `<dcp-message-id priority="high">m0007</dcp-message-id>`.',
            "Messages marked as `<dcp-message-id>BLOCKED</dcp-message-id>` cannot be compressed.",
        ].join("\n"),
        "compress-message.md",
    )

    try {
        const runtimePrompts = fixture.store.getRuntimePrompts()

        assert.match(runtimePrompts.compressMessage, /Override body\./)
        assert.match(
            runtimePrompts.compressMessage,
            /<dcp-message-id priority="high">m0007<\/dcp-message-id>/,
        )
        assert.match(runtimePrompts.compressMessage, /<dcp-message-id>BLOCKED<\/dcp-message-id>/)
    } finally {
        fixture.cleanup()
    }
})

test("prompt store exposes bundled range-mode compress prompt", () => {
    const fixture = createPromptStoreFixture()

    try {
        const runtimePrompts = fixture.store.getRuntimePrompts()

        assert.match(runtimePrompts.compressRange, /将对话中的一个范围折叠/)
        assert.match(runtimePrompts.compressRange, /压缩块占位符/)
        assert.match(runtimePrompts.compressRange, /批量处理/)
        assert.match(runtimePrompts.compressRange, /content` 数组/)
    } finally {
        fixture.cleanup()
    }
})
