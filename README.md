# 动态上下文剪枝插件

[![npm version](https://img.shields.io/npm/v/@lexwdex-org/opencode-dcp.svg)](https://www.npmjs.com/package/@lexwdex-org/opencode-dcp)

[**English**](./README.en.md) | **中文**

DCP 为 OpenCode 原生 compaction 提供语义剪枝策略。它不再维护消息标记、消息 ID、压缩块、锚点、占位符或第二套摘要状态机。

## 工作原理

OpenCode 原生 compaction 负责生成和保存一个滚动检查点，并在后续模型请求中只发送：

```text
最新剪枝检查点 + 尚未压缩的近期尾部
```

DCP 只在 `experimental.session.compacting` 阶段提供专用提示词。提示词会：

- 删除无关闲聊、其他项目内容、重复解释和已推翻方案；
- 把多次工具试错折叠为最终成功结果，必要时保留一次根因；
- 把同一内容的重复修改折叠为最终状态和仍有效的决策；
- 把小型已完成主题压缩为一句结果；
- 保留继续工作需要的目标、约束、决策、实现状态、风险和下一步。

压缩后的旧前缀不会再发送给模型，但 OpenCode 数据库中的原始会话历史不会被物理删除。下一次压缩会把旧检查点和新增尾部合并为一个新检查点，不会形成嵌套摘要或压缩块 DAG。

## 安装

```bash
opencode plugin @lexwdex-org/opencode-dcp@latest --global
```

## 触发压缩

- OpenCode 自动 compaction：达到宿主阈值时自动运行。
- OpenCode 原生 `/compact`：手动触发同一条 compaction 路径。
- `/dcp summarize`：调用原生 `session.summarize()`，一次完成语义摘要和真实上下文剪枝。

同一会话的并发 `/dcp summarize` 会合并为一次原生调用。失败不会提交半成品检查点，原始上下文保持可用；默认 30 秒内不会重复调用失败的请求。

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
    "experimental": {
        "customPrompts": false,
    },
    "summarize": {
        "failureCooldownMs": 30000,
    },
}
```

启用 `experimental.customPrompts` 后，可将生成的
`~/.config/opencode/dcp-prompts/defaults/compaction.md` 复制到以下任一覆盖位置：

- 项目：`.opencode/dcp-prompts/overrides/compaction.md`
- 自定义配置目录：`$OPENCODE_CONFIG_DIR/dcp-prompts/overrides/compaction.md`
- 全局：`~/.config/opencode/dcp-prompts/overrides/compaction.md`

## 从 3.x 旧压缩管线迁移

旧配置 `compress`、`manualMode`、`strategies`、`turnProtection`、
`pruneNotification`、`protectedFilePatterns` 及旧命令保护字段均已删除。DCP 会显示迁移警告并忽略这些字段，不会静默继续旧行为。

以下功能已删除：`compress` / `compress_range` 模型工具、`/dcp compress`、
`/dcp decompress`、`/dcp recompress`、`/dcp sweep`、消息标记、nudge 和插件压缩状态持久化。磁盘上已有的旧 DCP 会话状态文件不会被读取、改写或删除，可在确认不再回退旧版本后自行清理。

## 开发验证

```bash
npm test
npm run typecheck
npm run build
npm run format:check
npm run check:package
```

许可：AGPL-3.0-or-later。
