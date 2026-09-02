# 动态上下文剪枝插件

[![npm version](https://img.shields.io/npm/v/@lexwdex-org/opencode-dcp.svg)](https://www.npmjs.com/package/@lexwdex-org/opencode-dcp)

[**English**](./README.en.md) | **中文**

DCP 以**动态分级请求期压缩（DTC）**管理 OpenCode 会话上下文：折叠发生在每次模型请求的消息序列化之前，**永不触碰会话状态机**——不调用 `session.summarize`、不产生压缩回合、不写会话存储。压缩对连续自动工作完全透明：agent 可以不间断运行数日，上下文压力由引擎在请求期自动消化。

## 工作原理

宿主在每次模型请求前触发 `experimental.chat.messages.transform`，DCP 在钩子内对**请求期消息副本**做分级折叠（宿主每轮循环从数据库重建该数组，因此所有修改天然只作用于本次请求）：

```text
┌────────────┬────────────┬────────────┬──────────────┐
│ D 远距离区 │ M 中距离区 │ C 当前任务 │ T 尾部保护区 │
│ 重度折叠   │ 中度折叠   │ 轻度折叠   │ 最后 4 轮    │
│ 结构化摘要 │ 首行+标记  │ 截长输出   │ 一个字节不动 │
└────────────┴────────────┴────────────┴──────────────┘
        ◄── 预算不足时从最远端逐级加深 ──►
```

- **T 尾部保护区**：最后 `dtc.tailTurns`（默认 4）轮对话**完全不折叠**。
- **C 当前任务区**：自最近话题边界（词面漂移检测）以来的轮次，只把超长 tool 输出做首尾截断，任务细节不丢。
- **M 中距离区**：长文本保留首行；tool 输出打宿主原生折叠标记（渲染为宿主自己的 `[Old tool result content cleared]`）；**tool 参数规约为目标骨架**（仅留 filePath/command 首行等，`oldString`/`newString`/`content` 等载荷全部丢弃）；**失败尝试（error part）折为短首行**——同一文件连改 3 次错 2 次，折叠后只剩 3 个可辨识调用骨架 + 2 条单行错误，最终状态以磁盘与当前任务区为准；推理内容清空。
- **D 远距离区**：整轮塌缩为一行机械摘要（意图 / 动作 / 涉及文件 / 结果 / 错误数），tool 参数一并清空——硬事实保留在摘要里。

**动态预算**：估算低于上下文窗口的 `lowWatermarkRatio`（默认 50%）时**完全不折叠**，短会话零开销；超出则按 D→M→C 从远到近逐级加深，直到估算落回 `targetRatio`（默认 70%）以内。窗口大小由 `chat.params` 钩子按会话自动学习，未知时 fail-open 不折叠。

**三条结构铁律**（老版本"丢失标记号"问题的构造性排除）：

1. 永不增删、重排消息或 part；永不改 ID——tool-call 与 tool-result 的配对不可能断裂；
2. 只重写字符串载荷（text/output/reasoning），折叠 tool 输出用宿主原生 `time.compacted` 标记，不自造占位符协议；
3. 一切修改仅存在于请求期副本，数据库中的会话历史逐字节不变。

## 触发面

- **自动**：无触发概念——每次请求按预算自动决定折叠深度，无需任何信号或边界。
- **模型调用 `dcp_prune` 工具**：瞬时返回。标记话题边界（当前任务区从下一轮重算）并把本会话折叠下限提到 M 级——旧任务内容从下一次请求起被折叠。绝不打断当前工作。
- **`/dcp fold`**：手动版本，直接把折叠下限提到最深档。
- **`/dcp status`**：查看当前会话的轮数、token 估算、窗口与降级档位。
- **宿主自身的 compaction**（`/compact`、上下文溢出兜底）：**100% 原生行为**——原生 anchored-summary 提示词、原生上一份检查点滚动合并，DCP 不做任何替换。DCP 只做两件事：把宿主尾部保护默认提升到 4 轮 / 32000 tokens（`compaction.tail_turns` / `preserve_recent_tokens`，用户显式配置优先）；压缩输入经过 transform 钩子时 DTC 一次性跳过，保证摘要器看到全保真内容。

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
    "commands": {
        "enabled": true,
    },
    "dtc": {
        "enabled": true,
        "tailTurns": 4,
        "lowWatermarkRatio": 0.5,
        "targetRatio": 0.7,
        "driftThreshold": 0.18,
        "toolOutputKeepChars": 4000,
    },
    "tool": {
        "enabled": true,
    },
}
```

| 键                        | 说明                                                                     |
| ------------------------- | ------------------------------------------------------------------------ |
| `dtc.enabled`             | 动态分级请求期压缩总开关                                                 |
| `dtc.tailTurns`           | 尾部保护轮数：最后 N 轮完全不折叠（默认 4）                              |
| `dtc.lowWatermarkRatio`   | 估算低于窗口 × 该比例时完全不折叠（默认 0.5）                            |
| `dtc.targetRatio`         | 逐级加深折叠直到估算 ≤ 窗口 × 该比例（默认 0.7）                         |
| `dtc.driftThreshold`      | Jaccard 相似度低于该值视为话题变更，开启新的当前任务区（0–1，默认 0.18） |
| `dtc.toolOutputKeepChars` | 当前任务区超长 tool 输出的首尾截断保留字符数（默认 4000）                |
| `tool.enabled`            | 注册模型可调用的 `dcp_prune` 工具（瞬时标记话题边界，绝不打断工作）      |

## 从 3.x / 4.0 迁移

3.x 的 `summarize`、`autoPrune` 配置块已删除（DCP 不再调用原生 summarize，也不再有启发式触发器）；4.1 起 `language` 与 `experimental.customPrompts` 也已删除——DCP 不再替换宿主压缩提示词，`dcp-prompts` 覆盖机制随之退役。这些键会显示迁移警告并被忽略。`autoPrune.driftThreshold` 自动迁移为 `dtc.driftThreshold`。更早的 `compress`、`manualMode`、`strategies`、`turnProtection` 等键维持删除状态。

行为变化：压缩不再产生可见的"检查点回合"，也不再需要任何静息边界或续跑机制——上下文折叠在每次请求内自动完成，会话与状态机零感知。语义检查点完全交还宿主原生 compaction（手动 `/compact` 或溢出兜底）：原生提示词、原生滚动合并，DCP 仅贡献尾部保护默认值与摘要输入的全保真保护。

## 开发验证

```bash
npm test
npm run typecheck
npm run build
npm run format:check
npm run check:package
```

许可：AGPL-3.0-or-later。
