# 动态上下文剪枝插件

[![npm version](https://img.shields.io/npm/v/@lexwdex-org/opencode-dcp.svg)](https://www.npmjs.com/package/@lexwdex-org/opencode-dcp)

[**English**](./README.en.md) | **中文**

DCP 为 OpenCode 原生 compaction 提供语义剪枝策略与主动触发机制。它不维护消息标记、消息 ID、压缩块、锚点或占位符。

## 工作原理

OpenCode 原生 compaction 负责生成和保存一个滚动检查点，并在后续模型请求中只发送：

```text
最新剪枝检查点 + 尚未压缩的近期尾部
```

DCP 在 `experimental.session.compacting` 阶段提供专用提示词，把检查点组织为固定三段结构：

- `## 系统上下文` — AGENTS.md、项目规则等系统级内容，从上一份检查点原样保留合并；
- `## 历史概要` — 早期历史和中部历史高度压缩：每项主题只留一句结论，不含过程；
- 最近任务 — 轻度压缩：已完成任务一句话概括；进行中任务保留完整详情（目标、已完成步骤、文件路径、关键决策、阻塞、下一步）。与当前任务相关的近期细节优先保留，保证凭检查点即可直接继续工作。

## 触发压缩

- **OpenCode 自动 compaction**：达到宿主阈值时自动运行。
- **模型调用 `dcp_prune` 工具**：插件注册的 LLM 工具，描述内置启发式规则——话题明显变更、任务收尾、上下文明显变长时立即调用。
- **插件启发式自动触发**（`autoPrune`）：监听用户消息流，在回合边界（`session.idle`）触发原生压缩：
    - 话题变更：新消息与近期消息的词面相似度骤降（CJK 二元组 + Jaccard）；
    - 消息量达到阈值；
    - 长时间中断后恢复。
      自动触发带冷却期；OpenCode 原生 `/compact` 或宿主压缩也会重置计数。
- **OpenCode 原生 `/compact`**：手动触发同一条 compaction 路径。
- **`/dcp summarize`**：手动调用原生 `session.summarize()`。

所有入口都经过同一协调器：同一会话的并发请求合并为一次原生调用；失败不会提交半成品检查点，原始上下文保持可用，默认 30 秒内不重试失败的请求。

压缩后的旧前缀不会再发送给模型，但 OpenCode 数据库中的原始会话历史不会被物理删除。下一次压缩会把旧检查点和新增尾部合并为一个新检查点，不会形成嵌套摘要。

## 安装

```bash
opencode plugin @lexwdex-org/opencode-dcp@latest --global
```

## 配置

DCP 依次读取以下配置，后面的层覆盖前面的层：

1. `~/.config/opencode/dcp.jsonc` 或 `dcp.json`
2. `$OPENCODE_CONFIG_DIR/dcp.jsonc` 或 `dcp.json`
3. 项目的 `.opencode/dcp.jsonc` 或 `dcp.json`

```jsonc
{
    "$schema": "https://raw.githubusercontent.com/LeXwDeX/opencode-dynamic-context-pruning/master/dcp.schema.json",
    "enabled": true,
    "autoUpdate": true,
    "debug": false,
    "language": "zh",
    "commands": {
        "enabled": true,
    },
    "experimental": {
        "customPrompts": false,
    },
    "summarize": {
        "failureCooldownMs": 30000,
    },
    "tool": {
        "enabled": true,
    },
    "autoPrune": {
        "enabled": true,
        "minMessages": 8,
        "volumeThreshold": 30,
        "driftThreshold": 0.18,
        "idleGapMs": 1800000,
        "cooldownMs": 300000,
    },
}
```

| 键                          | 说明                                                                      |
| --------------------------- | ------------------------------------------------------------------------- |
| `language`                  | 内置压缩提示词语言：`zh`（默认）/ `en`；自定义覆盖文件优先于该配置        |
| `tool.enabled`              | 注册模型可调用的 `dcp_prune` 工具（描述含"话题变更立即使用"的启发式指令） |
| `autoPrune.enabled`         | 启用插件侧启发式自动压缩                                                  |
| `autoPrune.minMessages`     | 会话用户消息数达到该值前不做任何自动判定                                  |
| `autoPrune.volumeThreshold` | 距上次压缩的用户消息量阈值                                                |
| `autoPrune.driftThreshold`  | Jaccard 相似度低于该值视为话题变更（0–1）                                 |
| `autoPrune.idleGapMs`       | 用户消息间隔超过该值视为长时间中断后恢复                                  |
| `autoPrune.cooldownMs`      | 同一会话两次自动压缩的最小间隔                                            |

启用 `experimental.customPrompts` 后，可将生成的
`~/.config/opencode/dcp-prompts/defaults/compaction.md` 复制到以下任一覆盖位置：

- 项目：`.opencode/dcp-prompts/overrides/compaction.md`
- 自定义配置目录：`$OPENCODE_CONFIG_DIR/dcp-prompts/overrides/compaction.md`
- 全局：`~/.config/opencode/dcp-prompts/overrides/compaction.md`

## 从 3.x 旧压缩管线迁移

旧配置 `compress`、`manualMode`、`strategies`、`turnProtection`、
`pruneNotification`、`protectedFilePatterns` 及旧命令保护字段均已删除。DCP 会显示迁移警告并忽略这些字段，不会静默继续旧行为。

以下功能已删除：`compress` / `compress_range` 模型工具、`/dcp compress`、
`/dcp decompress`、`/dcp recompress`、`/dcp sweep`、消息标记和插件压缩状态持久化。磁盘上已有的旧 DCP 会话状态文件不会被读取、改写或删除，可在确认不再回退旧版本后自行清理。

## 开发验证

```bash
npm test
npm run typecheck
npm run build
npm run format:check
npm run check:package
```

许可：AGPL-3.0-or-later。
