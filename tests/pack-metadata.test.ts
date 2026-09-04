import assert from "node:assert/strict"
import test from "node:test"
import { parsePackMetadata } from "../scripts/parse-pack-metadata.mjs"

const expected = { name: "@fixture/plugin", version: "1.2.3" }
const metadata = {
    id: "@fixture/plugin@1.2.3",
    ...expected,
    files: [
        { path: "package.json", size: 123, mode: 420 },
        { path: "dist/index.js", size: 456, mode: 420 },
    ],
    entryCount: 2,
}
const formats = [
    ["npm 11 array", (value: unknown) => [value]],
    ["npm 12 name-keyed object", (value: unknown) => ({ [expected.name]: value })],
] as const

for (const [name, wrap] of formats) {
    test(`${name} preserves complete pack metadata`, () => {
        assert.deepEqual(parsePackMetadata(JSON.stringify(wrap(metadata)), expected), metadata)
    })

    test(`${name} rejects missing or mismatched package identity`, () => {
        for (const value of [
            null,
            [],
            "package",
            { ...metadata, name: undefined },
            { ...metadata, name: "another-plugin" },
            { ...metadata, version: undefined },
            { ...metadata, version: "1.2.4" },
        ]) {
            assert.throws(
                () => parsePackMetadata(JSON.stringify(wrap(value)), expected),
                /package identity must match/,
                JSON.stringify(value),
            )
        }
    })

    test(`${name} rejects absent, empty and malformed file metadata`, () => {
        for (const files of [
            undefined,
            null,
            {},
            "package.json",
            [],
            [null],
            ["package.json"],
            [{}],
            [{ path: 42 }],
            [{ path: "" }],
            [{ path: " \t\n" }],
            [metadata.files[0], { path: "" }],
        ]) {
            assert.throws(
                () => parsePackMetadata(JSON.stringify(wrap({ ...metadata, files })), expected),
                /nonempty file metadata with valid paths/,
                JSON.stringify(files),
            )
        }
    })

    test(`${name} retains all paths for downstream tarball policy checks`, () => {
        const value = {
            ...metadata,
            files: [...metadata.files, { path: "scripts/forbidden.mjs", size: 100, mode: 420 }],
            entryCount: 3,
            futureMetadata: { preserved: true },
        }
        assert.deepEqual(parsePackMetadata(JSON.stringify(wrap(value)), expected), value)
    })
}

test("pack metadata rejects malformed JSON and non-container values", () => {
    assert.throws(() => parsePackMetadata("[", expected), /did not return valid JSON/)
    for (const value of [null, true, 1, "package"]) {
        assert.throws(
            () => parsePackMetadata(JSON.stringify(value), expected),
            /package array or name-keyed object/,
        )
    }
})

test("pack metadata requires exactly one package in both formats", () => {
    for (const value of [
        [],
        {},
        [metadata, metadata],
        { [expected.name]: metadata, another: { ...metadata, name: "another" } },
        metadata,
    ]) {
        assert.throws(
            () => parsePackMetadata(JSON.stringify(value), expected),
            /exactly one package/,
        )
    }
})

test("npm 12 package key must match the expected identity", () => {
    assert.throws(
        () => parsePackMetadata(JSON.stringify({ another: metadata }), expected),
        /package key must match/,
    )
})

test("pack metadata requires a usable expected identity", () => {
    for (const identity of [
        undefined,
        null,
        {},
        { name: "", version: "1.2.3" },
        { name: " \t", version: "1.2.3" },
        { name: "@fixture/plugin", version: "" },
        { name: "@fixture/plugin", version: 123 },
    ]) {
        assert.throws(
            () => parsePackMetadata(JSON.stringify([metadata]), identity),
            /expected package identity must contain a name and version/,
        )
    }
})
