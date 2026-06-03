import assert from "node:assert/strict"
import test from "node:test"
import {
    matchesGlob,
    getFilePathsFromParameters,
    isFilePathProtected,
    isToolNameProtected,
} from "../lib/protected-patterns"

test("matchesGlob matches simple file names", () => {
    assert.equal(matchesGlob("foo.ts", "foo.ts"), true)
    assert.equal(matchesGlob("foo.ts", "bar.ts"), false)
})

test("matchesGlob handles empty pattern", () => {
    assert.equal(matchesGlob("foo.ts", ""), false)
})

test("matchesGlob handles single wildcard *", () => {
    assert.equal(matchesGlob("foo.ts", "*.ts"), true)
    assert.equal(matchesGlob("foo.js", "*.ts"), false)
    assert.equal(matchesGlob("src/foo.ts", "*.ts"), false) // * doesn't match /
})

test("matchesGlob handles double wildcard **", () => {
    assert.equal(matchesGlob("src/lib/foo.ts", "**"), true)
    assert.equal(matchesGlob("foo.ts", "**"), true)
})

test("matchesGlob handles **/ pattern (zero or more directories)", () => {
    assert.equal(matchesGlob("src/lib/foo.ts", "**/foo.ts"), true)
    assert.equal(matchesGlob("foo.ts", "**/foo.ts"), true)
    assert.equal(matchesGlob("src/bar.ts", "**/foo.ts"), false)
})

test("matchesGlob handles ? pattern (single char)", () => {
    assert.equal(matchesGlob("foo.ts", "fo?.ts"), true)
    assert.equal(matchesGlob("fob.ts", "fo?.ts"), true)
    assert.equal(matchesGlob("fooo.ts", "fo?.ts"), false)
    // ? should not match /
    assert.equal(matchesGlob("fo/.ts", "fo?.ts"), false)
})

test("matchesGlob handles / literal", () => {
    assert.equal(matchesGlob("src/foo.ts", "src/foo.ts"), true)
    assert.equal(matchesGlob("src/foo.ts", "lib/foo.ts"), false)
})

test("matchesGlob escapes regex special characters", () => {
    assert.equal(matchesGlob("foo.ts", "foo.ts"), true) // . is literal
    assert.equal(matchesGlob("fooxts", "foo.ts"), false) // . should not match any char
    assert.equal(matchesGlob("file[1].ts", "file[1].ts"), true)
})

test("matchesGlob normalizes backslashes", () => {
    // normalizePath replaces literal \\ (two backslashes) with /
    assert.equal(matchesGlob("src\\\\lib\\\\foo.ts", "src/lib/foo.ts"), true)
    assert.equal(matchesGlob("src/lib/foo.ts", "src\\\\lib\\\\foo.ts"), true)
})

test("matchesGlob handles complex patterns", () => {
    assert.equal(matchesGlob("src/components/Button.tsx", "src/**/*.tsx"), true)
    assert.equal(matchesGlob("src/components/deep/Button.tsx", "src/**/*.tsx"), true)
    assert.equal(matchesGlob("tests/Button.tsx", "src/**/*.tsx"), false)
})

test("getFilePathsFromParameters returns empty for non-object", () => {
    assert.deepEqual(getFilePathsFromParameters("read", null), [])
    assert.deepEqual(getFilePathsFromParameters("read", undefined), [])
    assert.deepEqual(getFilePathsFromParameters("read", "string"), [])
    assert.deepEqual(getFilePathsFromParameters("read", 42), [])
})

test("getFilePathsFromParameters extracts filePath from generic tool", () => {
    assert.deepEqual(getFilePathsFromParameters("read", { filePath: "src/foo.ts" }), ["src/foo.ts"])
})

test("getFilePathsFromParameters extracts paths from apply_patch", () => {
    const patchText = `*** Update File: src/index.ts
some patch content
*** Add File: src/new.ts
new file content
*** Delete File: src/old.ts
deleted`
    const result = getFilePathsFromParameters("apply_patch", { patchText })
    assert.deepEqual(result, ["src/index.ts", "src/new.ts", "src/old.ts"])
})

test("getFilePathsFromParameters extracts paths from multiedit", () => {
    const params = {
        filePath: "src/main.ts",
        edits: [
            { filePath: "src/a.ts", content: "..." },
            { filePath: "src/b.ts", content: "..." },
        ],
    }
    const result = getFilePathsFromParameters("multiedit", params)
    // Should deduplicate - filePath appears both at top level and via generic check
    assert.ok(result.includes("src/main.ts"))
    assert.ok(result.includes("src/a.ts"))
    assert.ok(result.includes("src/b.ts"))
})

test("getFilePathsFromParameters handles multiedit with non-object edits", () => {
    const params = {
        filePath: "src/main.ts",
        edits: [null, { notFilePath: "x" }, { filePath: "src/c.ts" }],
    }
    const result = getFilePathsFromParameters("multiedit", params)
    assert.ok(result.includes("src/main.ts"))
    assert.ok(result.includes("src/c.ts"))
})

test("getFilePathsFromParameters filters empty paths", () => {
    const result = getFilePathsFromParameters("read", { filePath: "" })
    assert.deepEqual(result, [])
})

test("isFilePathProtected returns false for empty inputs", () => {
    assert.equal(isFilePathProtected([], ["*.ts"]), false)
    assert.equal(isFilePathProtected(["src/a.ts"], []), false)
})

test("isFilePathProtected matches against patterns", () => {
    assert.equal(isFilePathProtected(["secret.env"], ["*.env"]), true)
    assert.equal(isFilePathProtected(["src/secret.env"], ["**/*.env"]), true)
    assert.equal(isFilePathProtected(["src/index.ts"], ["*.env"]), false)
    assert.equal(isFilePathProtected(["a.ts", "b.env"], ["*.env"]), true)
})

test("isToolNameProtected returns false for empty inputs", () => {
    assert.equal(isToolNameProtected("", ["bash"]), false)
    assert.equal(isToolNameProtected("bash", []), false)
})

test("isToolNameProtected matches exact tool names", () => {
    assert.equal(isToolNameProtected("bash", ["bash", "read"]), true)
    assert.equal(isToolNameProtected("write", ["bash", "read"]), false)
})

test("isToolNameProtected matches glob patterns for tools", () => {
    assert.equal(isToolNameProtected("bash_exec", ["bash*"]), true)
    assert.equal(isToolNameProtected("read_file", ["bash*"]), false)
})
