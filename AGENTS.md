# AGENTS.md

DCP is an ESM OpenCode plugin that projects old successful tool outputs into a
request-local copy. Use npm. Architecture and real-host setup:
[ARCHITECTURE.md](./ARCHITECTURE.md); user configuration and migration:
[README.md](./README.md).

## Verification

- `npm run typecheck` must pass before a commit.
- `npm test` uses Node's `node:test`; Bun does not run the test suite.
- `npm run test:host` uses a Node test runner and Bun as the actual host runtime.
  Set `OPENCODE_SOURCE_ROOT` to the pinned checkout described in the architecture
  document. This test must not use the user's active host checkout or database.
- `npm run format:check` and `npm run check:package` verify formatting and the
  ESM tarball. `jsonc-parser` is bundled by tsup; preserve namespace imports.
- CI requires Type Check, Build & Audit and opencode-compatibility. The latter
  aggregates the SDK matrix and real-host integration.

## Invariants

- Compression may only add the host-native `state.time.compacted` marker to
  eligible old completed tool parts in a request copy. Messages, parts, IDs,
  order, tool-call/result pairing, inputs, errors, text and reasoning stay
  unchanged. Never fold instruction-bearing reads, skill/task results,
  unsuccessful or unfinished tools, or protected recent steps.
- Session storage, execution, summarize and native compaction prompts belong to
  the host. No session-mutating endpoints, message injection, busy/idle control,
  command-cancellation exceptions or host-config rewrites.
- Identity and model limits come from the current request's explicit fields and
  the host's read-only configured model catalog. Missing or ambiguous evidence
  means unchanged input. No timestamp/session inference or previous-model cache.
- The engine returns an independent projection; the adapter validates and
  commits synchronously to the host's original array. Diagnostic failures cannot
  affect requests. No partial projection may be published on failure.
- The native summary transform is skipped using the verified compacting hook
  order. Capacity exhaustion must preserve this guard by failing open, never
  by evicting a guard and continuing projection.
- `dcp_prune` is an instantaneous one-request mark, not a persistent severity
  mode. Runtime controls are bounded and never persisted.
- `@opencode-ai/plugin` remains a peer dependency. Runtime SDK access uses the
  host-provided client; no private SDK internals.
- A configuration change requires consistent runtime validation, defaults,
  root `dcp.schema.json` and user documentation. Retired keys are diagnostics
  only; do not resurrect old engines, summaries or compatibility guesses.

## Publication

GitHub pushes happen locally; npm publication uses
`.github/workflows/publish.yml` trusted publishing. After a reviewed version is
landed, push its `v*` tag, inspect the workflow, then verify the exact npm
version. Do not also publish the same version locally.

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
