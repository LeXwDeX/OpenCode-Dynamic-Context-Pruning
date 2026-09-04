# Request-scoped tool output projection

DCP v6 has one compression operation: set a native compacted marker on an eligible old successful tool output in an independent request copy. It never synthesizes a summary or removes a message/part. Loss of old output detail is explicit through the host's own placeholder.

## Module contracts

- `index.ts` loads configuration and registers the transform, compaction fidelity guard, lifecycle cleanup and optional `dcp_prune` tool. It does not register command or host configuration mutation hooks.
- `lib/request.ts` validates explicit session identity, resolves the latest ordinary user's model, and reads the configured provider catalog with a two-second abort deadline. There is no timestamp identity index or previous-model cache.
- `lib/dtc/engine.ts` exposes `projectMessages(messages, options)`. The caller supplies the current conservative input budget, policy and one-request force option. The result contains an independent messages array and statistics. No host client or mutable session state enters this module.
- `lib/hooks.ts` validates the host array, invokes the engine and commits a completed projection to the original array. The host retains that array reference, so replacing `output.messages` alone would not work. The final projection/commit segment has no asynchronous yield; diagnostics are isolated.
- `lib/dtc/state.ts` holds bounded pending controls only. A manual fold has one-request scope. The compaction guard does not consume it.
- `lib/config.ts` reads layered JSONC without creating user files. Retired options are diagnostics, not alternate behavior. `dcp.schema.json` is the public configuration schema.

## Preserved data

The only permitted difference is `state.time.compacted` on selected terminal successful tools. Message and part counts, IDs, roles, order, callIDs, tool inputs, errors, user text, assistant conclusions, reasoning signatures and attachments are unchanged.

The known candidate set is read/grep/glob and bash with explicit `metadata.exit === 0`. Unknown tool contracts cannot be opted into pruning through configuration. Skill/task results, instruction-file reads, reads that loaded dynamic instructions (`metadata.loaded`) and unsuccessful/incomplete outputs are protected. Known instruction basenames are `AGENTS.md`, `AGENTS.override.md`, `CLAUDE.md`, `CONTEXT.md`, and `SKILL.md`, matched case-insensitively after normalizing path separators. A direct instruction-file read remains protected even when `metadata.loaded` is empty.

Recent protection uses native step markers, or a whole assistant message when markers are absent. All tools in one parallel step are kept together. Both the minimum step count and minimum token count must be retained. A single huge step is protected even if this leaves the request over budget.

Estimation includes full inputs even when the corresponding output already has a compacted marker. Known compaction/subtask parts use the host's fixed rendered text; interrupted tool errors include the output carried in metadata. Unrecognized media/content yields an unknown estimate, not zero tokens. An unsatisfied budget is reported; it never permits deleting other kinds of information.

Known user reference markers (`file` with `text/plain` or `application/x-directory`, and `agent`) are omitted by the host serializer. Their expanded content is carried in separate text parts and remains fully counted. The markers themselves are preserved. Attachments retained on already-compacted successful tools do not reach the model, so they do not invalidate that cleared-output estimate. This exception does not extend to live media or unfamiliar part/role combinations.

## Host contract and its limits

The V1 transform hook currently receives an empty input object. For ordinary requests, supported hosts resolve the model from the latest ordinary user's explicit model reference before invoking the transform. DCP reads that same provider/model from the host's configured catalog. Conflicting or absent session identity, absent model references, failed catalog reads and invalid limits all retain the original request.

The conservative input budget is:

```text
min(model.limit.input ?? model.limit.context,
    model.limit.context - min(model.limit.output, outputTokenMax))
```

The output-token ceiling defaults to 32,000, honoring the host-process environment override when valid. The default `targetRatio` leaves headroom for system and tool definitions added later. This is an estimate, not the final provider-token count: later plugins may change model options, and system/tool definitions are not exposed by this hook. Native overflow handling remains necessary.

The host can act on the previous response's reported usage before invoking the next ordinary transform. Pruning is therefore not guaranteed an extra rescue pass before native compaction. In a small window, the protected recent steps plus system/tool overhead may already consume the usable capacity; preserving those steps can leave no opportunity to prune. Automatic compaction and continuation must be tested with increasing reported usage as well as deterministic projection tests. A successful continuation alone does not prove that every tool completed: assert tool status and exit code too.

Native compaction calls `experimental.session.compacting` before its messages transform. The plugin sets and consumes a session-specific skip before doing any catalog lookup or projection. The later compaction `chat.params` clears a guard left by an empty/unidentified summary history; it never supplies a budget for future chat. If compaction aborts before either call, the next identified request skips once and clears the guard. This may send extra history, but never a DCP-folded summary input.

A guard must never be evicted while projection continues. If pending-control capacity cannot retain a required compaction guard, projection fails open for the plugin instance and emits a diagnostic; reload the host instance to resume. Ordinary request execution continues. This protects summary fidelity with bounded memory.

The command hook has no supported handled/cancel result. Consequently v6 removes `/dcp` rather than throwing exceptions as successful command returns. No companion host patch or invented hook field is required.

## Verification

Fast regressions run through `projectMessages`, plugin hooks and the public plugin entry using Node's `node:test`:

```sh
npm test
npm run typecheck
npm run format:check
npm run check:package
```

They cover long single-user tasks, complete-step protection, independent read pages and repeated calls, failed and interrupted tools, unknown inputs, model switching, ambiguous identity, one-request controls, capacity and commit failures.

The real-host suite pins [OpenCode-GraphAgent](https://github.com/LeXwDeX/OpenCode-GraphAgent) at `8d9972908c308da1836a004cebe27c7c23db1acc`. The source revision is checked before execution. Prepare a separate checkout:

```sh
git clone https://github.com/LeXwDeX/OpenCode-GraphAgent.git /tmp/dcp-host
git -C /tmp/dcp-host checkout 8d9972908c308da1836a004cebe27c7c23db1acc
cd /tmp/dcp-host
bun install --frozen-lockfile --ignore-scripts --filter './packages/opencode'
cd /path/to/opencode-dynamic-context-pruning
OPENCODE_SOURCE_ROOT=/tmp/dcp-host npm run test:host
```

Node runs the tests; Bun executes the real host workers, matching the host runtime. Component contract tests use real plugin loading/dispatch, message hydration, SQLite storage, provider transforms and SDK serialization. They seed deterministic history and substitute selected service boundaries to inspect exact hook behavior; the compaction component test records processor input instead of executing a model request.

The public HTTP scenarios start the host's complete default service graph through `Server.listen` and load the built plugin directly from `opencode.json`. Only the external model HTTP/SSE endpoint is replaced. The original concurrent 100-step scenario uses fixed low reported usage and disables automatic compaction to isolate model switching, manual native summarization and history fidelity. It also reads a nested `CONTEXT.md` directly, verifies the host reports an empty `metadata.loaded`, and asserts the full instruction output reaches the model while an ordinary old read is pruned.

Additional scenarios retain the host's automatic compaction/pruning defaults and report usage proportional to outgoing request size. At 64K, both ordinary prompts and file-reference prompts must exhibit DCP pruning before the first native summary, then finish after automatic continuation. At 32K, protected recent content may leave no room for DCP; repeated native summaries must still preserve successful tool execution. The Native LLM scenario reports high usage alongside a slow shell call and requires its successful exit before compaction, then separately checks that explicit cancellation still stops a longer command. Assertions inspect actual outgoing model requests, successful tool outputs/exit codes and publicly read persisted history. This covers lifecycle behavior that direct hook tests cannot prove; simulated usage does not certify a provider's tokenizer or hard context limit.

This is a pinned host contract test, not a claim that every future host or model provider has been exercised. CI also typechecks/builds/imports against the minimum and latest V1 plugin/SDK versions. The required `opencode-compatibility` aggregate includes the real-host job; SpecGit policy is unchanged.

## Delivery and publication

The v6 changes are tracked by issues #34, #35 and #36. Historical audits describe earlier versions; they are not the current architecture contract.

Publish through the repository's trusted npm publishing workflow after the reviewed version is landed and tagged. Local package checks validate the ESM graph and tarball contents; do not duplicate a version publication from the workstation.
