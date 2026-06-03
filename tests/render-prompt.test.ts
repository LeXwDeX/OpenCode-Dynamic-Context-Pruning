import assert from "node:assert/strict"
import test from "node:test"
import { renderSystemPrompt } from "../lib/prompts"
import type { RuntimePrompts } from "../lib/prompts/store"

function buildPrompts(overrides?: Partial<RuntimePrompts>): RuntimePrompts {
    return {
        system: "You are in a context-limited environment.",
        compress: "Compress the conversation.",
        contextLimitNudge: "Context is over limit.",
        turnNudge: "Turn nudge.",
        iterationNudge: "Iteration nudge.",
        manualExtension: "Manual mode is active.",
        subagentExtension: "You are a sub-agent.",
        ...overrides,
    }
}

test("renderSystemPrompt returns system prompt without extensions", () => {
    const prompts = buildPrompts()
    const result = renderSystemPrompt(prompts)
    assert.ok(result.includes("context-limited environment"))
    assert.ok(!result.includes("Manual mode"))
    assert.ok(!result.includes("sub-agent"))
})

test("renderSystemPrompt includes protected tools extension", () => {
    const prompts = buildPrompts()
    const result = renderSystemPrompt(prompts, "Protected: bash, read")
    assert.ok(result.includes("Protected: bash, read"))
})

test("renderSystemPrompt includes manual extension when manual=true", () => {
    const prompts = buildPrompts()
    const result = renderSystemPrompt(prompts, undefined, true)
    assert.ok(result.includes("Manual mode is active"))
})

test("renderSystemPrompt includes subagent extension when subagent=true", () => {
    const prompts = buildPrompts()
    const result = renderSystemPrompt(prompts, undefined, false, true)
    assert.ok(result.includes("sub-agent"))
})

test("renderSystemPrompt includes all extensions together", () => {
    const prompts = buildPrompts()
    const result = renderSystemPrompt(prompts, "Protected tools list", true, true)
    assert.ok(result.includes("Protected tools list"))
    assert.ok(result.includes("Manual mode is active"))
    assert.ok(result.includes("sub-agent"))
})

test("renderSystemPrompt collapses multiple blank lines", () => {
    const prompts = buildPrompts({ system: "Line1\n\n\n\nLine2" })
    const result = renderSystemPrompt(prompts)
    assert.ok(!result.includes("\n\n\n"))
    assert.ok(result.includes("Line1\n\nLine2"))
})

test("renderSystemPrompt skips empty extensions", () => {
    const prompts = buildPrompts()
    const result = renderSystemPrompt(prompts, "  ", false, false)
    // Empty trimmed extension should be excluded
    assert.ok(!result.endsWith("\n\n"))
})
