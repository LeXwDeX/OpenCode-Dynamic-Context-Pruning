import assert from "node:assert/strict"
import test from "node:test"
import * as hooks from "../lib/hooks"

test("DCP exposes no command interception or host config mutation handlers", () => {
    assert.equal("createCommandExecuteHandler" in hooks, false)
    assert.equal("createConfigHandler" in hooks, false)
})
