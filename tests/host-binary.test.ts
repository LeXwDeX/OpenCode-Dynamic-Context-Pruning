import assert from "node:assert/strict"
import test from "node:test"
import {
    binaryEnvironment,
    binarySettingsFrom,
    parseBinaryArguments,
} from "./host/binary-runtime.mjs"

test("binary runner requires an explicit artifact identity and evidence directory", () => {
    const valid = [
        "--binary",
        "/tmp/release/opencode",
        "--version",
        "1.0.39",
        "--sha256",
        "a".repeat(64),
        "--output",
        "/tmp/results",
    ]
    assert.equal(parseBinaryArguments(valid).version, "1.0.39")
    for (const invalid of [
        [],
        valid.slice(0, -2),
        [...valid, "--version", "latest"],
        [...valid, "--unknown", "x"],
        ["--binary", "opencode", ...valid.slice(2)],
    ])
        assert.throws(() => parseBinaryArguments(invalid))
    assert.throws(() =>
        parseBinaryArguments(valid.map((value) => (value === "a".repeat(64) ? "unknown" : value))),
    )
})

test("binary mode cannot inherit an implicit runtime or DCP switch", () => {
    assert.equal(binarySettingsFrom({}), undefined)
    assert.throws(() => binarySettingsFrom({ DCP_BINARY_PATH: "/tmp/opencode" }))
    const selected = binarySettingsFrom({
        DCP_BINARY_PATH: "/tmp/opencode",
        DCP_BINARY_OUTPUT: "/tmp/output",
        DCP_BINARY_NATIVE: "false",
        DCP_BINARY_ENABLED: "true",
    })
    assert.equal(selected.native, false)
    assert.equal(selected.enabled, true)
})

test("binary environment only includes explicit disposable paths and required flags", () => {
    const environment = binaryEnvironment("/tmp/disposable", true, "/usr/bin:/bin")
    assert.equal(environment.HOME, "/tmp/disposable/home")
    assert.equal(environment.OPENCODE_DB, "/tmp/disposable/host.sqlite")
    assert.equal(environment.OPENCODE_EXPERIMENTAL_NATIVE_LLM, "true")
    assert.equal(environment.OPENCODE_DISABLE_DEFAULT_PLUGINS, "true")
    assert.equal("OPENCODE_CONFIG_CONTENT" in environment, false)
    assert.equal("OPENCODE_SERVER_PASSWORD" in environment, false)
    assert.equal("OPENAI_API_KEY" in environment, false)
})
