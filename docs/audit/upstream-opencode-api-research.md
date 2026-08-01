# 上游差异与 OpenCode 插件接口审计

审计日期：2026-08-01

审计对象：本仓库 `61700ab`（npm `3.4.8`）

对照对象：上游 `Opencode-DCP/opencode-dynamic-context-pruning@85b6f5c`（npm `3.1.14`）、OpenCode 当前 V1 插件/SDK 与 V2 迁移文档

> 本文保留修复前的接口调查证据；对应缺陷的修复状态与最终门禁结果见仓库根目录
> `DEFECT_AUDIT.md`。

## 结论

当前版本**没有因为 OpenCode 最新 V1 接口而直接失效**：把临时副本中的
`@opencode-ai/plugin` 和 `@opencode-ai/sdk` 升到 npm 当前 `1.18.11` 后，
`npm run typecheck` 通过；本项目使用的 5 个 Hook 仍存在于官方 V1 类型中，OpenCode
当前加载器也明确保留 V1/legacy 插件加载路径。

但“能够编译”不能证明可靠兼容。审计确认了 1 个测试隔离问题，并发现 4 个值得优先处理的接口/并发风险：

| 优先级 | 类型 | 结论 | 状态 |
|---|---|---|---|
| P2 | 测试/持久化 | duration 测试写入真实用户数据目录；沙箱拒绝写入时错误又被吞掉 | 已复现，隔离目录后通过 |
| P0 | 架构 | 一个插件实例共享一个可变 `SessionState`，多 Session 交错时会互相重置 | 确定性并发脚本已复现 |
| P1 | 兼容性 | peer 声明 `>=1.4.3`，实际只锁定/日常测试 `1.4.3`，没有上限或版本矩阵 | 已确认 |
| P1 | 兼容性 | `client: any`、Hook `as any` 让类型检查无法覆盖多数 SDK 调用 | 已确认 |
| P1 | 兼容性 | 认证逻辑访问 SDK 的 protected `_client`；当前宿主已主动注入认证头 | 已确认 |
| P2 | 产品差异 | 上游新增 `/dcp` TUI 面板及 OpenTUI 兼容更新，本分叉未合入 | 是否为缺陷取决于产品意图 |

## 1. 已确认：当前 V1 接口仍可工作

本项目入口仍是 V1 插件函数，并注册 `event`、`command.execute.before` 以及 3 个
`experimental.*` Hook。[本项目入口代码](https://github.com/LeXwDeX/OpenCode-Dynamic-Context-Pruning/blob/61700ab4a19169c608028e7e4d2698fb323af7d6/index.ts)
与[官方当前 V1 Hook 类型](https://github.com/anomalyco/opencode/blob/dev/packages/plugin/src/index.ts)
一致。官方当前加载器还显式执行 `readV1Plugin` 和 legacy export 兼容分支，说明 V1 并未被当前
OpenCode 移除。[官方插件加载器](https://github.com/anomalyco/opencode/blob/dev/packages/opencode/src/plugin/index.ts)

临时副本验证结果：

```text
@opencode-ai/plugin: 1.4.3 -> 1.18.11
@opencode-ai/sdk:    1.4.3 -> 1.18.11
npm run typecheck:   PASS
npm test:            204 PASS / 0 FAIL（隔离 XDG_DATA_HOME）
```

npm `latest` 的 `1.18.11` 来自官方注册表元数据：
[plugin](https://registry.npmjs.org/%40opencode-ai%2Fplugin/latest)、
[sdk](https://registry.npmjs.org/%40opencode-ai%2Fsdk/latest)。

限制：这次验证没有启动真实的 OpenCode `1.18.x` 宿主。因此它证明“当前类型仍接受、单元测试大体可运行”，
不等于证明真实宿主中的 Hook 顺序、Session 并发、认证和持久化全部正确。

## 2. P2 测试隔离问题：duration 测试写入真实用户目录

以下测试在受限沙箱内稳定失败：

```bash
node --import tsx --test \
  --test-name-pattern='event hook queues duration updates until the matching session is loaded' \
  tests/hooks-permission.test.ts
```

失败点：[tests/hooks-permission.test.ts:574](https://github.com/LeXwDeX/OpenCode-Dynamic-Context-Pruning/blob/61700ab4a19169c608028e7e4d2698fb323af7d6/tests/hooks-permission.test.ts#L574)

```text
expected: 250
actual:   undefined
```

红线诊断得到的边界是：同一测试在允许写入真实用户目录时通过；把 `XDG_DATA_HOME` 指向临时目录后，
完整测试套件也以 `204/204` 通过。原因是测试使用了真实的 OpenCode 数据目录，而
`saveSessionState()` 会吞掉写入失败，导致重新加载时读不到 duration。

因此这不是已确认的生产 duration 逻辑 BUG，而是两个可靠性问题：测试不具备文件系统隔离；持久化失败对调用方
不可见。测试应注入临时状态目录，持久化 API 应返回可观察的失败结果。

## 3. P0 风险：插件实例共享一个可变 Session 状态

[入口](https://github.com/LeXwDeX/OpenCode-Dynamic-Context-Pruning/blob/61700ab4a19169c608028e7e4d2698fb323af7d6/index.ts)
只创建一次 `createSessionState()`，随后所有 Hook 共用它；
[SessionState 定义](https://github.com/LeXwDeX/OpenCode-Dynamic-Context-Pruning/blob/61700ab4a19169c608028e7e4d2698fb323af7d6/lib/state/types.ts)
只有一个标量 `sessionId`，不是按 Session 分区的 Map；
[checkSession/初始化逻辑](https://github.com/LeXwDeX/OpenCode-Dynamic-Context-Pruning/blob/61700ab4a19169c608028e7e4d2698fb323af7d6/lib/state/state.ts)
发现 Session 改变时会重置这份共享状态。

官方插件加载器按 workspace/instance 创建并缓存 Hook 集合，而不是每个聊天 Session 创建一套插件实例。
[官方加载器实现](https://github.com/anomalyco/opencode/blob/dev/packages/opencode/src/plugin/index.ts)
因此同一工作区的两个 Session 若交错触发 Hook，存在以下路径：

```text
Session A Hook 开始 -> state.sessionId = A
Session B Hook 进入 -> reset -> state.sessionId = B
Session A 异步恢复 -> 读取或持久化 B 的共享状态
```

确定性并发脚本让 Session A、B 的初始化 Promise 逆序完成，得到：

```text
{ sessionId: "B", isSubAgent: true }
```

B 实际是主 Session，A 才是子 Session。这证明共享状态会把 A 的元数据写到 B；尚未完成的只是“真实宿主端到端”复现。
修复方向应是 `Map<sessionId, SessionState>` 或无共享可变状态的请求级上下文，而不是继续扩大事件排队补丁。

## 4. P1 风险：兼容范围远大于实际验证范围

[package.json](https://github.com/LeXwDeX/OpenCode-Dynamic-Context-Pruning/blob/61700ab4a19169c608028e7e4d2698fb323af7d6/package.json)
把 `@opencode-ai/plugin` 声明为 `>=1.4.3` peerDependency，同时 SDK 使用 `^1.4.3`；锁文件只验证
`1.4.3`。这等于对所有未来 `1.x` 插件版本承诺兼容，却没有宿主集成测试或最低版/最新版矩阵支撑。

风险被两点放大：

| 位置 | 当前做法 | 漂移为何可能漏检 |
|---|---|---|
| `index.ts` | messages Hook 整体 `as any` | Hook 输入/输出改变时仍可能通过类型检查 |
| `lib/hooks.ts` | `client: any` | session/message API 的参数、响应变化不受 TypeScript 检查 |
| 测试 | 直接调用 Hook/伪造 client | 没有覆盖真实宿主的事件顺序与客户端构造 |
| peer range | 无上限 `>=1.4.3` | 未来不兼容版本也会被包管理器接受 |

OpenCode 的 V2 文档已经把插件 API 标为 beta，并要求插件依赖与目标 OpenCode 版本匹配、在合约变化时发布兼容更新。
[官方 V2 插件文档](https://opencode.ai/v2/docs/build/plugins)
这不是“当前 V1 已坏”的证据，但说明无限上界不应当被视为可靠的兼容承诺。

## 5. P1 风险：认证补丁依赖 SDK 内部字段

[lib/auth.ts](https://github.com/LeXwDeX/OpenCode-Dynamic-Context-Pruning/blob/61700ab4a19169c608028e7e4d2698fb323af7d6/lib/auth.ts)
通过 `client._client || client.client` 找到底层 HTTP client，再安装 request interceptor。当前生成的
`OpencodeClient` 确实保留 `_client`，但它是 `protected` 字段，不是稳定的公开插件 API。
[官方生成客户端](https://github.com/anomalyco/opencode/blob/dev/packages/sdk/js/src/gen/sdk.gen.ts)

同时，OpenCode 当前插件加载器创建 SDK client 时已经合入 `ServerAuth.headers()`。
[官方插件加载器](https://github.com/anomalyco/opencode/blob/dev/packages/opencode/src/plugin/index.ts)
因此当前宿主下，这层私有字段补丁大概率是冗余的；一旦 SDK 重命名、封装或冻结 `_client`，它会静默失效，
而 `client: any` 不会给出编译错误。

建议先用真实宿主验证认证场景，再删除该补丁或改用官方公开扩展点；不要把 `_client` 当作长期合约。

## 6. 上游差异：未发现漏合入的核心剪枝 BUG 修复

本分叉与上游共同祖先是 `0657cd2`。从该点到上游 `85b6f5c` 有 16 个上游独有提交；主要实质变化是：

| 上游版本 | 变化 | 本分叉影响 |
|---|---|---|
| `3.1.13` | 新增 `/dcp` TUI 面板、`/dcp-compress`、模态输出及手动模式持久化 | 缺少可视化控制面板，属于产品差异 |
| `3.1.14` | 更新 TUI 依赖以兼容 OpenCode `1.17.10` / OpenTUI `0.4.x` | 因本分叉没有该 TUI，不能直接判为运行时 BUG |

证据：[上游发布记录](https://github.com/Opencode-DCP/opencode-dynamic-context-pruning/releases)、
[共同祖先到上游的比较](https://github.com/Opencode-DCP/opencode-dynamic-context-pruning/compare/0657cd2fd50e9891cd69eae3787bcf280fabc2ba...85b6f5ceba144fee9e65eb28dc36cab1b960e418)。

本次提交级检查没有发现共同祖先之后被本分叉遗漏的“服务端剪枝/压缩核心 BUG 修复”。因此不能把上游版本号
`3.1.14` 高于共同祖先简单等同为本分叉存在已知核心缺陷。真正未合入的是 TUI 产品能力；是否需要它由本项目定位决定。

## 7. 建议处理顺序

1. **P0，1–2 天**：把状态改为按 `sessionId` 隔离，覆盖 transform/event/command 同时交错。
2. **P1，半天内**：CI 增加最低支持版与 npm 最新版两档；至少启动一次真实 OpenCode 宿主 smoke test。
3. **P1，半天内**：去掉关键路径的 `any`，收紧 peer 兼容策略；每次 OpenCode minor 更新自动验证。
4. **P2，2 小时**：让状态目录可注入，测试统一使用临时目录，并让持久化失败可观察。
5. **P2，产品决定**：明确是否需要上游 `/dcp` TUI；若不需要，在 README 记录这是刻意分叉。

## 8. 复核边界

| 已证明 | 尚未证明 |
|---|---|
| 当前 V1 类型和 legacy 加载器仍支持本项目 Hook | OpenCode `1.18.x` 真实进程中的端到端兼容 |
| 最新依赖下 TypeScript 编译通过 | 两个真实 Session 并发时的数据污染结果 |
| duration 测试在隔离状态目录后通过；沙箱失败来自真实目录写入被拒 | 所有模型提供商、认证方式和持久化路径均正确 |
| 上游独有变更主要是 TUI | V2 插件 API 可直接无改动迁移 |

官方参考入口：[V1 插件文档](https://opencode.ai/docs/plugins/)、
[V1 插件类型](https://github.com/anomalyco/opencode/blob/dev/packages/plugin/src/index.ts)、
[V2 插件文档](https://opencode.ai/v2/docs/build/plugins)、
[OpenCode 发布记录](https://github.com/anomalyco/opencode/releases)。
