# Dynamic Context Pruning

[中文](./README.md) | English

DCP folds older successful tool outputs before OpenCode serializes a model request. It operates on a request copy; the host retains ownership of stored history, tool execution, and native compaction.

## Policy

The plugin resolves the current model from explicit message identity and the host's read-only provider catalog. It never guesses a session from timestamps or reuses a previous request's context window. Missing identity, model limits, or unsupported content causes an unchanged request.

The engine preserves at least the latest four complete tool execution steps and 16,000 estimated tokens of recent steps. Both conditions apply. One user request can contain many separate steps; parallel tools in one step remain protected together.

When history exceeds 70% of the conservative input budget, eligible old successful outputs are folded oldest first until the target is reached or no safe candidates remain. A fold only sets the native `state.time.compacted` marker. The host renders `[Old tool result content cleared]`; tool inputs and call/result identities remain intact.

Eligible tools are known `read`, `grep`, `glob`, and `bash` with an explicit zero exit status. Errors, running tools, unknown tools, attachments, skill/task results, and instruction-bearing reads (including dynamically loaded instructions) remain protected. Additional tools can be protected in configuration.

User instructions, assistant text, reasoning signatures, tool inputs, errors, message/part counts, identities and ordering remain unchanged. There is no topic inference, synthetic digest, input reduction, structural merging, or deduplication. Projection is prepared independently and committed only on success.

**Folding is lossy output cleanup.** Original outputs remain in stored history. Protected steps, long inputs and system instructions may themselves exceed the budget; DCP then leaves the protection rules intact and lets the host handle native compaction.

## Controls

The model-facing `dcp_prune` tool requests one fold on the next ordinary request, subject to the same protections. It returns immediately and does not permanently change policy.

Native `/compact` keeps its own prompt and checkpoint behavior. DCP never calls summarize, writes session history, or changes host compaction defaults. Its compacting hook arms one skip for the following transform in that session.

## Installation and configuration

Add `"@lexwdex-org/opencode-dcp@^6"` to OpenCode's `plugin` array. The V1 plugin peer range is `>=1.4.3 <2`; the CI matrix checks minimum/latest V1 types and a pinned real-host contract separately. See [architecture and validation](./ARCHITECTURE.md) for limitations.

Configuration layers are global `$XDG_CONFIG_HOME/opencode/dcp.jsonc` (default `~/.config/opencode/dcp.jsonc`), `$OPENCODE_CONFIG_DIR/dcp.jsonc`, then the nearest project `.opencode/dcp.jsonc`. Each also accepts `.json`, with JSONC preferred. The plugin does not create configuration files.

```jsonc
{
    "$schema": "https://raw.githubusercontent.com/LeXwDeX/opencode-dynamic-context-pruning/master/dcp.schema.json",
    "enabled": true,
    "autoUpdate": true,
    "debug": false,
    "dtc": {
        "enabled": true,
        "protectRecentSteps": 4,
        "protectRecentTokens": 16000,
        "targetRatio": 0.7,
        "minimumSavingsTokens": 512,
        "protectedTools": [],
    },
    "tool": { "enabled": true },
}
```

`protectRecentSteps` is a positive integer; `protectRecentTokens` is nonnegative; `targetRatio` is in `(0, 1]`; `minimumSavingsTokens` is a positive integer. `protectedTools` adds protections without disabling built-in ones. Invalid JSONC rejects the entire layer; invalid fields retain previous valid values. `autoUpdate` only notifies. Debug logs contain operational metadata, not conversation dumps.

## Migrating to v6

The old engine is removed, without a legacy mode. The retired `tailTurns`, `lowWatermarkRatio`, `driftThreshold`, `toolOutputKeepChars`, `mergeRuns` and `commands.*` settings produce migration notices and are ignored.

The `/dcp fold|status` commands are removed because the V1 command hook has no supported cancellation result. Use `dcp_prune` for manual folding and debug logs for diagnostics. Manual folding now affects one request, not every future task.

DCP no longer injects `compaction.tail_turns` or `preserve_recent_tokens`. Existing user configuration is still owned by the host. Older `compress`, `summarize`, `autoPrune`, `manualMode`, `strategies`, `turnProtection`, `language` and `experimental` settings remain retired. No topic-threshold migration is performed.

Restart OpenCode after upgrading. Stored history requires no migration.

## Development

Use npm and Node's `node:test`: `npm test`, `npm run typecheck`, `npm run format:check`, and `npm run check:package`. Real-host validation uses `npm run test:host`; setup is documented in [architecture](./ARCHITECTURE.md).

License: [AGPL-3.0-or-later](./LICENSE).
