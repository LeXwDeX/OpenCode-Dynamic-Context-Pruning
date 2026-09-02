# AGENTS.md

## Commands

```bash
npm run typecheck          # tsc --noEmit (must pass before commit)
npm test                   # node --import tsx --test tests/*.test.ts
npm run build              # tsup (bundle) + tsc --emitDeclarationOnly
npm run format:check       # prettier --check (CI enforces this)
npm run check:package      # build + verify-package.mjs (runs on prepublishOnly)
npm run dev                # opencode plugin dev
```

Run a single test: `node --import tsx --test tests/dtc-engine.test.ts`

CI (`.github/workflows/pr-checks.yml`): format → typecheck → test → build → `npm audit --audit-level=high`, plus a compatibility matrix that typechecks and imports `dist/` against `@opencode-ai/plugin` `1.4.3` and `latest`.

## Architecture

OpenCode plugin (`@opencode-ai/plugin`). Entry: `index.ts` returns the DTC transform hooks, the checkpoint-quality compacting hook, the model tool, command, event, and config hooks.

**v4 core: Dynamic Tiered Compression (DTC).** Compression runs as request-time folding inside the host's `experimental.chat.messages.transform` hook (the host fires it before every model request and serializes the mutated array afterwards; the array is rebuilt from the database each loop iteration, so all mutations are request-scoped). DCP never calls `session.summarize`, never writes to the session, and never participates in the compaction state machine.

**Two-axis vocabulary (D4).** fold = compress content in place, the part stays; merge = N parts become 1 (validity axis, the one structural act); excise = merge's whole-part removal step; digest = a turn's mechanical summary line.

- **`lib/dtc/engine.ts`** — `transformMessages`: THE compression pipeline. Segments turns at user messages (skipping compaction-part users, same rule as the fork's `turns()`), splits the head into D (distant) / M (middle) / C (current-task) zones with the last `tailTurns` as the untouchable T zone, estimates tokens, and escalates folding D→M→C only while the estimate exceeds `targetRatio` of the learned context window (nothing folds below `lowWatermarkRatio`; unknown window → fail-open). Zone geometry: C starts at the latest topic boundary or manual mark, capped at 8 turns; M spans back to the second-latest boundary, capped at 12 turns; D is the rest (caps are code constants). D-zone turns collapse into a mechanical digest written into the turn's first user text part; tool outputs fold via the host's native `state.time.compacted` marker (host renders `[Old tool result content cleared]`); tool inputs reduce per zone (`reduceInput`: target keys + command first line in M, `{}` in D) so repeated/failed same-file operations collapse to skeletons; terminal error parts fold their error text to a short first line in M/D but are never touched in C/T; C zone only head+tail-truncates oversized tool outputs. Session attribution resolves via `info.sessionID` (official hosts) or — when fork hosts strip IDs out of payloads — via the `chat.params` correlation index, scanning user turns newest-first for a recorded `time.created`. `segmentTurns` is exported for reuse. The validity-axis merge phase (#25/#26/#28) runs once per request after zone computation and before any folding: same-target artifact runs, strictly adjacent same-tool error chains, and byte-identical duplicate calls (same tool + same stable input hash, any distance, turn boundaries allowed per D8, last occurrence survives) over the D/M tool-descriptor sequence resolve to one surviving tool part each (resolveRuns owns priority — an index-overlapped lower run drops whole), whole parts are excised per message (never-empty), D-zone digests are precomputed pre-excision so their counts stay faithful (`edit×3`), and `_merged` meta composes into M-zone survivor inputs once level ≥ 2 (terminal completed/error states only); `mergeRuns: false` short-circuits the entire phase back to the pre-merge code path. The topic-axis off-topic deepening (#27) runs outside the merge gate after zone computation: `offTopicMiddleTurns` finds M turns whose substantial user text drifts from the C-zone token union (same Jaccard/`driftThreshold` primitives, per-turn judgment, short texts never qualify), the `planOffTopicDeepening` pre-flight precomputes their digests on the pre-excision array (mirroring the D-zone loop, so an M→D slide is a pure cache hit with an identical 轮N digest), and band 2 dispatches those turns to `foldDistant` while `TransformStats.offTopicTurns` counts them — level 1 never deepens, an empty C reference or scanner failure folds the M zone classically, and `mergeRuns: false` leaves deepening fully effective.
- **`lib/dtc/digest.ts`** — Deterministic mechanical digests (`[DCP·轮N] 意图 | 动作 | 涉及 | 结果 | 错误`), the stateless topic-boundary scanner (consecutive substantial user texts, CJK-bigram Jaccard < `driftThreshold`), the #27 `offTopicMiddleTurns` scanner (M turns drifting against the fixed C-zone token union — same primitives, substantial texts only, empty reference → `[]`), `digestKey` (content-hash cache keys), and `estimateSlice` (token estimate that counts compacted-marked parts as the host's short placeholder, not the stored output).
- **`lib/dtc/merge.ts`** — Validity-axis merge layer (#23 family; pure functions; artifact runs are wired into the engine since #25, error runs since #26, duplicates since #28). Deterministic run detection over a flat tool-descriptor sequence: artifact runs (same-target operations, bounded interleave gap ≤ 2 other-target-free calls, never crossing user-turn boundaries), error runs (strictly adjacent same-tool failures), duplicate runs (identical stable input hash, turn-crossing allowed), priority resolution (artifact > error > duplicate; any index overlap drops the whole lower run), `_merged` meta composition (`edit×3 (2 err)`; error chains append the first error's line, root cause), and the never-empty excision helper. The engine owns descriptor construction and applies the resolved drop set.
- **`lib/dtc/state.ts`** — `DtcState`: per-session in-memory runtime state, all LRU-bounded (500 sessions / 2000 digests / 200 params-index entries), never persisted. Holds learned context-window sizes (from `chat.params`), manual boundary marks + minimum fold level (from `dcp_prune` / `/dcp fold`), the digest cache, the one-shot compaction skip flag, and the fork-compatibility correlation index (user-message `time.created` → sessionID, fed by `chat.params` — fork hosts strip id/sessionID out of message payloads, so the transform resolves session attribution through this index when the official-shape `info.sessionID` scan finds nothing).
- **`lib/dtc/types.ts`** — Loose duck-typed message/part shapes; the engine deliberately avoids importing host schemas so it survives host-version drift.
- **`lib/text.ts`** — Shared deterministic text utilities: CJK-bigram `tokenize`, `jaccard`, `estimateTokens` (CJK×0.7 + other/4), `hashString` (djb2), `firstLine`, `truncateMiddle`, `extractTextParts`.
- **`lib/hooks.ts`** — Hook factories: the transform handler (fail-open wrapper around the engine), the `chat.params` handler (learns `model.limit.context` per session **and records the sessionID↔user-message-time correlation** that fork-shape payloads need for session attribution), the compacting handler (**arms the one-shot DTC skip and nothing else** — the host's native anchored-summary prompt and its own previous-summary rolling merge stay fully in charge of `/compact` and the overflow fallback; DCP never replaces the compaction prompt), the slim event handler (`session.deleted` → drop state), the `/dcp fold|status` command handler, and the `config` hook (registers `/dcp` when enabled; always raises host `compaction.tail_turns`/`preserve_recent_tokens` to 4/32000 defaults without overriding explicit user config — this shapes the host's own overflow-compaction fallback).
- **`lib/prune-tool.ts`** — Model-invokable `dcp_prune`: instantly marks a topic boundary and raises the session's minimum fold level to M (2). Zero I/O, never interrupts, no queueing or busy semantics exist anymore.
- **`lib/session-events.ts`** — `eventSessionID` extraction (`properties.sessionID` or `properties.info.id`).
- **`lib/config.ts`** — Config resolution: global `~/.config/opencode/dcp.jsonc` → `$OPENCODE_CONFIG_DIR` → project `.opencode/dcp.jsonc` (`.jsonc` or `.json`, layered merge). The `dtc` block mirrors the engine's `DtcConfig` plus `enabled`. Legacy `summarize.*`, `autoPrune.*`, `language`, and `experimental.*` keys are deprecated-but-recognized (the compaction-prompt override machinery is retired — native compaction owns its prompt); `autoPrune.driftThreshold` migrates to `dtc.driftThreshold`. Adding a config key means updating `VALID_CONFIG_KEYS`, defaults, merge functions, and `validateConfigTypes` here **and** the root `dcp.schema.json` (its `$id` is referenced by generated user configs).
- **`lib/opencode-client.ts`** / **`lib/logger.ts`** — Thin typed SDK client wrapper and debug-gated logger used by all handlers.
- **`lib/update.ts`** — Non-destructive npm update check. `PACKAGE_NAME` constant must match `package.json` name.

## Build & Package

- **ESM-only** (`"type": "module"`). tsup bundles to single `dist/index.js`. `jsonc-parser` is bundled inline (broken ESM).
- `tsc --emitDeclarationOnly` generates `.d.ts` files separately.
- `scripts/verify-package.mjs` validates: import graph has no CJS deps, tarball excludes source/tests/scripts, required files present. Runs automatically on `npm publish`.
- `package.json` `files` whitelist ships only `dist/`, `README.md`, `LICENSE`; `scripts/` also holds debug utilities (`opencode-session-timeline`, token stats) that are dev-only and never published.

## Testing

- Test runner: `node:test` (not jest/vitest). Tests use `node:assert/strict`.
- Use the documented Node.js runner. Bun is not supported because it does not implement nested `t.test()` compatibly.
- `tests/compacting-hook.test.ts` pins the compacting hook's ONLY two guarantees: the one-shot DTC skip is armed, and `output.prompt`/`output.context` are never touched (native compaction stays in charge).
- `tests/dtc-engine.test.ts` pins the engine invariants: T-zone never touched at any level, structural invariant under the #25 rule (message count/IDs/roles/order byte-identical; parts shrink only by whole tool-part excision in D/M; no message ever emptied; run-free sessions stay byte-identical), fail-open paths (short session / unknown window / compaction skip), digest shape + host-native `time.compacted` marker, escalation stops at target, manual boundary marks deepen folding below the watermark (including non-empty distant-zone geometry for minLevel 2/3 — a start-level jump must never skip a band), fork-shape payloads (no id/sessionID in info) fold via chat.params correlation and fail open untouched on a session's first request, malformed-message tolerance, and a 1000-message latency bound.
- `tests/dtc-engine-merge.test.ts` pins the #25/#26 engine wiring of the validity axis: M/D same-target artifact runs excise to one surviving tool part with `_merged` meta (`edit×3 (2 err)`, mixed-tool `ops×3`), runs spanning messages within one turn, the never-empty fallback, the C/T zero-deletion red line (cross-turn D6 + in-C chains, error chains included), the `mergeRuns: false` twin pinning the pre-merge 3-skeleton behavior (artifact and error variants), malformed-part tolerance, run-scenario structural invariants, pre-excision digest counts + cache-key stability across requests, escalation stopping early thanks to merge savings, level-1 excision-without-meta semantics, and the #26 error-run wiring (M/D `bash×4 (4 err), first: …` chain merge, artifact-priority mutual exclusion, single-error no-merge, D-zone error chains riding the pre-excision digest meta-free), and the #28 duplicate-run wiring (cross-turn byte-identical dedup to the LAST occurrence with `_merged grep×2`, artifact/error mutual exclusion over adjacent identical calls, partnerless single occurrences untouched, the C/T byte-identity red line, the `mergeRuns: false` twin, and D-zone survivors meta-free with faithful pre-excision digest counts).
- `tests/dtc-merge.test.ts` pins the #23 grilling contract (D1–D8): per-target artifact runs with bounded interleave + turn boundary, error-run adjacency, cross-turn duplicates, priority exclusivity (artifact > error > duplicate), `_merged` meta shapes, never-empty excision, stable-hash determinism, and the `dtc.mergeRuns` config surface.
- `tests/dtc-engine-offtopic.test.ts` pins the #27 topic axis: off-topic M runs deepen to the faithful pre-excision `[DCP·轮N]` digest (with the `_merged` survivor riding on top), on-topic M neighbors keep the classic skeleton, short/missing user texts never deepen, the C/T byte-identity red line with a run adjacent to C, digest cache-key stability across the M→D slide, `mergeRuns: false` leaving deepening fully effective, manual-mark geometry plus the empty-C-reference fallback, level-1 no-op, malformed-part tolerance, and the scanner contract (empty reference → `[]`, short texts skipped, indices bounded to `[mStart, cStart)`).
- `tests/dtc-state.test.ts` pins LRU bounds, one-shot compaction skip, monotonic minimum fold level, and digest cache behavior.
- `tests/plugin-surface.test.ts` pins the exported hook surface of `index.ts` (which hooks fire under which config flags), the config-hook host defaults (`compaction.tail_turns=4`, `preserve_recent_tokens=32000`, never overriding explicit user values), and the no-summarize-surface invariant (the fake client has no `summarize` method at all).
- `tests/config-migration.test.ts` covers legacy `compress.*` / `summarize.*` / `autoPrune.*` / `language` / `experimental.*` keys: recognized (migration hint) but ignored — never re-implement them; `autoPrune.driftThreshold` migrates to `dtc.driftThreshold`.
- `tests/command.test.ts` / `tests/prune-tool.test.ts` pin the `/dcp fold|status` toasts + handler sentinels and the tool's instant, client-free execution.

## Formatting

Prettier: no semicolons, double quotes, 4-space indent, 100 char width, trailing commas. Run `npm run format` to auto-fix.

## Publishing

GitHub 推送在本机完成。npm 发布由 `.github/workflows/publish.yml` 使用 npm trusted publishing 完成；不要同时从本机重复发布同一版本。

```bash
npm version patch            # bumps version + creates git tag v*
git push origin master --tags  # 推送代码和标签到 GitHub
```

推送标签后检查 Publish workflow；完成后用 `npm view @lexwdex-org/opencode-dcp@<version> version` 确认版本。

## Key Constraints

- `@opencode-ai/plugin` is a **peerDependency** (`>=1.4.3 <2`) — don't add it to dependencies.
- **Never touch the session state machine.** DCP must not call `session.summarize` or any session-mutating endpoint, must not create messages/parts, and must not depend on busy/idle gating — compression lives entirely in the request-scoped `experimental.chat.messages.transform` hook. The host's own compaction (manual `/compact`, overflow fallback) is the only checkpoint writer **and the only checkpoint prompt author** — DCP supplies no compaction prompt; its sole compaction-adjacent acts are the tail-protection config defaults and the one-shot DTC skip that keeps the summarizer input unfolded.
- **Never break structure.** The transform may only rewrite string payloads (`text`, `state.output`, `state.error`, reasoning), set the host-native `state.time.compacted` marker / clear or reduce `state.input`, and — since #25 — excise **whole tool parts** in the D/M zones via validity-axis merging (never-empty per message; C/T zones exempt). Messages are never added, removed, reordered, or re-IDed; surviving parts keep their IDs, types, and relative order — tool-call↔tool-result pairing must be structurally unbreakable (merge removes the call+result pair as one whole part). No custom placeholders, anchors, block graphs, or persisted markers; no plugin checkpoint persistence or per-message IDs; no normal chat/system message injection.
- **Request-scoped only.** All folding lives in the per-request message copy; the database copy of the session must stay byte-identical. In-memory caches (digests, learned context limits, boundary marks) are LRU-bounded and never persisted.
- **Fail open everywhere.** Unknown context window → no folding; engine errors → the request proceeds unfolded; the host's compaction input is skipped via the one-shot flag so summarizer fidelity is never reduced.
- The `dcp_prune` tool and `/dcp fold` are the only user/model-facing compression controls; both are instantaneous state marks (boundary + minimum fold level), never operations with queueing, cooldowns, or busy semantics.

<!-- specgit:block:start -->
## SpecGit 交付工具链

由 `specgit init` 托管。标记之间的内容会在每次 init 写入工具链时重新生成
（全新 init，或策略已存在时的 `--force`）；手工指引请放在标记之外。

### 交付故事

- 用 `specgit issue <标题或编号>...` 开始：它会创建或复用议题、建分支、
  开一个预填确定性骨架的草稿拉取请求（每个绑定议题一行 `Closes #n`，
  随后是 为什么 / 变更内容 / 证据 / 清单 各节），并写入 `.specgit.yaml`。
  重复执行会恢复现场；它是幂等的。
- 议题正文在引导时从对话中填写：`specgit issue` 成功后立即用
  `gh issue edit <n>` 把讨论出的 为什么 / 范围 / 做法 / 验收 写进它
  创建的每条议题，然后再开始实现。PR 骨架的占位内容仅是建议——随交付
  过程填写即可；关闭引用是正文里唯一的门槛。PR 正文只在创建时写入一次；
  任何 SpecGit 命令都不会修改已存在的 PR 正文，也从不读取仓库自己的
  PR 模板。
- 草稿拉取请求恒使裁决失败（`pr_draft`）：在 `specgit finish` 之前，
  先把它标为可评审——GitHub 用 `gh pr ready <number>`，GitLab 用
  `glab mr update <number> --ready`。
- 用 `specgit finish` 收尾：裁决来自真实的 git、PR 与 CI 证据。退出码
  0 是唯一的"完成"。

### 议题标签

- 每次引导都会自动应用标题的 `kind::<type>` 成员；显式传入
  `--tags <a,b>` 可自选完整集合。
- 选择以池为先：仓库中符合语法的既有标签原样胜出；缺失的名称从内置的
  `kind::` 目录或策略的 `tags:` 声明中播种。未知词汇以退出码 2 指名
  全集。
- 克制选择：每轴至多一个标签，拿不准就不选——池外标签会被报告
  （`tag_pool_dirty` 警告是给人看的），SpecGit 绝不重命名它们。

### 修复与诊断

- `specgit pr` 修复拉取请求绑定：不带参数时按当前头分支自动发现拉取
  请求，找不到时报错并给出修复办法，找到多个时列出并拒绝。
- `specgit status` 只展示本地证据：记录、状态、漂移、origin。
  `specgit doctor` 探测 git、仓库、origin、gh 与策略。
- 诊断信息（diagnostic 的 message/fix）与诊断 `code` 恒为英文——这是
  机器契约的一部分，任何语言配置都不本地化它们；按 `code` 与 `fix`
  行动，不要依赖语言一致性。

### 命令面

- 十个命令：`specgit init`、`specgit setup`、`specgit issue`、
  `specgit pr`、`specgit finish`、`specgit bind`、`specgit unbind`、
  `specgit status`、`specgit accept`、`specgit doctor`。
- `specgit setup` 安装代理入口（opencode 的命令、其他工具的可移植
  skill）；`specgit bind`、`specgit unbind`、`specgit accept` 是面向
  脚本与 CI 的自动化别名。

### 建议题之前，先查重

- 用新标题运行 `specgit issue` 之前，先在 tracker 里搜索相近的在办
  工作：用标题关键词做 `gh issue list`（状态、标签、检索词用
  `gh search issues`）。
- 打开并阅读每一个疑似候选（`gh issue view <n>`）——比较 WHY 本身，
  而不是措辞。
- 若某个候选覆盖了同一个 WHY，继续那个议题而不是新建；若相近但不同，
  说明差别在哪里。
- 拿不准时，请提出请求的人决定是继续已有议题还是接受重复。一个团队
  一个 WHY 只走一条工作线，绝不两条。

### 议题粒度

一个议题 = 一个可独立验证的 WHY。若一个交付物无法凭自身证据验证，
先拆分再绑定。

### 铁律

- `specgit finish` 退出码非 0：绝不请求合并。修交付，不修门槛。
- 绝不为了通过裁决而削弱 `spec_git/policy.yaml`。
- `--json` 是唯一的解析面：stdout 恰好是一个 JSON 文档；绝不抓取
  人读输出。

### 代理契约要点

- **SpecGit 是这里的默认工作方式。** 任何非平凡的任务——新功能、修复、
  重构、文档变更——都是一次交付：工作项作为议题存放在这个 tracker
  里，绝不放进私人任务清单或对话式清单。触发点是“决定开工”的那一刻：
  对话收敛、开始把计划变成变更之时，第一个动作就是
  `specgit issue <type>: <标题>...`——先于任何文件编辑。无绑定就动手
  是违反契约，不是风格偏好。引导完成后，立即用 `gh issue edit` 把
  讨论中的 为什么 / 范围 / 做法 / 验收 填进每条议题正文，然后再开始
  实现。会话中途的盘点（“让我列出所有要做的事”）也应变成议题，而不是
  聊天产物。平凡的回复与只读提问无需如此。
- 唯一规则：交付完成当且仅当 `specgit finish` 退出 `0`。绝不凭任务
  清单、文件状态或自己跑过的测试宣布完成。
- 按退出码分支，不按措辞：`1` = 证据齐全，修门槛点名的内容；`3` =
  证据缺失，先修环境（`specgit doctor`）。绝不把退出 `3` 当作成功。
- 保持 PR 正文里的 `Closes #n` 引用完整；改动 PR 正文、头分支或 CI
  后重跑 `specgit finish`。绝不为通过验收而绕过或改配置必需检查。
- 平台证据只经由用户已认证的 CLI 会话（`gh` / `glab`）流转：绝不
  读取、记录或传递 token。
<!-- specgit:block:end -->
