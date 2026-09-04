# Development utilities

`npm run check:package` builds the plugin and runs `verify-package.mjs` to verify
the ESM import graph and published file list. `npm run test:host` runs the isolated
real-host tests through `test-host.mjs`; setup is in [ARCHITECTURE.md](../ARCHITECTURE.md).

The Python utilities inspect an existing OpenCode SQLite database in read-only
mode. Pass an explicit `--db PATH` to select the database; `--help` lists filters.

| Script                      | Purpose                                  |
| --------------------------- | ---------------------------------------- |
| `opencode-find-session`     | Find session IDs by title                |
| `opencode-get-message`      | Read stored message and part payloads    |
| `opencode-token-stats`      | Show host-recorded session token usage   |
| `opencode-session-timeline` | Show host-recorded token usage over time |

These utilities read persisted host data. DCP projections are request-local, so
stored messages cannot show the current request's folded view. Use DCP debug
statistics for projection decisions. Conversation content may appear in the
inspection output; it is not captured by DCP's metadata-only logger.

The old prompt-preview command and legacy compression-impact/token-estimation
scripts have been removed with their retired engines. This directory is not
published in the npm package.
