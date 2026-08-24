# Dynamic Context Pruning for OpenCode

[![npm version](https://img.shields.io/npm/v/@lexwdex-org/opencode-dcp.svg)](https://www.npmjs.com/package/@lexwdex-org/opencode-dcp)

**English** | [中文](./README.md)

DCP supplies a semantic-pruning policy to OpenCode's native compaction lifecycle. It no longer owns message markers, message IDs, compression blocks, anchors, placeholders, or a second summary state machine.

## How it works

OpenCode owns one rolling checkpoint. After compaction, the model sees only:

```text
latest pruned checkpoint + uncompacted recent tail
```

During `experimental.session.compacting`, DCP asks the summarizer to remove unrelated chat and other-project context, fold tool retries into the final successful result, fold repeated edits into the final state and valid decisions, and reduce small completed topics to short outcomes. Continuation-critical goals, constraints, decisions, implementation state, risks, and next steps remain.

Pruned prefixes stop being sent to the model, but the original session history is not physically deleted from OpenCode's database. A later compaction replaces the previous checkpoint with one merged checkpoint instead of nesting summaries or building a compression-block graph.

## Install

```bash
opencode plugin @lexwdex-org/opencode-dcp@latest --global
```

## Trigger compaction

- OpenCode automatic compaction uses the policy automatically.
- OpenCode's native `/compact` command uses the same path.
- `/dcp summarize` calls native `session.summarize()` for one-step semantic pruning.

Concurrent requests for the same session share one native call. A failed call is fail-open and keeps the original context; retries are cooled down for 30 seconds by default.

## Configuration

DCP loads global, custom-config-directory, then project configuration:

```jsonc
{
    "$schema": "https://raw.githubusercontent.com/LeXwDeX/opencode-dynamic-context-pruning/master/dcp.schema.json",
    "enabled": true,
    "autoUpdate": true,
    "debug": false,
    "commands": { "enabled": true },
    "experimental": { "customPrompts": false },
    "summarize": { "failureCooldownMs": 30000 },
}
```

When `experimental.customPrompts` is enabled, copy the generated
`~/.config/opencode/dcp-prompts/defaults/compaction.md` to a project, custom-config, or global `dcp-prompts/overrides/compaction.md` path.

## Migrating from the legacy 3.x pipeline

Legacy `compress`, `manualMode`, `strategies`, `turnProtection`, notification, protected-file, and command-protection settings are removed. DCP reports them as deprecated and ignores them.

The old model tools, range/message compression, `/dcp compress`, decompression/recompression/sweep commands, message markers, nudges, and plugin compression persistence are gone. Existing legacy DCP state files are neither read nor modified; remove them manually only after deciding that you will not roll back.

License: AGPL-3.0-or-later.
