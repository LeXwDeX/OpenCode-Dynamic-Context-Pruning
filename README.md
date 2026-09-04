# 动态上下文剪枝插件

[![npm version](https://img.shields.io/npm/v/@lexwdex-org/opencode-dcp.svg)](https://www.npmjs.com/package/@lexwdex-org/opencode-dcp)

[English](./README.en.md) | 中文

DCP 在 OpenCode 发送模型请求之前，按当前模型预算折叠较旧的成功工具输出。修改只作用于请求副本；原始会话历史、工具调用和原生压缩流程仍由宿主管理。

## 工作方式

1. 从本次消息中的明确会话身份和最新用户消息的模型引用出发，通过宿主只读模型目录取得当前限额。缺少身份、模型或有效预算时保持原文。
2. 估算消息正文、完整工具输入、输出及协议开销。输出预算预先扣除，默认的 `targetRatio` 为稍后加入的系统提示和工具定义留出余量。
3. 保护最近的完整工具执行步骤：默认至少 4 步、至少 16,000 个估算 tokens，两项同时满足。一次用户请求内的多次工具执行也能区分远近；同一步中的并行工具一起保护。
4. 超过目标时，从旧到新选择有足够收益的成功工具输出，设置宿主原生 `state.time.compacted` 标记。宿主在模型请求中显示 `[Old tool result content cleared]`，输入和调用身份仍完整存在。
5. 在独立结果上完成计算，成功后提交请求副本；失败保持原文。

只处理已核实的 `read`、`grep`、`glob`，以及明确记录退出码 0 的 `bash` 输出。错误、未完成工具、未知工具、附件、技能/子任务结果及携带指令的读取输出（包括动态加载的指令）受到保护。用户可以增加受保护工具，但不能取消内置保护。

用户消息、助手文本、推理及签名、工具输入和错误内容逐字保留。消息和 parts 的数量、顺序、身份及调用配对保持不变。没有话题猜测、机械摘要、输入缩减、调用合并或去重。

普通 `@文件`、`@目录` 和 `@agent` 引用的宿主标记不会阻止剪枝：引用展开后的文本照常计算，标记原样保留。已被宿主压缩的工具按清理后的输出估算，即使原始历史仍保存附件。实际仍会发送给模型的媒体或未知内容继续保留原文，不猜测其 token 数。

**折叠是有损的工具输出清理。**过去的输出细节会从本次模型请求中消失，仍可在原始会话中查阅。DCP 不承诺任意长对话都能装入窗口：近期步骤、长输入、受保护内容或系统提示本身可能过大，此时保留保护规则，由宿主原生压缩处理。

宿主可能根据上一轮真实用量，在下一次剪枝入口之前启动自动压缩。因此，窗口较小或系统提示、工具定义较大时，可能先发生原生摘要，DCP 尚未有可折叠的旧步骤。`targetRatio` 是历史预算比例，不是最终模型请求的硬上限；近期保护不会因窗口不足而自动降低。原生摘要成功后是否续跑、正在执行的工具如何结算，属于宿主执行契约。

## 手动控制与原生压缩

模型可调用 `dcp_prune`，请求**下一次普通模型请求**主动折叠符合条件的历史输出。工具立即返回，同样遵守近期和内容保护；请求消费后不影响未来策略，不保存永久加深等级。可向助手提出“调用 dcp_prune 压缩旧工具输出”。

`/compact` 继续使用宿主原生行为。DCP 不触发 summarize、不写检查点、不替换摘要提示，也不改宿主 compaction 默认配置。宿主 compacting 钩子为随后同会话的 transform 设置一次跳过标志，确保摘要输入不被 DCP 改写。

## 安装

在 OpenCode 配置中加入插件：

```jsonc
{
    "plugin": ["@lexwdex-org/opencode-dcp@^6"],
}
```

需要支持 V1 插件接口的 OpenCode，插件 peer 范围为 `>=1.4.3 <2`。类型兼容矩阵检查最低版和最新 V1 版本；运行时契约另有固定真实宿主版本验证，详见[架构与验证](./ARCHITECTURE.md)。不带显式会话身份或模型信息的消息形状不会被猜测或压缩。

## 配置

按以下顺序覆盖：全局 `$XDG_CONFIG_HOME/opencode/dcp.jsonc`（默认 `~/.config/opencode/dcp.jsonc`）→ `$OPENCODE_CONFIG_DIR/dcp.jsonc` → 项目最近一级 `.opencode/dcp.jsonc`。同目录支持 `.json`，优先 `.jsonc`。插件不自动创建配置文件。

```jsonc
{
    "$schema": "https://raw.githubusercontent.com/LeXwDeX/opencode-dynamic-context-pruning/master/dcp.schema.json",
    "enabled": true,
    "autoUpdate": true,
    "debug": false,
    "dtc": {
        "enabled": true,
        "protectRecentSteps": 4,
        "protectRecentTokens": 16000,
        "targetRatio": 0.7,
        "minimumSavingsTokens": 512,
        "protectedTools": [],
    },
    "tool": { "enabled": true },
}
```

| 参数                       | 含义                                             |
| -------------------------- | ------------------------------------------------ |
| `dtc.protectRecentSteps`   | 最近完整工具步骤的最少数量，整数且至少 1         |
| `dtc.protectRecentTokens`  | 扩展近期保护区直到满足的估算 token 数，非负整数  |
| `dtc.targetRatio`          | 消息历史占保守输入预算的比例，范围 `(0, 1]`      |
| `dtc.minimumSavingsTokens` | 单个输出值得折叠的最低估算节省量，正整数         |
| `dtc.protectedTools`       | 额外保护的工具名称                               |
| `tool.enabled`             | 注册 `dcp_prune`；DTC 关闭时也不注册工具         |
| `autoUpdate`               | 仅提示新版本，不安装或修改插件                   |
| `debug`                    | 记录投影统计、跳过及安全熔断原因，不捕获会话正文 |

无效 JSONC 整层忽略；类型错误的字段保留上一层有效值并显示提示。所有状态仅存在于插件进程内，控制标志有容量上限。

## 从 5.x 及更早版本升级

6.0 直接替换旧引擎，不提供旧策略开关：

- 删除 D/M/C 分区、话题漂移和机械摘要；没有摘要缓存，也不再通过时间戳推测会话。
- 删除结构合并与输入/错误/推理改写。`tailTurns`、`lowWatermarkRatio`、`driftThreshold`、`toolOutputKeepChars`、`mergeRuns` 不再生效。
- 删除 `/dcp fold|status`。V1 命令钩子没有正式取消协议，旧实现的异常拦截不再保留；`commands.*` 退役。使用 `dcp_prune`，运行诊断见 debug 日志。
- 手动折叠由永久等级改为下一次普通请求的一次性控制。
- 不再注入 `compaction.tail_turns` 或 `preserve_recent_tokens`。已有用户配置仍由宿主读取。
- 更早的 `compress`、`summarize`、`autoPrune`、`manualMode`、`strategies`、`turnProtection`、`language`、`experimental` 仍仅给退役提示；不会迁移出话题阈值。

安装新版本后重启 OpenCode 以加载新钩子。历史会话无需迁移；DCP 从未将本版本的折叠结果写回历史。

## 开发

使用 npm 和 Node.js 的 `node:test`：`npm test`、`npm run typecheck`、`npm run format:check`、`npm run check:package`。真实宿主测试为 `npm run test:host`；环境准备及验证范围见[架构文档](./ARCHITECTURE.md)。

许可证：[AGPL-3.0-or-later](./LICENSE)。
