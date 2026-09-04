# npm 与依赖升级记录（#52）

本次升级在前置优化交付验收后进行，版本以 **2026-09-04** 执行时查询的官方 registry `latest` dist-tag、包清单和发布记录为准。执行阶段的版本快照时间为 `2026-09-04T08:17:37Z`。直接依赖选择稳定版本，传递依赖受上游约束的例外逐项列在下文。

本文记录代码、工作流及本机工具的实际升级。Node 26.8.1、npm/npx 12.0.2、SpecGit 1.11.0 已于执行后核实；92 项单元测试、14 项隔离宿主测试和 82 个实验断言通过。安全审计、独立 review、必需 CI 和 `specgit finish` 仍是最终验收条件，本次没有发布 npm 版本。

## 版本变化

表中旧版本来自升级前的安装记录及 lock，新版本来自本次更新后的 lock。`package.json` 保留对应的兼容版本范围，精确安装结果由 `package-lock.json` 固定。

| 项目                         | 升级前           | 本次版本/处理            | 官方来源                                                           |
| ---------------------------- | ---------------- | ------------------------ | ------------------------------------------------------------------ |
| jsonc-parser                 | 3.3.1            | 3.3.1，已为最新稳定版    | [registry](https://registry.npmjs.org/jsonc-parser/3.3.1)          |
| @opencode-ai/plugin 开发依赖 | 1.4.3            | 1.18.27                  | [registry](https://registry.npmjs.org/@opencode-ai/plugin/1.18.27) |
| @types/node                  | 25.5.0           | 26.4.1                   | [registry](https://registry.npmjs.org/@types/node/26.4.1)          |
| Ajv                          | 8.20.0           | 8.20.0，已为最新稳定版   | [registry](https://registry.npmjs.org/ajv/8.20.0)                  |
| esbuild                      | 0.27.0，传递依赖 | 0.28.2，改为直接开发依赖 | [registry](https://registry.npmjs.org/esbuild/0.28.2)              |
| Prettier                     | 3.8.1            | 3.9.6                    | [registry](https://registry.npmjs.org/prettier/3.9.6)              |
| tsx                          | 4.21.0           | 4.23.13                  | [registry](https://registry.npmjs.org/tsx/4.23.13)                 |
| TypeScript                   | 6.0.2            | 7.0.2                    | [registry](https://registry.npmjs.org/typescript/7.0.2)            |
| tsup                         | 8.5.1            | 移除；直接调用 esbuild   | [原版本 registry](https://registry.npmjs.org/tsup/8.5.1)           |

`@opencode-ai/sdk` 随 plugin 从 1.4.3 更新为 1.18.27，仍是 plugin 固定配套的传递依赖。DCP 的 `@opencode-ai/plugin` peer 范围继续为 `>=1.4.3 <2`；开发依赖升级没有提高宿主最低版本，CI 仍验证 1.4.3 和 `latest`。

| 工具或环境               | 升级前                 | 本次目标/处理                                       |
| ------------------------ | ---------------------- | --------------------------------------------------- |
| 本机 Node                | Homebrew 26.8.1        | 26.8.1，已经是官方最新稳定发布                      |
| 本机全局 npm             | 11.19.0                | 12.0.2，升级后 npm/npx 均已核实                     |
| PR 主验证 Node           | 20                     | 26.8.1                                              |
| SDK/宿主测试 runner Node | 24                     | 26.8.1；实际宿主仍由固定 Bun 运行                   |
| 发布 Node                | 24                     | 26.8.1                                              |
| CI 独立审计客户端        | 临时固定 npm 11.19.1   | 显式安装并验证 npm 12.0.2                           |
| 发布 npm                 | Node 捆绑版本          | 显式安装并验证 npm 12.0.2                           |
| 发布 actions             | checkout/setup-node v6 | v7；核实时最新发布分别为 7.0.1 / 7.0.0              |
| SpecGit                  | 1.11.0                 | 保留 1.11.0，已经是最新稳定版；生成工作流边界见下文 |

版本依据：[Node 26.8.1](https://nodejs.org/en/blog/release/v26.8.1)、[npm 12.0.2](https://registry.npmjs.org/npm/12.0.2)、[checkout 7.0.1](https://github.com/actions/checkout/releases/tag/v7.0.1)、[setup-node 7.0.0](https://github.com/actions/setup-node/releases/tag/v7.0.0)、[SpecGit 1.11.0](https://registry.npmjs.org/specgit/1.11.0)。npm 12 的 Node 范围为 `^22.22.2 || ^24.15.0 || >=26.0.0`，因此主验证任务不能沿用 Node 20。

## 构建与打包适配

原 tsup 配置只有一个入口、ESM 输出、source map 和 jsonc-parser 内联，声明文件原本就由独立 `tsc --emitDeclarationOnly` 生成。本次移除这层构建封装，使用 `scripts/build.mjs` 调用 esbuild JS API，再由 TypeScript 7 CLI 生成声明。

新构建保留以下行为：ES2022 目标、Node platform、ESM、splitting、带链接的 source map、`mainFields: ["module", "main"]`、jsonc-parser bundle，以及其他生产依赖和 peer 的 external 处理。清理步骤只作用于 `dist`，发布入口仍为 `dist/index.js` 和 `dist/index.d.ts`，源码中的 namespace imports 保留。

这是对实际所需构建能力的简化，不是已经复现 tsup 在本仓库失败后的规避。TypeScript 7 不再提供旧 compiler API，但旧配置的 `dts: false` 已避开 tsup 的声明生成路径；本次没有引入 TypeScript 6 兼容别名。[TypeScript 7 发布说明](https://devblogs.microsoft.com/typescript/announcing-typescript-7-0/)、[esbuild API](https://esbuild.github.io/api/)

npm 12 将 `npm pack --json` 从数组改成以包名为键的对象。打包验证器现通过 `scripts/parse-pack-metadata.mjs` 同时接受旧版的单成员数组和新版的单包名对象，并验证包名、版本及非空文件路径。空结果、多包、身份不符或无效路径均拒绝；原有必需文件、禁止文件和运行时导入检查仍然执行。[npm 12 发布说明](https://github.com/npm/cli/releases/tag/v12.0.0)

## 安装脚本与审计

`packageManager` 固定为 `npm@12.0.2`。npm 12 默认要求声明依赖安装脚本许可，本项目的 `allowScripts` 为：

| 策略键             | 值      | 用途与边界                                                                                                |
| ------------------ | ------- | --------------------------------------------------------------------------------------------------------- |
| `esbuild@0.28.2`   | `true`  | 仅许可已锁定版本的二进制安装校验脚本；更新 esbuild 时需同步重新核对许可                                   |
| `fsevents`         | `false` | tsx 的可选 macOS 文件监听依赖；DCP 的单次构建/测试不请求 watch 模式                                       |
| `msgpackr-extract` | `false` | msgpackr 的可选本机字符串解码加速；包存在不代表执行过安装脚本，也不保证禁用脚本后不会加载随包提供的二进制 |

上述可选关系来自当前安装的 tsx 4.23.13 和 msgpackr 2.1.0 的包清单。msgpackr 官方说明将 native addon 定义为可选性能优化。macOS arm64 的构建、92 项单元测试和 14 项隔离宿主验证已通过；Linux 干净安装和 SDK 矩阵由必需 CI 验证。没有使用允许所有依赖脚本的全局逃生参数。

PR 和发布中每个使用 npm 的任务都先安装 12.0.2，再精确检查 Node/npm 版本。CLI bootstrap 使用 `--ignore-scripts --no-audit --no-fund`；项目 `npm ci` 与 SDK 目标安装使用 `--no-audit --no-fund`，避免安装时重复调用审计。PR 主验证及发布任务各自执行独立 `npm audit --audit-level=high`，并保持 `continue-on-error: false`。

必需检查名称、SDK 矩阵、`opencode-compatibility` 聚合依赖、宿主 commit `8d9972908c308da1836a004cebe27c7c23db1acc`、Bun 1.4.0、OIDC `id-token: write`、已发布版本检查和 npm trusted publishing 均保留。没有增加本地发布入口。[npm ci 文档](https://docs.npmjs.com/cli/v12/commands/npm-ci/)、[可信发布要求](https://docs.npmjs.com/trusted-publishers/)

## 上游约束与保留边界

刷新 lock 后，`npm outdated --all --json` 中有 `current` 值的差异共 10 项。下面逐项对照当前安装的直接父包清单；这些 latest 均来自同次 registry 查询，没有用 overrides 强行越过上游范围。

| 传递依赖         | 实际安装      | registry latest | 当前父包                    | 父包声明        |
| ---------------- | ------------- | --------------- | --------------------------- | --------------- |
| @ai-sdk/provider | 3.0.8         | 4.0.10          | @opencode-ai/plugin 1.18.27 | `3.0.8`         |
| effect           | 4.0.0-beta.83 | 3.22.1          | @opencode-ai/plugin 1.18.27 | `4.0.0-beta.83` |
| fast-uri         | 3.1.7         | 4.1.4           | Ajv 8.20.0                  | `^3.0.1`        |
| isexe            | 2.0.0         | 4.0.0           | which 2.0.2                 | `^2.0.0`        |
| path-key         | 3.1.1         | 4.0.0           | cross-spawn 7.0.6           | `^3.1.0`        |
| shebang-regex    | 3.0.0         | 4.0.0           | shebang-command 2.0.0       | `^3.0.0`        |
| toml             | 4.3.0         | 5.0.0           | effect 4.0.0-beta.83        | `^4.1.1`        |
| undici-types     | 8.3.0         | 8.10.1          | @types/node 26.4.1          | `~8.3.0`        |
| which            | 2.0.2         | 7.0.0           | cross-spawn 7.0.6           | `^2.0.1`        |
| zod              | 4.1.8         | 4.5.4           | @opencode-ai/plugin 1.18.27 | `4.1.8`         |

effect 是明确的预发布例外：最新稳定 plugin 固定使用 beta.83，因此不能声称整个依赖树全为稳定版。将其替换成 registry latest 3.22.1 会跨越上游选定的 API 主版本，不能当作普通升级。其他条目的最新版本也不满足表中的父包声明，需要由上游更新或经独立兼容变更解决；保留声明不免除安全审计。

无 `current` 的记录是本机未安装的可选平台包或可选 peer，例如其他平台的 esbuild/TypeScript 二进制以及 OpenTUI peers，不计入这 10 个实际安装差异。

SpecGit 1.11.0 的官方生成模板固定 Node 20.19，当前 CLI 没有对应的 Node 覆盖选项。生成的 `specgit-accept.yml` 因而保留该工具环境，没有手工改模板，也没有尝试在 Node 20 下安装不兼容的 npm 12。这是本次统一工具链的显式上游边界；项目构建、审计和发布流程均使用上述 Node 26/npm 12。`required_checks`、`automation.merge: false` 和 `automation.close_issues: false` 保留。

## 验证与回退

最终验收需保存实际 Node/npm 版本，完成以下检查；命令清单不等于已经通过：

```sh
node --version
npm --version
npm ci --no-audit --no-fund
npm run format:check
npm run typecheck
npm test
npm run check:package
npm audit --audit-level=high
npm run test:host
```

宿主测试必须设置 `OPENCODE_SOURCE_ROOT` 指向干净的固定 checkout，不能使用用户活动宿主或数据库。还需确认 SDK 1.4.3/latest 的真实 CI、打包导入、独立 review 和 SpecGit 验收；最终结果及机器升级后的版本记录由交付收尾时补充。

全局 npm 变更前已完整备份 `/opt/homebrew/lib/node_modules/npm`，归档名 `npm-before/npm-11.19.0.tar.gz`，包含 1,962 个经逐文件 SHA256 核对的文件。归档 SHA256：

```text
5da84fbb07c3d320939b2408ad808789a5799102f6d15936aca1f1f6e6d94cc1
```

同目录 `backup.json`、`source-manifest.json` 和 `RESTORE.md` 记录版本、权限、内容校验及 npm/npx 的入口链接链。备份未包含用户 `.npmrc`、凭据、缓存或其他全局包；备份前后的程序目录、链接与版本一致。随后通过官方 npm 自更新升级到 12.0.2；npm/npx 的 prefix 入口改为直接指向全局 npm 包，Node 26.8.1 与 SpecGit 1.11.0 保持不变。该备份尚未用于恢复。

需要回退时，先校验归档并解压到独立恢复目录，保留待回滚的 npm 程序和链接，再按记录恢复 npm 11.19.0。若 Homebrew Node 版本已经变化，应重新核对 Cellar 和 prefix 链路，不直接复用旧路径。恢复后检查 Node/npm 版本、global prefix/root、npm/npx realpath 及 SpecGit；不回滚无关全局包。Homebrew 后续 Node post-install 可能覆盖 npm 自更新，届时应重新验证实际版本。

仓库回退使用保留的升级前提交和 lock，通过可审查的反向提交恢复构建与依赖，再执行 `npm ci` 和验证；不能只修改 package.json 而保留不一致的 lock。已经发布的 npm 版本不原地覆盖，必要修复继续采用后续版本及仓库可信发布流程。
