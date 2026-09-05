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

Candidate selection first removes redundant old read/grep/glob outputs. It compares the complete serialized input and exact output, not a path or lossy hash. A reverse scan identifies later eligible visible copies, including copies inside protected recent steps. Cleared, unsuccessful, instruction-bearing and otherwise protected results cannot establish redundancy. Each selection pass preserves chronological order: redundant copies first, other eligible outputs second. The second pass can clear a last copy when the budget still requires lossy folding. Both passes keep the same savings threshold and protections, and neither runs automatically below budget. Bash and write tools are not assigned read redundancy semantics.

Estimation includes full inputs even when the corresponding output already has a compacted marker. Known compaction/subtask parts use the host's fixed rendered text; interrupted tool errors include the output carried in metadata. Unrecognized media/content yields an unknown estimate, not zero tokens. An unsatisfied budget is reported; it never permits deleting other kinds of information.

Known user reference markers (`file` with `text/plain` or `application/x-directory`, and `agent`) are omitted by the host serializer. Their expanded content is carried in separate text parts and remains fully counted. The markers themselves are preserved. Attachments retained on already-compacted successful tools do not reach the model, so they do not invalidate that cleared-output estimate. This exception does not extend to live media or unfamiliar part/role combinations.

## Design review: pruning, consolidation and noise

The review uses v6.0.2 at `6117e6f` as the baseline. Its request fidelity fixes are preserved. The defect reproduced in this delivery is selection by age alone: with a unique old result followed by three identical reads, and a budget requiring only one fold, the baseline clears the unique result. The updated engine clears the first redundant read instead; both reach the budget, but only the update retains the unique evidence. This is a deterministic content-selection improvement, not evidence of improved real-model task success.

| Design goal                                   | Current limitation                                                                                                                                                                         | Delivery and follow-up                                                                                                                                                                                                                  |
| --------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Consolidate repeated content                  | Age alone ignores exact redundancy; the last patch to a file does not necessarily contain earlier changes.                                                                                 | Fix read-output selection in #58. Keep complete inputs and call identities. [#61](https://github.com/LeXwDeX/OpenCode-Dynamic-Context-Pruning/issues/61) requires versioned, recoverable artifact snapshots before consolidating edits. |
| Remove failed attempts with no value          | A failed tool can contain the original root cause or have already changed external state; error status does not establish zero effect. Native cleared markers do not clear error payloads. | [#62](https://github.com/LeXwDeX/OpenCode-Dynamic-Context-Pruning/issues/62) defines terminal-state, side-effect and recovery evidence plus a root-cause-preserving retry summary. Error content remains intact today.                  |
| Summarize distant content, retain recent work | Complete recent tool steps are protected, but clearing distant output loses its facts. Assistant text and long inputs can still dominate the budget.                                       | Keep native compaction ownership. [#63](https://github.com/LeXwDeX/OpenCode-Dynamic-Context-Pruning/issues/63) defines traceable task state and recovery references; a placeholder is not a factual summary.                            |
| Remove or summarize irrelevant branches       | Word overlap does not prove task dependency or irrelevance; a branch may share constraints or be resumed later.                                                                            | #63 requires explicit task/branch evidence, retained shared dependencies, restoration and real-model quality evaluation before automatic branch cleanup.                                                                                |

These follow-ups are scoped design work, not implemented features. Earlier v5 issues #25, #26 and #27 used structural deletion, synthetic input fields and lexical topic inference. Those paths were replaced by v6 issue #35; the new work requires host capabilities and evidence rather than re-enabling them.

For edit consolidation, test two edits to different parts of the same file: retaining only the last patch loses the first change. For retry cleanup, test a shell command that writes a file and then fails: retaining only its final error loses a real side effect. For branch summaries, test a task switch followed by a return to the original task and a cross-branch prerequisite expressed in different vocabulary. Acceptance must include restored evidence and actual task continuation, alongside token savings, latency and error rates.

The public engine interface remains `projectMessages`; the selection policy is internal to that module. No additional runtime configuration or persistent cache is introduced. The new `redundantTools` statistic is a subset of `foldedTools` and contains no conversation text.

Execution continuity is a hard requirement for this delivery and all three follow-ups. Compression must never create a stop/compact/restart flow, pause or cancel an executing tool, or stop the original task after compression. DCP handles an already-scheduled request copy; failure returns the original flow without calling abort, waiting for idle, requesting summarize, or restarting a task. Native tool settlement and summary continuation remain host contracts, and explicit user cancellation retains its meaning. A host without demonstrated continuity is not made compatible by lowering pruning thresholds.

The selected built-in defaults remain four complete steps and 16,000 estimated recent tokens, a 0.7 history budget ratio, and 512 tokens of minimum savings per output. Redundancy priority is always enabled within this policy. These retain the previously verified protection and savings thresholds instead of introducing a new tuning surface. The configuration regression checks the runtime values against the schema and both README examples. Existing valid user settings remain explicit overrides; this delivery does not write configuration files into an active environment.

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

The redundancy regressions verify unique evidence survives a one-fold budget, full inputs and changed outputs stay independent, cleared/failed copies do not count as surviving evidence, complete recent parallel steps stay protected, and ordinary lossy folding still handles remaining pressure. A real-host component scenario hydrates five stored tool calls, invokes the loaded plugin, and serializes an Anthropic request: exactly the older redundant result is cleared, the unique and latest results reach the wire, input/result pairing is complete, and the database snapshot remains unchanged. The external model response is controlled; this proves serialization and storage fidelity, not semantic task quality.

`tests/host/redundant-continuity.mjs` separately runs 32 real tools through the public HTTP host in each of AI SDK and Native LLM modes, without overriding DTC defaults or disabling native compaction. It requires an outgoing request to clear an old duplicate while retaining unique and repeated evidence, then emits a slow shell command with high reported model usage. The native summary must observe the successful shell exit and exactly one ledger append, while the session is still busy. The loop must continue through all subsequent tools, finish normally, and only then become idle. Original stored outputs and every request's call/result pairing remain intact. Independent elapsed time measures slow-tool completion because stored host timestamps can be rewritten at settlement. The scripted endpoint controls model behavior and reported usage; this verifies the execution contract, not an arbitrary model's summary quality.

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

### Hard input limits and parallel settlement

`tests/host/hard-limit.mjs` enforces an actual HTTP input limit before emitting any model response or advancing the tool plan. Its deterministic accounting is `ceil(UTF-8 bytes of JSON({messages, tools}) / 4)`, with a 60,000-unit cap on ordinary requests, titles and summaries alike. The advertised model has a 64,000 context window and 4,000 output allowance. This exercises provider rejection and host recovery; it does not certify a production tokenizer.

The ordinary-read control completes with DCP folding and no rejection. The same workload reading protected `CONTEXT.md` files receives real HTTP 400 `context_length_exceeded` responses, enters native compaction and resumes. Both cases verify each stored tool result and a single ledger append that must not replay. A third case exceeds the cap even during summarization; it must persist `ContextOverflowError`, finish with an error and become idle. A scripted provider controls subsequent calls, so these assertions establish host execution behavior, not a real model's ability to reconstruct task intent after lossy summarization.

`tests/host/parallel-tools.mjs` emits multiple tool calls in one model response. Its scenarios cover two successes, a missing-file error alongside a nonzero shell exit and a slow success, automatic compaction after all parallel tools settle, and explicit cancellation of two running siblings after another sibling has succeeded. Assertions inspect actual running snapshots, each call's terminal status and exit code, input/result pairing, stored original output, whole-step recent protection and terminal idle state. Final host timestamps can be rewritten on settlement; observed running snapshots establish execution overlap. The pressure scenario uses Native LLM and short outputs to check full summary fidelity without confusing the host's native per-output summary truncation with DCP clearing. The other scenarios use AI SDK. Native LLM buffers results until the full batch settles, so the cancellation test does not establish preservation of early completed siblings in that mode.

### Published-host evidence

The pinned source revision above is a development contract. It differs from the [GraphAgent 1.0.39 release](https://github.com/LeXwDeX/OpenCode-GraphAgent/releases/tag/graphagent-v1.0.39), whose target is `953ca98999eb1120fe9bf99a32178ea709b4dc2d`. SDK types are a separate compatibility dimension from either runtime.

On 2026-09-04, the official `opencode-darwin-arm64.zip` was downloaded and its SHA-256 matched the release API digest and `SHA256SUMS`: `3a5b1ae23ee1c78f89976985dcc74d751123a8ebdad8af33bf4c0795c485c8e0`. The extracted executable reported `1.0.39` and had SHA-256 `841648e219e86ec9f806037311dfbc2d78fe49e67ceef67b3501eb5ffeccfcbe`. The matrix loads the current built DCP plugin with the npm development peer recorded in its report, without importing the pinned host's source modules.

| Released artifact mode | DCP      | Slow tool during automatic compaction              | Explicit cancellation |
| ---------------------- | -------- | -------------------------------------------------- | --------------------- |
| Native LLM             | enabled  | Failed: settled with null exit and an abort result | Passed                |
| Native LLM             | disabled | Failed: settled with null exit and an abort result | Passed                |
| AI SDK                 | enabled  | Passed: successful shell exit                      | Passed                |
| AI SDK                 | disabled | Passed: successful shell exit                      | Passed                |

Native LLM on this artifact is unsupported for reliable slow-tool settlement under automatic compaction. A `completed` tool status alone is insufficient: a null exit and an abort result are not success. The DCP-off control demonstrates that disabling the plugin does not resolve this observed lifecycle failure. This evidence is scoped to that artifact, platform and scenario; it neither patches the host nor establishes compatibility with other releases or providers.

Reproduce against an explicitly selected artifact whose release provenance has been checked:

```sh
npm run test:host:binary -- \
  --binary /absolute/path/to/release/opencode \
  --version 1.0.39 \
  --sha256 841648e219e86ec9f806037311dfbc2d78fe49e67ceef67b3501eb5ffeccfcbe \
  --output /absolute/path/to/disposable/evidence
```

The Node runner validates the executable identity, builds DCP, and launches four isolated Bun/binary workers with fresh configuration and databases. It records the plugin build digest, npm peer version, runtime flags, public API history, model requests and each independent check. It continues through explicit cancellation and the other modes even if slow-tool settlement fails. Any failed case makes the command exit nonzero; known failures remain failures in the JSON report. This optional release matrix complements the required pinned-source CI gate and never replaces or relaxes it.

## Delivery and publication

The v6 changes are tracked by issues #34, #35 and #36. Historical audits describe earlier versions; they are not the current architecture contract.

Publish through the repository's trusted npm publishing workflow after the reviewed version is landed and tagged. Local package checks validate the ESM graph and tarball contents; do not duplicate a version publication from the workstation.

The publish workflow requires `GITHUB_REF` to equal `refs/tags/v<package.json version>`, including manual dispatch. It runs formatting, types, tests, package verification and dependency audit before npm publication. Branch pushes only validate code; they do not publish. This delivery fixes missing publication tests and tag/version validation in #59 and prepares patch version 6.0.3; the version is not published until the matching reviewed tag is pushed.
