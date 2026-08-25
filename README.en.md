# Dynamic Context Pruning for OpenCode

[![npm version](https://img.shields.io/npm/v/@lexwdex-org/opencode-dcp.svg)](https://www.npmjs.com/package/@lexwdex-org/opencode-dcp)

**English** | [中文](./README.md)

DCP supplies a semantic-pruning policy and proactive triggers to OpenCode's native compaction lifecycle. It does not own message markers, message IDs, compression blocks, anchors, or placeholders.

## How it works

OpenCode owns one rolling checkpoint. After compaction, the model sees only:

```text
latest pruned checkpoint + uncompacted recent tail
```

During `experimental.session.compacting`, DCP asks the summarizer to organize the checkpoint into a fixed three-tier structure:

- `## 系统上下文` (System context) — system-level rules such as AGENTS.md, carried forward verbatim from the previous checkpoint;
- `## 历史概要` (History digest) — early and middle history heavily compressed: one-line outcomes only, no process;
- Recent tasks — lightly compressed: completed tasks summarized in one line each; in-progress tasks keep full detail (goal, finished steps, file paths, key decisions, blockers, next actions). Details related to the current task are preserved first so work can continue from the checkpoint alone.

Unrelated chat, other-project context, tool retries, and repeated edits are folded away as before.

## Trigger compaction

- **OpenCode automatic compaction** uses the policy automatically.
- **The `dcp_prune` model tool** — DCP registers an LLM-invokable tool whose description carries heuristic guidance: call it immediately when the topic clearly changes, when a task wraps up, or when the context has grown noticeably.
- **Heuristic auto-prune** (`autoPrune`) — observes incoming user messages and triggers native compaction at turn boundaries (`session.idle`) on:
    - topic drift: lexical similarity between the newest message and recent history drops sharply (CJK bigrams + Jaccard);
    - message volume since the last prune crossing a threshold;
    - resuming after a long idle gap.
      Auto-triggers respect a cooldown; native `/compact` or host compaction also resets the counters.
- OpenCode's native `/compact` command uses the same path.
- `/dcp summarize` calls native `session.summarize()` manually.

All entries share one coordinator: concurrent requests for the same session share a single native call. A failed call is fail-open and keeps the original context; retries are cooled down for 30 seconds by default.

Pruned prefixes stop being sent to the model, but the original session history is not physically deleted from OpenCode's database. A later compaction replaces the previous checkpoint with one merged checkpoint instead of nesting summaries or building a compression-block graph.

## Install

```bash
opencode plugin @lexwdex-org/opencode-dcp@latest --global
```

## Configuration

DCP loads global, custom-config-directory, then project configuration:

```jsonc
{
    "$schema": "https://raw.githubusercontent.com/LeXwDeX/opencode-dynamic-context-pruning/master/dcp.schema.json",
    "enabled": true,
    "autoUpdate": true,
    "debug": false,
    "language": "zh",
    "commands": { "enabled": true },
    "experimental": { "customPrompts": false },
    "summarize": { "failureCooldownMs": 30000 },
    "tool": { "enabled": true },
    "autoPrune": {
        "enabled": true,
        "minMessages": 8,
        "volumeThreshold": 30,
        "driftThreshold": 0.18,
        "idleGapMs": 1800000,
        "cooldownMs": 300000,
    },
}
```

| Key                         | Meaning                                                                                       |
| --------------------------- | --------------------------------------------------------------------------------------------- |
| `language`                  | Language of the bundled compaction prompt: `zh` (default) / `en`; custom overrides always win |
| `tool.enabled`              | Register the model-invokable `dcp_prune` tool with heuristic usage guidance                   |
| `autoPrune.enabled`         | Enable plugin-side heuristic auto-compaction                                                  |
| `autoPrune.minMessages`     | Minimum user messages before any auto-prune signal is considered                              |
| `autoPrune.volumeThreshold` | User messages since the last prune that trigger compaction by volume                          |
| `autoPrune.driftThreshold`  | Jaccard similarity below which consecutive messages count as a topic change (0–1)             |
| `autoPrune.idleGapMs`       | Gap between user messages that counts as resuming after a long break                          |
| `autoPrune.cooldownMs`      | Minimum interval between two automatic prunes of the same session                             |

When `experimental.customPrompts` is enabled, copy the generated
`~/.config/opencode/dcp-prompts/defaults/compaction.md` to a project, custom-config, or global `dcp-prompts/overrides/compaction.md` path.

## Migrating from the legacy 3.x pipeline

Legacy `compress`, `manualMode`, `strategies`, `turnProtection`, notification, protected-file, and command-protection settings are removed. DCP reports them as deprecated and ignores them.

The old model tools, range/message compression, `/dcp compress`, decompression/recompression/sweep commands, message markers, and plugin compression persistence are gone. Existing legacy DCP state files are neither read nor modified; remove them manually only after deciding that you will not roll back.

License: AGPL-3.0-or-later.
