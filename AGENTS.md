# AGENTS.md

## Commands

```bash
npm run typecheck          # tsc --noEmit (must pass before commit)
npm test                   # node --import tsx --test tests/*.test.ts
npm run build              # tsup (bundle) + tsc --emitDeclarationOnly
npm run format:check       # prettier --check (CI enforces this)
npm run check:package      # build + verify-package.mjs (runs on prepublishOnly)
```

Run a single test: `node --import tsx --test tests/compress-range.test.ts`

## Architecture

OpenCode plugin (`@opencode-ai/plugin`). Entry: `index.ts` → returns hook handlers + tool registration.

- **`lib/hooks.ts`** — All 5 plugin hooks: `chat.system.transform`, `chat.messages.transform`, `text.complete`, `command.execute.before`, `event`
- **`lib/compress/`** — Compress tool: `message.ts` (per-message mode), `range.ts` (range mode), `pipeline.ts` (shared prepare/finalize)
- **`lib/state/`** — Session state: `types.ts` (SessionState), `persistence.ts` (disk save/load), `state.ts` (checkSession, init), `utils.ts` (resetOnCompaction — inert, only resets toolParameters)
- **`lib/messages/`** — Message processing: `inject/` (nudge injection), `priority.ts`, `prune.ts`, `reasoning-strip.ts`, `query.ts`, `shape.ts`
- **`lib/prompts/`** — All prompts in **Chinese** (intentional — reduces XML tag hallucination with qwen models). `store.ts` loads custom overrides from disk.
- **`lib/config.ts`** — Config resolution: global `~/.config/opencode/dcp.jsonc` → project `.opencode/dcp.jsonc`
- **`lib/update.ts`** — Auto-update via npm. `PACKAGE_NAME` constant must match `package.json` name.

## Build & Package

- **ESM-only** (`"type": "module"`). tsup bundles to single `dist/index.js`. `jsonc-parser` is bundled inline (broken ESM).
- `tsc --emitDeclarationOnly` generates `.d.ts` files separately.
- `scripts/verify-package.mjs` validates: import graph has no CJS deps, tarball excludes source/tests/scripts, required files present. Runs automatically on `npm publish`.
- `.npmignore` excludes `lib/`, `index.ts`, `tests/`, `scripts/` from tarball — only `dist/`, `README.md`, `LICENSE` ship.

## Testing

- Test runner: `node:test` (not jest/vitest). Tests use `node:assert/strict`.
- **Known failure**: `tests/prompts.test.ts:53` — Bun doesn't support nested `t.test()`. This is pre-existing and unrelated to changes.
- Tests assert on **Chinese prompt text** — when changing prompts, update test regex patterns in `tests/message-priority.test.ts`, `tests/prompts.test.ts`, `tests/compress-message.test.ts`.
- `resetOnCompaction` is **inert** — tests in `tests/message-ids.test.ts` assert state is preserved after compaction.

## Formatting

Prettier: no semicolons, double quotes, 4-space indent, 100 char width, trailing commas. Run `npm run format` to auto-fix.

## Publishing

GitHub 推送和 npm 发布**都在本机完成**。本机已 `npm login` 为 `lexwdex-org`，npm 令牌在本机可用。GitHub Actions 无法直接发布到 npm（仓库未配置 `NPM_TOKEN` secret，`.github/workflows/publish.yml` 会因 `ENEEDAUTH` 失败）—— 忽略该 workflow 的失败。

```bash
npm version patch            # bumps version + creates git tag v*
git push origin master --tags  # 推送代码和标签到 GitHub
npm run build                # 本机构建 dist/
npm publish --access public  # 本机发布到 npm（已登录 lexwdex-org）
```

发布后用 `npm view @lexwdex-org/opencode-dcp@<version> version` 确认 npm 上能查到。

## Key Constraints

- `@opencode-ai/plugin` is a **peerDependency** (>=1.4.3) — don't add it to dependencies.
- `stripStaleMetadata` must **not** include `"reasoning"` type — breaks Anthropic signature preservation.
- `chat.messages.transform` handler clones messages before transforms and wraps in try/catch (fail-open). Don't remove this defensive wrapping.
- State persistence: `lastCompaction` and `messageIds` are saved to disk. Don't make them in-memory only.
