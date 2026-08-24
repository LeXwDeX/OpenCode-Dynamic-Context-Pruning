# Markerless Semantic Pruning 开发任务包

## 执行状态

- 状态：实现与本地验收完成，待 SpecGit/PR 收口
- 负责人：Claude Code 起草核心配置；Codex 在 auto 分类器连续超时后接管收口
- SpecGit 交付：`markerless-semantic-pruning`
- 分支：`refactor/4-markerless-semantic-pruning`
- Issues：#4、#5、#6、#7
- Draft PR：#8

Claude 必须在执行过程中持续更新本文件的“决策与进度”和“最终报告”。只有全部 Green 条件通过，或已写入可复现的阻塞证据，才可结束。

## 1. 目标与背景

项目当前依赖注入到正常对话中的消息标记、消息别名、压缩块、锚点和 nudge 来定位并替换历史。OpenCode 原生压缩和插件自身压缩都会改变消息视图，造成标记漂移、边界失效、重复压缩和状态清理负担。

本阶段要把系统重构成“宿主拥有的单一滚动检查点”：

1. 使用 OpenCode 原生 `session.summarize()` / 原生 compaction 生命周期产生真正的逻辑剪枝。
2. 压缩后的原生摘要检查点成为模型可见历史的第一段，后面只接未压缩的近期尾部。
3. 下一次压缩输入为“上一份检查点 + 新增尾部”，新检查点原位替换旧检查点；插件不维护压缩块图或消息边界 ID。
4. 摘要不是普通叙述总结，而是语义剪枝：去除无关聊天和其他项目内容；把多次工具试错折叠为最终成功；把重复编辑折叠为最终状态和关键决策；压缩小型已完成主题；保留目标、约束、决策、当前实现状态、未解决问题和下一步。
5. 正常对话不再存在任何 DCP 控制标记、系统提示注入、消息标签、nudge 或合成摘要消息。仅允许在原生 compaction 专用 hook 中提供语义剪枝提示词，这不属于正常对话注入。

“真正剪枝”指旧前缀不再发送给模型；不要物理删除 OpenCode 数据库中的会话历史。

## 2. 推荐架构与接口边界

优先采用最小、深模块接口：插件只配置原生 compaction 行为，不复制宿主的压缩状态机。

- 外部入口：OpenCode 自动压缩和原生手动 `/compact` / `session.summarize()`。
- 插件接缝：`experimental.session.compacting`，负责返回语义剪枝 prompt；若 SDK 类型存在兼容差异，使用局部、可测试、可解释的兼容适配，不扩大 `any`。
- 状态所有权：检查点、被剪枝范围和近期尾部均由 OpenCode 原生 compaction 管理。
- 插件状态：不持久化或跟踪 message ID、别名、block ID、anchor、placeholder 或滚动摘要内容。
- 工具面：移除旧 `compress` / `compress_range` 等自定义压缩工具与相应命令入口；不要新增一个在模型回合内部递归调用宿主 summarize 的 LLM 工具。

可参考本机 OpenCode 源码（只读，不修改）：

- `/Users/suntao/Documents/code_resource/agents_multi-orchestration/consult/opencode-dag/packages/opencode/src/session/compaction.ts`
- `/Users/suntao/Documents/code_resource/agents_multi-orchestration/consult/opencode-dag/packages/opencode/src/session/message-v2.ts`
- `/Users/suntao/Documents/code_resource/agents_multi-orchestration/consult/opencode-dag/packages/opencode/src/server/routes/instance/httpapi/handlers/session.ts`

已确认的宿主行为：原生 compaction 调用 `experimental.session.compacting`，生成摘要并保留近期尾部；消息过滤视图会返回原生 compaction 请求、摘要 assistant 和 retained tail。因此不要在插件中再实现第二套“摘要作为第一条”的替换算法。

## 3. 允许范围

可以修改、重构或删除为达成目标所需的项目源码、测试、配置、README 和 package 文件，包括：

- `index.ts`、`lib/hooks.ts`、`lib/config.ts`
- `lib/compress/**`、`lib/messages/**`、`lib/state/**`、`lib/prompts/**`
- 与旧压缩模型绑定的测试，以及新增 markerless compaction 测试
- 用户文档、配置示例、迁移说明和包导出

删除已无调用者的旧实现时，必须同时删除或迁移相应测试、配置项、持久化 schema、文档和导出；不要保留两套压缩系统。

## 4. 排除范围与安全限制

- 不修改或弱化 `spec_git/policy.yaml`、`.specgit.yaml`、`.github/workflows/specgit-accept.yml`、SpecGit managed block 或验收 checks。
- 不执行 commit、push、建/改 PR、merge、release、版本升级、tag、reset、clean 或删除用户数据；这些由 Codex 收口。
- 不使用 `--dangerously-skip-permissions`，不绕过权限，不读取或回显凭据，不向无关服务发送仓库内容。
- 不物理删除 OpenCode 会话数据库中的历史消息。
- 不引入任意区间压缩、压缩块 DAG、占位符协议或消息级寻址的替代版本。
- `@opencode-ai/plugin` 仍是 `peerDependency`（`>=1.4.3 <2`），不要移入 dependencies。
- `stripStaleMetadata` 不得包含 `reasoning` 类型；保留 Anthropic signature。
- 如果保留 `chat.messages.transform`，必须继续 clone messages、try/catch、fail-open；若功能完全不再需要，应删除该 hook，而不是保留空的复杂管线。
- 不为了通过格式检查而手工格式化 SpecGit 管理文件。可以将明确的生成文件排除规则加入 Prettier 配置，但必须说明理由且不能规避源码格式检查。

## 5. 现有证据与约束

代码图 generation：`2026-08-24T01:27:18Z`，完整索引；以下候选路径覆盖检查无记录缺口：`index.ts`、`lib/hooks.ts`、`lib/config.ts`、`lib/message-ids.ts`、`lib/messages/inject/inject.ts`、`lib/messages/prune.ts`、`lib/messages/sync.ts`、`lib/compress/message.ts`、`lib/compress/range.ts`、`lib/compress/pipeline.ts`、`lib/compress/state.ts`、`lib/state/types.ts`、`lib/state/persistence.ts`、`lib/state/utils.ts`、`lib/prompts/store.ts`，以及 `lib/compress`、`lib/messages`、`lib/state`、`tests` scopes。

关键旧链路：

- `createChatMessageTransformHandler` 依次调用 message refs、compression block sync、prune、nudge、message IDs 和 manual trigger。
- `createSystemPromptHandler` 向正常 system prompt 注入 DCP 控制提示。
- `filterCompressedRanges` 在 anchor 处注入 synthetic user summary，并跳过 active block messages。
- `injectMessageIds` 把格式化标记追加到正常消息。
- `applyCompressionState` 维护 `CompressionBlock` 图和每消息 active block IDs。
- `lib/compress/message.ts` 与 `range.ts` 暴露旧自定义压缩模式。
- Session state 当前持久化 messageIds、prune blocks、nudges 等旧模型状态。

## 6. Red 基线（2026-08-24）

现有验证结果：

- `npm test`：通过，244 tests / 244 pass。
- `npm run typecheck`：通过。
- `npm run build`：通过。
- `npm run format:check`：失败，仅命中 `.github/workflows/specgit-accept.yml`、`.specgit.yaml`、`AGENTS.md`、`spec_git/policy.yaml` 这 4 个 SpecGit 生成/管理文件。
- `specgit status --json`：exit 0，bound，issues #4–#7，PR #8，工作区基线干净。

这是“旧行为自洽但目标尚未实现”的 Red：现有测试大量断言 message IDs、压缩块、锚点、占位符和注入逻辑；目标行为没有测试。先新增/改写会失败的目标测试，再完成实现，不得只删除测试。

建议用于证明旧路径已消失的审计命令（按实际符号补充，但不要把注释/迁移文档中的说明误报为生产依赖）：

```bash
rg -n 'injectMessageIds|injectCompressNudges|CompressionBlock|messageIds|parseBlockPlaceholders|filterCompressedRanges' index.ts lib tests
```

## 7. Green 条件

全部条件必须满足：

1. 插件注册并测试 `experimental.session.compacting`，其 prompt 明确执行语义剪枝规则并保留可继续工作的状态；自动和原生手动 compaction 使用同一路径。
2. 正常 `chat.system.transform` / `chat.messages.transform` 不再注入 DCP 控制内容；如果没有其他必要职责，移除 hook；模型工具列表不再出现旧压缩工具。
3. 生产代码不再维护 message IDs、压缩块、锚点、占位符、nudge 或 synthetic summary；旧持久化状态有安全的兼容读取/忽略策略，不要求破坏性迁移。
4. 测试覆盖：compaction prompt 内容和 hook 合并语义、无正常对话注入、无旧工具注册、配置迁移/未知旧字段行为、重复压缩由宿主单检查点模型承载的边界。测试不能伪造第二套插件压缩状态机。
5. README/配置文档准确描述新模型、原生触发方式、真实逻辑剪枝、数据保留语义和破坏性配置变更；最终 `npm test`、`npm run typecheck`、`npm run build`、`npm run format:check`、`npm run check:package` 全部通过。

实现还必须符合仓库格式：Prettier，无分号、双引号、4 空格、100 字符宽、trailing comma。

## 8. 验证命令

按顺序执行并记录完整结果：

```bash
npm test
npm run typecheck
npm run build
npm run format:check
npm run check:package
git diff --check
git status --short
```

可以运行目标单测加快调试，但最终必须执行全套。不要运行 SpecGit finish、不要操作 PR。

## 9. 最终交付格式

在本文件末尾填写：

1. 实际改动：按模块列出删除、替换和新增行为。
2. 验证：逐条命令、exit code、测试数量或关键输出。
3. 新依赖或配置：来源、用途、可回滚方法；没有则写“无”。
4. 未关闭风险：尤其 SDK 版本兼容、OpenCode 原生 hook 的行为假设和迁移影响。
5. 建议 Codex 复查位置：列出最高风险文件和测试。

## 10. 决策与进度（Claude 持续更新）

- 2026-08-24：首次 Claude 会话因本机模型配置不可用而中断；已完成 5 个 Red 测试草案，但其中保留旧策略/持久化状态的假设需要按下述新边界修正。
- 2026-08-24：Codex 对照 Issues #4–#7 重新确认架构：删除整个插件压缩状态机，不保留 `chat.messages.transform`、message/tool ID 持久化、压缩块、nudge、synthetic summary 或旧 LLM tool。语义噪音剪枝完全在原生 compaction prompt 中完成。
- 2026-08-24：Codex 已写入第一版 `lib/summarize.ts`、`lib/prompts/compaction.ts`，并重写 `index.ts`、`lib/hooks.ts`、`lib/prompts/store.ts`。这些是待审查的工作起点，不是已验收结论。
- 新生产面目标：`experimental.session.compacting` + `SummarizeCoordinator` + 无消息注入的 `/dcp summarize` toast 命令 + 最小配置/更新逻辑。原生 `/compact` 和自动 compaction 共享同一 prompt hook。
- `SummarizeCoordinator` 必须验证成功、false/error、并发 single-flight、失败冷却、不同 session 隔离和重启无插件状态依赖；命令只调用 OpenCode 原生 `client.session.summarize()`，不生成第二套检查点。
- 删除旧源码、测试和配置时，不要保留无调用者的兼容实现。旧配置必须被识别为 deprecated 并给出迁移诊断；旧持久化文件由新插件完全忽略，不读取、不改写、不删除。
- 当前下一步：先运行 typecheck 与目标测试确认现有草案问题；修正测试接口；完成旧管线删除、配置/schema/README 迁移和全套 Green。

## 11. 最终报告（Claude 完成前填写）

- 状态：本地 Green。Claude 完成核心配置草稿后，`auto` 安全分类器连续两次超时并拒绝同一删除命令；按 Skill 规则停止重复尝试，由 Codex 完成剩余实现与验收。
- 实际改动：生产面缩减为 native compaction hook、`SummarizeCoordinator.summarize()`、`/dcp summarize`、单一中文 compaction prompt、最小配置和更新检查；删除旧工具、消息变换、标记/ID/块图/nudge、状态持久化、策略及其内部测试；重写 README、schema、prompt preview 和 AGENTS 架构说明。
- 验证结果：`npm test` exit 0（41/41）；`npm run typecheck` exit 0；`npm run build` exit 0；`npm run format:check` exit 0；`npm_config_cache=/tmp/opencode-dcp-npm-cache npm run check:package` exit 0（24 tarball entries）；`git diff --check` exit 0。默认 npm cache 因历史 root-owned 文件导致 EPERM，未修改全局权限。
- 新依赖或配置：无新增依赖；删除未使用的 `@anthropic-ai/tokenizer`。新增 `summarize.failureCooldownMs`，默认 30000；旧压缩配置仅报告 deprecated 并忽略。`.prettierignore` 仅排除 SpecGit 生成/托管文件。
- 未关闭风险：`/dcp summarize` 通过 command hook 抛出内部哨兵来阻止 OpenCode 把命令作为普通模型消息执行；当前宿主 API 没有 command hook 的显式 handled 返回值，需在真实 TUI 中确认 toast 后的错误呈现。单检查点和 retained tail 的最终消息序列由 OpenCode 原生实现保证，仓库单测验证委派边界而不是复制宿主状态机。
- 建议复查位置：`lib/hooks.ts` 的命令中止语义、`lib/summarize.ts` 的 SDK 返回值判断、`lib/prompts/compaction.ts` 的剪枝规则，以及 `tests/command.test.ts` / `tests/summarize.test.ts` 的宿主边界假设。
