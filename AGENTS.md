# Repository Guidelines

DCP is a TypeScript ESM plugin that folds older successful OpenCode tool outputs in request copies.

## Project Structure & Module Organization

- `index.ts` registers hooks; `lib/hooks.ts` adapts requests; `lib/dtc/` implements projection and state.
- `lib/config.ts` loads configuration; `dcp.schema.json` defines its public schema.
- `tests/*.test.ts` contains unit/regression tests; `tests/host/` exercises the actual host.
- `scripts/` contains validation and inspection utilities; `assets/images/` holds documentation images. `dist/` is generated.

## Build, Test, and Development Commands

Use npm and the committed `package-lock.json`.

- `npm ci`: install locked dependencies.
- `npm run build`: generate ESM bundles and TypeScript declarations in `dist/`.
- `npm run typecheck`: check strict TypeScript types.
- `npm test`: run Node's `node:test` suite through `tsx`.
- `npm run format:check` / `npm run format`: check/apply Prettier.
- `npm run check:package`: build and verify ESM imports and packaged files.
- `npm run dev`: invoke `opencode plugin dev`; requires a supporting OpenCode CLI.

## Coding Style & Naming Conventions

Use four spaces, double quotes, no semicolons, trailing commas, and a 100-column print width. Use camelCase functions, PascalCase types/classes, and kebab-case multiword filenames. Preserve namespace imports for bundled `jsonc-parser`.

## Testing Guidelines

Name tests `tests/<area>.test.ts` and describe behavior in `test(...)`. Cover projection immutability, protected content, and request identity; no numeric coverage threshold is configured.

For host integration, set `OPENCODE_SOURCE_ROOT` to a clean, isolated checkout pinned by `scripts/test-host.mjs`. Install Bun and host dependencies following `.github/workflows/pr-checks.yml`, then run `npm run test:host`.

## Commit & Pull Request Guidelines

Follow history's `feat:`, `fix:`, `test:`, and `chore:` prefixes; use `!` for breaking changes. Example: `fix: preserve pruning with host reference markers`.

PRs should explain motivation, behavior changes, linked issues (`Closes #n`), and validation evidence. Pass formatting, type checks, tests, package verification, compatibility checks, and SpecGit acceptance before merging.

## Runtime & Configuration Constraints

Only mark eligible old outputs on request copies. Preserve stored history, identities, inputs, protected steps, and native compaction. Update runtime defaults/validation, `dcp.schema.json`, and both READMEs together for configuration changes.

## Agent Guidance

Prefer graph tools for discovery; confirm index freshness, check coverage for evidence paths, and read uncovered source. Under GPT-6/Astra, implementation subagents may default to GPT-5.6/Sol or Terra.
