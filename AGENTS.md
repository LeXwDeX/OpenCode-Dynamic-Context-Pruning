# AGENTS.md

## Commands

```bash
npm run typecheck          # tsc --noEmit (must pass before commit)
npm test                   # node --import tsx --test tests/*.test.ts
npm run build              # tsup (bundle) + tsc --emitDeclarationOnly
npm run format:check       # prettier --check (CI enforces this)
npm run check:package      # build + verify-package.mjs (runs on prepublishOnly)
```

Run a single test: `node --import tsx --test tests/summarize.test.ts`

## Architecture

OpenCode plugin (`@opencode-ai/plugin`). Entry: `index.ts` returns native compaction, heuristic auto-prune, model tool, and command hooks.

- **`lib/hooks.ts`** — Applies the semantic pruning prompt during `experimental.session.compacting`, observes user messages (`chat.message`), turns events into auto-prune triggers (`session.idle`/`session.compacted`/`session.deleted`), and handles `/dcp summarize`.
- **`lib/auto-prune.ts`** — CJK-aware tokenizer + Jaccard similarity; `AutoPruner` tracks per-session signals (topic-drift, volume, idle-gap), pending triggers, and cooldowns.
- **`lib/prune-tool.ts`** — Model-invokable `dcp_prune` tool; its description carries the "use immediately on topic change" heuristic guidance.
- **`lib/session-model.ts`** — Shared latest-user-model resolution from session messages.
- **`lib/summarize.ts`** — Session-level native summarize coordinator with single-flight and failure cooldown.
- **`lib/prompts/compaction.ts`** — Chinese three-tier checkpoint prompt: 系统上下文 (preserved system-level content) → 历史概要 (early/middle history heavily compressed) → 已完成任务概括 + 进行中任务详情 (recent/current-task content lightly compressed).
- **`lib/config.ts`** — Config resolution: global `~/.config/opencode/dcp.jsonc` → project `.opencode/dcp.jsonc`
- **`lib/update.ts`** — Non-destructive npm update check. `PACKAGE_NAME` constant must match `package.json` name.

## Build & Package

- **ESM-only** (`"type": "module"`). tsup bundles to single `dist/index.js`. `jsonc-parser` is bundled inline (broken ESM).
- `tsc --emitDeclarationOnly` generates `.d.ts` files separately.
- `scripts/verify-package.mjs` validates: import graph has no CJS deps, tarball excludes source/tests/scripts, required files present. Runs automatically on `npm publish`.
- `.npmignore` excludes `lib/`, `index.ts`, `tests/`, `scripts/` from tarball — only `dist/`, `README.md`, `LICENSE` ship.

## Testing

- Test runner: `node:test` (not jest/vitest). Tests use `node:assert/strict`.
- Use the documented Node.js runner. Bun is not supported because it does not implement nested `t.test()` compatibly.
- Tests assert on **Chinese prompt text** in `tests/compaction-hook.test.ts`.
- `tests/summarize.test.ts` covers native delegation, session isolation, single-flight, failure cooldown and restart behavior.

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
- OpenCode owns the rolling checkpoint and retained tail; do not add plugin checkpoint persistence or per-message IDs.
- Do not add normal chat/system message injection, compression markers, block graphs, anchors, or placeholders.
- The `dcp_prune` tool and heuristic auto-prune are the only LLM-facing compression surfaces. Auto-prune fires only at turn boundaries (`session.idle`), never mid-turn; both must go through the `SummarizeCoordinator` single-flight/cooldown path.
- Compaction prompt failures are fail-open: native OpenCode compaction must continue with its default prompt.

<!-- specgit:block:start -->
## SpecGit 交付工具链

由 `specgit init` 托管。标记之间的内容会在每次 init 写入工具链时重新生成
（全新 init，或策略已存在时的 `--force`）；手工指引请放在标记之外。

### 交付故事

- 用 `specgit issue <标题或编号>...` 开始：它会创建或复用议题、建分支、
  开一个预填确定性骨架的草稿拉取请求（每个绑定议题一行 `Closes #n`，
  随后是 为什么 / 变更内容 / 证据 / 清单 各节），并写入 `.specgit.yaml`。
  重复执行会恢复现场；它是幂等的。
- 在交付过程中填写骨架各节。占位内容仅是建议——关闭引用是正文里唯一的
  门槛。PR 正文只在创建时写入一次；任何 SpecGit 命令都不会修改已存在的
  PR 正文，也从不读取仓库自己的 PR 模板。
- 草稿拉取请求恒使裁决失败（`pr_draft`）：在 `specgit finish` 之前，
  先把它标为可评审——GitHub 用 `gh pr ready <number>`，GitLab 用
  `glab mr update <number> --ready`。
- 用 `specgit finish` 收尾：裁决来自真实的 git、PR 与 CI 证据。退出码
  0 是唯一的"完成"。

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

- 唯一规则：交付完成当且仅当 `specgit finish` 退出 `0`。绝不凭任务
  清单、文件状态或自己跑过的测试宣布完成。
- 按退出码分支，不按措辞：`1` = 证据齐全，修门槛点名的内容；`3` =
  证据缺失，先修环境（`specgit doctor`）。绝不把退出 `3` 当作成功。
- 保持 PR 正文里的 `Closes #n` 引用完整；改动 PR 正文、头分支或 CI
  后重跑 `specgit finish`。绝不为通过验收而绕过或改配置必需检查。
- 平台证据只经由用户已认证的 CLI 会话（`gh` / `glab`）流转：绝不
  读取、记录或传递 token。
<!-- specgit:block:end -->
