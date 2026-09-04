# 缺陷审计与修复记录：Session 状态已按 sessionId 隔离

> **历史文档：** 本文记录 3.4.x 标记式压缩管线的缺陷与修复，测试数量和修复状态均属于该版本。
> v6 已替换文中涉及的架构；当前约束、实现与验证方式见 [ARCHITECTURE.md](./ARCHITECTURE.md)。

审计日期：2026-08-01
审计版本（修复前）：fork `61700ab` / `@lexwdex-org/opencode-dcp@3.4.8`
上游对照：`Opencode-DCP/opencode-dynamic-context-pruning@85b6f5c`
结论可信度：静态全量审阅 + 单元/构建门禁 + 7 个确定性复现脚本 + 上游/API 对照

## 执行摘要

修复后的当前版本通过 224/224 项测试、类型检查、构建、包内容校验和格式门禁；npm 依赖审计为
0 个已知漏洞；OpenCode 最低支持版 `1.4.3` 与审计时最新版 `1.18.11` 均通过类型、构建和测试验证。

> 以下 S-01～S-25 记录修复前基线。本次修复已解决 S-01～S-12、S-14～S-24；S-13
> 改为 16 路有界统计读取，但保留每 Session 状态文件以保证旧会话可恢复；S-25 通过共享内容序列化、并发器、
> Schema 测试和兼容矩阵降低风险，配置验证器的进一步模块化属于后续重构。上游 TUI 是刻意保留的产品差异。

修复前最优先的是共享状态竞态。它能把 Session A 的子代理属性写进 Session B，并可能进一步污染剪枝记录、
消息别名、统计和持久化目标。除此之外，本次确认了 9 个 P1 正确性/可靠性问题，以及一组 P2/P3
性能、兼容和工程风险。

| 级别     | 数量 | 含义                                         | 建议时限         |
| -------- | ---: | -------------------------------------------- | ---------------- |
| P0       |    1 | 多 Session 数据可能串写                      | 立即，1–2 天     |
| P1       |    9 | 可导致内容丢失、错误剪枝、功能失效或更新中断 | 本周，3–5 天     |
| P2       |   12 | 持久化、长会话、兼容与维护风险               | 下一迭代         |
| P3       |    3 | 性能或工程质量问题                           | 与相邻模块一起修 |
| 产品差异 |    1 | 上游 TUI 未合入，不自动等同于 BUG            | 产品决定         |

## 1. P0 与首批 P1：先保护数据正确性

### S-01 · P0 · 多 Session 共用一份可变状态

- 证据：`index.ts:30` 只创建一次 `SessionState`；`lib/state/state.ts:137` 切换 Session 时重置同一对象，
  初始化过程中又包含异步调用，没有锁或按 Session 分区。
- 确定性复现：让 A、B 初始化 Promise 逆序完成，结果是
  `{ sessionId: "B", isSubAgent: true }`；B 实际是主 Session，A 才是子 Session。
- 影响：剪枝集合、压缩状态、别名、统计、子代理缓存和落盘 Session 都可能交叉污染。
- 修复：使用 `Map<sessionId, SessionState>` 或请求级状态；对同一 Session 的初始化/保存加 keyed lock。

### S-02 · P1 · 外部摘要模型看不到工具输入与输出

- 证据：`lib/compress/range.ts:30` 和 `lib/compress/message.ts:17` 只提取 `text` part。
- 影响：被压缩区间里的文件内容、测试输出、命令结果不会进入外部摘要；原消息随后被替换，形成事实性数据丢失。
- 修复：复用 `lib/token-utils.ts` 的工具内容提取逻辑，明确纳入 tool input/output/error，并设置单项截断策略。

### S-03 · P1 · 两个公开 nudge 配置完全无效

- 证据：`lib/messages/inject/utils.ts:38-44` 无视配置，两个函数都固定返回 `1`。
- 复现：把 `nudgeFrequency` 与 `iterationNudgeThreshold` 都设为 `100`，返回仍为
  `{ nudge: 1, iteration: 1 }`。
- 影响：提示频率远高于用户配置，增加 token 和压缩干扰。
- 修复：读取已合并配置；为默认值、边界值和覆盖层级加测试。

### S-04 · P1 · externalModel 文档、Schema、未知键检查互相冲突

- 证据：README 记录了 `url/model/apiKey/timeout/retries`；`dcp.schema.json` 的 `compress`
  禁止额外字段却没有 `externalModel`；`VALID_CONFIG_KEYS` 只有父键，递归检查会把所有子键报成 unknown。
- 额外缺陷：运行时只校验 `url/model`。`retries: -1` 会让循环零次并 `throw undefined`；
  非法 `timeout` 也没有可靠拒绝。
- 影响：合法配置在编辑器和日志中报错，非法配置到运行时才以低可诊断性方式失败。
- 修复：从单一类型/Schema 生成三套约束，补齐数值范围与嵌套键。

### S-05 · P1 · 幻觉标签清理会修改用户原文与工具输出

- 证据：`lib/hooks.ts:129` 对全部消息调用清理；`lib/messages/utils.ts:178` 不检查角色，
  还修改 completed tool output。
- 复现：用户文本 `请保留示例 <dcp-message-id>m0001</dcp-message-id> 与结尾 m0002`
  被改成 `请保留示例  与结尾 m0002`。
- 影响：代码、文档、XML 示例或工具结果可能被静默篡改。
- 修复：仅清理已知由插件注入的 assistant 后缀；绝不重写 user/tool 原始内容。

## 2. 第二批 P1：长会话与自动行为

### S-06 · P1 · 阈值计算忽略当前用户消息

- 证据：`lib/token-utils.ts:9` 只读取最后一个 assistant 的 API token 总数。
- 复现：历史总数 100，再追加 1,000,000 字符用户消息，报告仍是
  `{ reported: 100, latestUserChars: 1000000 }`。
- 影响：大段粘贴可直接越过上下文阈值，却不触发预期 nudge。
- 修复：估算最后一个已计量 assistant 之后的所有新 part，或使用宿主提供的当前 prompt token。

### S-07 · P1 · 消息别名达到 m9999 后永久失效

- 证据：`lib/message-ids.ts:10,167` 只递增 `nextRef`；compaction 会删除旧别名，但不回绕复用。
- 复现：空映射且 `nextRef=10000` 仍抛出 capacity exceeded。
- 影响：经历大量消息和多轮原生压缩后，消息变换持续 fail-open，DCP 在该 Session 内不再工作。
- 修复：回绕查找空闲别名、使用无界标识，或在安全条件下重建映射。

### S-08 · P1 · 去重保留最新错误，删除较早成功结果

- 证据：`lib/strategies/deduplication.ts:44-90` 只按工具名和参数分组，并无状态偏好。
- 复现：`read(a)` 先成功、后同参数报错，结果成功 call ID 被加入 `state.prune.tools`。
- 影响：唯一可用结果被剪掉，错误信息反而保留。
- 修复：优先保留最新成功结果；没有成功结果时再保留最新调用。另需评估文件在两次读取间变化的语义。

### S-09 · P1 · 自动更新先删除安装目录，却没有安装新版本

- 证据：`lib/update.ts:42-68` 查到新版本后直接递归删除 wrapper，随后返回 `updated: true`；
  toast 声称已经更新。
- 影响：重启时若离线、注册表失败或宿主没有及时重装，插件可能直接缺失；提示与真实状态不一致。
- 修复：交给宿主包管理器；或下载到临时目录、校验、原子切换，成功后再提示。

### S-10 · P1 · 1000 项工具缓存会反复抖动和重新分词

- 证据：`lib/state/tool-cache.ts:12-98` 每次从最旧消息扫描；FIFO 裁剪后，下次又补回被删旧项，
  再淘汰较新项。
- 复现：1100 个工具消息时，首次缓存范围 `c100..c1099`，第二次变成含 `c200..c99`；
  两次同步在本机 Node 26 合计约 21.6 秒。
- 影响：长会话每轮重复 token 计算，缓存成员不稳定，dedup/purge/sweep 会随机缺少元数据。
- 修复：从新到旧收集稳定的最近 1000 项，并保存扫描水位或 seen set。

## 3. P2：持久化、缓存和复杂度

### S-11 · P2 · 保存失败被吞掉，调用方误以为成功

- 证据：`lib/state/persistence.ts:88` 捕获所有错误后正常 resolve；上层 `save(...).catch(...)` 永远收不到失败。
- 已证实表现：受限沙箱不能写真实状态目录时，duration 测试读回 `undefined`；改用临时
  `XDG_DATA_HOME` 后 204/204 通过。
- 修复：返回 Result 或抛出；命令/UI 只有在持久化成功后才报告成功。

### S-12 · P2 · 状态文件非原子写入，且没有会话级写锁

- 证据：`lib/state/persistence.ts` 直接 `writeFile` 到最终 JSON。
- 风险：进程终止或两个异步保存乱序时，可能产生损坏文件或旧状态覆盖新状态。
- 修复：写临时文件 + fsync/rename；按 sessionId 串行化保存并拒绝较旧版本。

### S-13 · P2 · Session 文件永久增长，stats 全量串行扫描

- 证据：每个 Session 一个 JSON，无 TTL/GC；`getAllSessionStats` 逐个读取解析。
- 影响：长期使用后磁盘持续增长，`/dcp stats` 延迟随历史 Session 数线性上升。
- 修复：设置保留期/数量上限；维护轻量索引并提供显式清理命令。

### S-14 · P2 · duration 队列没有 TTL 或容量上限

- 证据：`startsByCallId` 与 `pendingByCallId` 只在匹配事件到来时删除。
- 影响：缺失完成事件、永不加载的 Session 或宿主事件变化会造成常驻内存增长。
- 修复：时间戳 + 定期清理 + 最大容量；记录被清理计数。

### S-15 · P2 · 子代理结果缓存保存完整文本且不随 compaction 清理

- 证据：`subAgentResultCache: Map<string,string>`；`resetOnCompaction` 不清理它。
- 影响：大型子代理输出在长 Session 内常驻内存。
- 修复：按字节限制的 LRU；在对应消息消失或原生 compaction 后删除。

## 4. P2/P3：延迟、兼容和维护风险

### S-16 · P2 · 外部摘要请求串行执行

- 证据：message/range 压缩循环对每个独立计划逐个 `await generateSummaryViaExternal`。
- 影响：N 个摘要的墙钟时间接近 N 倍单请求延迟。
- 修复：使用 2–4 的有界并发，并保留原顺序组装结果。

### S-17 · P3 · 压缩范围过滤存在可避免的 O(n²)

- 证据：`lib/messages/prune.ts:159` 在循环中反复 `messages.indexOf(msg)`。
- 影响：超长历史与大量压缩锚点下增加 transform 延迟。
- 修复：一次建立 messageId/index Map。

### S-18 · P3 · 自定义 prompt 模式每个 Hook 同步读盘

- 证据：`PromptStore.reload()` 在 transform/system 路径同步读取候选覆盖文件；默认关闭。
- 影响：开启自定义 prompt 后，热路径阻塞事件循环。
- 修复：mtime 缓存或文件监听；只在变化时重载。

### S-19 · P2 · OpenCode 兼容声明大于验证能力

- 证据：peer 为 `>=1.4.3`，没有上限；`client: any` 和 Hook `as any` 掩盖接口漂移；
  测试直接调用 Hook，没有真实宿主矩阵。
- 当前边界：临时升级官方 plugin/SDK 到 `1.18.11` 后 typecheck 通过；这不证明所有真实事件顺序正确。
- 修复：最低支持版 + 当前最新版矩阵；增加真实 OpenCode smoke test；收紧关键路径类型。

### S-20 · P2 · 认证补丁访问 SDK protected 内部字段

- 证据：`lib/auth.ts` 使用 `client._client || client.client`；当前官方加载器已经注入 server auth headers。
- 影响：SDK 重构后补丁会静默失效，且 `any` 不会产生编译提示。
- 修复：验证真实认证场景后删除冗余补丁，或只使用官方公开扩展点。

## 5. P2/P3：配置、测试、流程与产品差异

### S-21 · P2 · Schema 默认值与运行时默认值不一致

- `protectedTools` 的 Schema 默认空数组，运行时却保护 task/skill/todowrite/todoread 等工具。
- `showUpdateToasts` 被列为合法键，但没有进入 PluginConfig、merge 或 Schema，属于静默无效配置。
- 修复：统一生成 Schema、默认配置和合法键集合。

### S-22 · P2 · 核心 prompt 违反仓库的中文约束

- `lib/prompts/context-limit-nudge.ts`、`iteration-nudge.ts`、`system.ts`、`turn-nudge.ts`
  使用英文；仓库明确要求中文 prompt，以降低 Qwen 的 XML 标签幻觉。
- 修复：恢复中文并更新 prompt 文本断言；先做目标模型回归对比。

### S-23 · P2 · CI 格式门禁当前失败

- `npm run format:check` 仅在 `lib/commands/manual.ts` 失败。
- 修复：运行 Prettier，并把本地 typecheck/test/build/format 四项设为提交前同一门禁。

### S-24 · P2 · 发布流程文档互相冲突

- `.github/workflows/publish.yml` 仍定义 tag 自动发布；`AGENTS.md` 明确要求本机发布并忽略该 workflow 失败。
- 影响：维护者可能重复发布，或误判 release 状态。
- 修复：只保留一个权威流程；若采用 trusted publishing，更新文档并验证权限。

### S-25 · P3 · 高复杂度配置验证与重复摘要逻辑增加回归概率

- `validateConfigTypes` 约 471 行，圈复杂度约 59、认知复杂度约 146，且缺少完整配置集成测试。
- 外部摘要提取/调用逻辑在 message 与 range 模式重复，已经产生同类遗漏。
- 修复：Schema 驱动验证；把外部摘要准备、调用、重试和结果校验下沉到共享模块。

产品差异：上游共同祖先之后的主要能力是 `/dcp` TUI 与 OpenTUI 兼容更新。本分叉没有该 TUI，
但未发现遗漏的核心服务端剪枝 BUG 修复。是否补齐应由产品定位决定。

## 质量门禁结果

| 检查                    | 结果          | 备注                               |
| ----------------------- | ------------- | ---------------------------------- |
| `npm run typecheck`     | PASS          | 锁定版与 OpenCode `1.18.11` 均通过 |
| `npm test`              | PASS，224/224 | 使用临时 `XDG_DATA_HOME`           |
| `npm run check:package` | PASS          | tarball 146 项                     |
| `npm run format:check`  | PASS          | Prettier 全量检查                  |
| `npm audit`             | PASS          | 官方 registry，0 个已知漏洞        |

真实用户目录下的单测失败不是生产 duration 逻辑已坏的证据：沙箱拒绝落盘，而保存错误被吞掉；
允许写入或隔离状态目录后测试通过。它仍暴露了 S-11 的可观察性问题和测试不够 hermetic。

## Standards

- Hard violation：核心 prompt 不是中文。
- Hard violation：发布 workflow 与仓库发布指令冲突。
- Smell：message/range 外部摘要逻辑重复。

## Spec

- P1：externalModel 只摘要 text，工具事实会丢失。
- P1：README 的 externalModel 合法配置不在 Schema/合法键集合中。
- P1：`nudgeFrequency` 与 `iterationNudgeThreshold` 被硬编码为 1。

两轴结论：Standards 发现 2 个硬违规、1 个 smell；Spec 发现 3 个 P1 偏差。

## 收口复核新增修复

1. 已初始化 Session 持续登记后续消息归属，缺少 `sessionID` 的压缩计时事件不会丢失。
2. 压缩工具先初始化 Session 再检查手动模式，首次调用不能绕过 `manualMode.enabled`。
3. 子代理结果缓存同时限制单项 50 万字符、总量 200 万字符和 64 项，避免多 Session 内存放大。
4. 外部模型运行时配置增加防御性校验；更新提示失败不再形成未处理 Promise 拒绝。

## 上游与 OpenCode API 结论

1. 当前 OpenCode V1 插件 Hook 和 legacy loader 仍保留，本项目没有已确认的“最新 V1 直接不兼容”。
2. V2 插件接口仍是 beta，官方要求插件依赖与目标 OpenCode 版本匹配；不能把 `>=1.4.3` 当作永久兼容证明。
3. 本分叉相对共同祖先约 57 个文件、+4021/-441 行，风险主要来自分叉新增状态、压缩和配置能力。
4. 上游独有提交主要是 TUI，没有发现本分叉遗漏的核心剪枝修复。

官方资料：
[V1 插件文档](https://opencode.ai/docs/plugins/)、
[当前插件类型](https://github.com/anomalyco/opencode/blob/dev/packages/plugin/src/index.ts)、
[当前插件加载器](https://github.com/anomalyco/opencode/blob/dev/packages/opencode/src/plugin/index.ts)、
[V2 插件文档](https://opencode.ai/v2/docs/build/plugins)、
[上游比较](https://github.com/Opencode-DCP/opencode-dynamic-context-pruning/compare/0657cd2fd50e9891cd69eae3787bcf280fabc2ba...85b6f5ceba144fee9e65eb28dc36cab1b960e418)。

更细的接口调查见 `docs/audit/upstream-opencode-api-research.md`。

## 审计边界

- 没有使用付费模型凭据启动真实双 Session OpenCode 端到端测试；S-01 已用确定性异步脚本复现。
- 没有执行长时间内存 profiler、模糊测试和所有模型提供商认证组合。
- “可能缺陷”按可达代码、确定性复现、复杂度和宿主合约分级；不是对未来所有输入的形式化证明。
- 本次工作同时提交审计记录、缺陷修复和回归测试；临时复现脚本未写入仓库。

修复验证：双 Session 逆序初始化、提前到达事件、工具内容摘要、配置边界、长会话缓存和持久化失败均已有回归测试。
