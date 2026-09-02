# Dynamic Context Pruning for OpenCode

[![npm version](https://img.shields.io/npm/v/@lexwdex-org/opencode-dcp.svg)](https://www.npmjs.com/package/@lexwdex-org/opencode-dcp)

**English** | [中文](./README.md)

DCP manages OpenCode session context with **Dynamic Tiered Compression (DTC)**: folding happens inside every model request, before message serialization, and **never touches the session state machine** — no `session.summarize` calls, no compaction turns, no session writes. Compression is fully transparent to continuous autonomous work: an agent can run for days while the engine absorbs context pressure per request.

## How it works

The host fires `experimental.chat.messages.transform` before every model request. DCP folds the **request-scoped message copy** inside that hook (the host rebuilds the array from the database on every loop iteration, so all mutations are inherently request-scoped):

```text
┌──────────────┬──────────────┬──────────────┬────────────────┐
│ D distant    │ M middle     │ C current    │ T protected    │
│ heavy fold   │ medium fold  │ light fold   │ last 4 turns   │
│ digest lines │ first lines  │ truncate big │ never touched  │
└──────────────┴──────────────┴──────────────┴────────────────┘
        ◄── escalation deepens from the far end under budget pressure ──►
```

- **T tail zone**: the last `dtc.tailTurns` (default 4) conversation turns are **never folded**.
- **C current-task zone**: turns since the latest topic boundary (lexical drift detection); only oversized tool outputs are head+tail truncated, task details survive.
- **M middle zone**: long texts keep their first line; tool outputs get the host's native fold marker (rendered by the host as its own `[Old tool result content cleared]`); **tool arguments reduce to a target skeleton** (only filePath / command first line and friends — `oldString`/`newString`/`content` payloads are dropped); **failed attempts (error parts) fold to a short first line** — three edits on one file with two failures collapse to 1 recognizable call skeleton (`_merged: "edit×3 (2 err)"` carries the counts), with the final state owned by disk and the current-task zone; reasoning is emptied. **Off-topic deepening (#27)**: M turns topically discontinuous with the current-task zone (same Jaccard < `driftThreshold` mechanical test, judged per turn, short texts never qualify) collapse into the D-tier `[DCP·轮N]` mechanical digest, layered under the #25/#26 excision — purely mechanical, no model calls.
- **D distant zone**: whole turns collapse into one mechanical digest line (intent / actions / files touched / outcome / error count) and tool inputs are cleared — hard facts live on in the digest.
- **Validity-axis merging (#25/#26)**: same-target operation chains in the M/D zones (`edit`/`read`/`write`/`patch` …, ≤ 2 interleaved other calls, never crossing a turn) and **adjacent same-tool error chains** (e.g. consecutive bash failure storms) each merge into 1 surviving call before folding — superseded members are excised as **whole parts** (a message is never emptied) and the survivor's `input` carries `_merged` meta (`edit×3 (2 err)` for same-tool chains, `ops×3` for mixed ones; error chains append the first error's first line as `first:`); the two run kinds are mutually exclusive — an index-overlapped lower-priority run yields whole (artifact > error); D-zone digests carry **pre-merge** counts. Zero deletions in C/T.

**Dynamic budget**: below `lowWatermarkRatio` of the context window (default 50%) **nothing is folded at all** — short sessions pay zero cost. Above it, folding escalates D→M→C from the far end until the estimate fits `targetRatio` (default 70%). The window size is learned per session from the `chat.params` hook; until it is known the engine fails open (no folding). Session attribution reads `sessionID` straight off the message payload on official hosts; on fork hosts that strip message IDs into database columns, DTC falls back to a `chat.params`-recorded "user-message timestamp → session" index (content-keyed, so concurrent sessions never cross-attribute; a session's very first request has no record yet and skips folding).

**Three structural laws** (the constructive exclusion of the old versions' "lost markers" failure):

1. Messages are never added, removed, or reordered; IDs never change — tool-call/tool-result pairing cannot break; the one exception is validity-axis merging (#25) excising **whole tool parts** in the M/D zones (never emptying a message, C/T zones exempt);
2. Only string payloads are rewritten (text/output/reasoning), and tool-output folding uses the host's native `time.compacted` marker instead of a custom placeholder protocol;
3. Every mutation lives in the request-scoped copy only — session history in the database stays byte-identical.

## Trigger surfaces

- **Automatic**: there is nothing to trigger — every request decides its own fold depth from the budget. No signals, no boundaries, no queue.
- **The `dcp_prune` model tool**: returns instantly. Marks a topic boundary (the current-task zone restarts at the next turn) and raises this session's minimum fold level to M — old-task content folds from the next request onward. Never interrupts the running turn.
- **`/dcp fold`**: manual variant; raises the minimum fold level to the deepest tier.
- **`/dcp status`**: shows turns, token estimate, context window, and the manual fold level for the session.
- **The host's own compaction** (`/compact`, context-overflow fallback): **100% native behavior** — the host's anchored-summary prompt and its own previous-checkpoint rolling merge stay fully in charge; DCP replaces nothing. DCP contributes exactly two things: it raises the host's tail-protection defaults to 4 turns / 32000 tokens (`compaction.tail_turns` / `preserve_recent_tokens`; explicit user config always wins), and DTC skips the compaction input via a one-shot flag so the summarizer sees full-fidelity content.

## Install

```bash
opencode plugin @lexwdex-org/opencode-dcp@latest --global
```

## Configuration

DCP reads these layers in order; later layers override earlier ones:

1. `~/.config/opencode/dcp.jsonc` or `dcp.json`
2. `$OPENCODE_CONFIG_DIR/dcp.jsonc` or `dcp.json`
3. Project `.opencode/dcp.jsonc` or `dcp.json`

```jsonc
{
    "$schema": "https://raw.githubusercontent.com/LeXwDeX/opencode-dynamic-context-pruning/master/dcp.schema.json",
    "enabled": true,
    "autoUpdate": true,
    "debug": false,
    "commands": {
        "enabled": true,
    },
    "dtc": {
        "enabled": true,
        "tailTurns": 4,
        "lowWatermarkRatio": 0.5,
        "targetRatio": 0.7,
        "driftThreshold": 0.18,
        "toolOutputKeepChars": 4000,
        "mergeRuns": true,
    },
    "tool": {
        "enabled": true,
    },
}
```

| Key                       | Description                                                                                                                                                 |
| ------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `dtc.enabled`             | Master switch for dynamic tiered request-time compression                                                                                                   |
| `dtc.tailTurns`           | Turns at the end that are never folded (default 4)                                                                                                          |
| `dtc.lowWatermarkRatio`   | No folding below window × ratio (default 0.5)                                                                                                               |
| `dtc.targetRatio`         | Escalate folding until the estimate fits window × ratio (default 0.7)                                                                                       |
| `dtc.driftThreshold`      | Jaccard similarity below which consecutive user messages start a new current-task zone (0–1, default 0.18)                                                  |
| `dtc.toolOutputKeepChars` | Head+tail characters kept for oversized current-zone tool outputs (default 4000)                                                                            |
| `dtc.mergeRuns`           | Merge same-target operation chains and adjacent same-tool error chains in M/D into 1 surviving call (validity axis #25/#26, default on; off = pure folding) |
| `tool.enabled`            | Register the model-invokable `dcp_prune` tool (instant boundary mark, never interrupts)                                                                     |

## Migrating from 3.x / 4.0

The 3.x `summarize` and `autoPrune` config blocks are gone (DCP no longer calls native summarize and has no heuristic triggers); since 5.0 `language` and `experimental.customPrompts` are gone as well — DCP no longer replaces the host's compaction prompt, so the `dcp-prompts` override machinery retired with it. Such keys produce a migration warning and are ignored. `autoPrune.driftThreshold` migrates automatically to `dtc.driftThreshold`. Older `compress`, `manualMode`, `strategies`, `turnProtection` keys remain removed.

Behavior change: compression no longer produces a visible "checkpoint turn" and needs no at-rest boundaries or continuation machinery — context folds automatically inside each request, invisible to the session and its state machine. Semantic checkpoints are fully handed back to the host's native compaction (manual `/compact` or the overflow fallback): native prompt, native rolling merge — DCP only contributes the tail-protection defaults and full-fidelity protection of the summarizer input.

## Development

```bash
npm test
npm run typecheck
npm run build
npm run format:check
npm run check:package
```

License: AGPL-3.0-or-later.
