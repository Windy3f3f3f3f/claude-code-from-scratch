# Mini Claude Code

> 一步一步，从零造一个 Claude Code

[English](./README_EN.md)

**用 ~1300 行

 TypeScript 复现 Claude Code 的核心能力。** 这不是 demo，而是一份分步教程——每一步都对照 Claude Code 真实源码讲解"它怎么做的 → 我们怎么简化的"，帮你彻底理解 coding agent 的工作原理。

<video src="https://github.com/user-attachments/assets/4f6597e2-6ea3-45ae-8a6b-77662c4e9540" width="100%" autoplay loop muted playsinline></video>

## 分步教程

**[在线阅读 →](https://windy3f3f3f3f.github.io/claude-code-from-scratch/)**

8 章内容，从核心循环到完整 CLI，每章都贴真实代码 + Claude Code 源码对照：

| 章节 | 内容 | 对应源码 |
|------|------|---------|
| [1. Agent Loop](https://windy3f3f3f3f.github.io/claude-code-from-scratch/#/docs/01-agent-loop) | 核心循环：调用 LLM → 执行工具 → 重复 | `agent.ts` ↔ `query.ts` |
| [2. 工具系统](https://windy3f3f3f3f.github.io/claude-code-from-scratch/#/docs/02-tools) | 6 个工具的定义与实现 | `tools.ts` ↔ `Tool.ts` + 66 工具 |
| [3. System Prompt](https://windy3f3f3f3f.github.io/claude-code-from-scratch/#/docs/03-system-prompt) | 让 LLM 成为合格 agent 的提示词工程 | `prompt.ts` ↔ `prompts.ts` |
| [4. 流式输出](https://windy3f3f3f3f.github.io/claude-code-from-scratch/#/docs/04-streaming) | Anthropic + OpenAI 双后端流式处理 | `agent.ts` ↔ `api/claude.ts` |
| [5. 权限与安全](https://windy3f3f3f3f.github.io/claude-code-from-scratch/#/docs/05-safety) | 危险命令检测 + 用户确认机制 | `tools.ts` ↔ `permissions.ts` (52KB) |
| [6. 上下文管理](https://windy3f3f3f3f.github.io/claude-code-from-scratch/#/docs/06-context) | 结果截断 + 自动对话压缩 | `agent.ts` ↔ `compact/` |
| [7. CLI 与会话](https://windy3f3f3f3f.github.io/claude-code-from-scratch/#/docs/07-cli-session) | REPL、Ctrl+C、会话持久化 | `cli.ts` ↔ `cli.tsx` |
| [8. 架构对比](https://windy3f3f3f3f.github.io/claude-code-from-scratch/#/docs/08-whats-next) | 完整对比 + 扩展方向 | 全局 |

## 快速开始

```bash
git clone https://github.com/Windy3f3f3f3f/claude-code-from-scratch.git
cd claude-code-from-scratch
npm install && npm run build
```

### 配置 API

支持两种后端，通过环境变量自动识别：

**方式一：Anthropic 格式（推荐）**

```bash
export ANTHROPIC_API_KEY="sk-ant-xxx"
# 可选：使用代理
export ANTHROPIC_BASE_URL="https://aihubmix.com"
```

**方式二：OpenAI 兼容格式**

```bash
export OPENAI_API_KEY="sk-xxx"
export OPENAI_BASE_URL="https://api.openai.com/v1"
```

默认模型为 `claude-opus-4-6`，可通过环境变量或命令行参数自定义：

```bash
export MINI_CLAUDE_MODEL="claude-sonnet-4-6"    # 环境变量方式
npm start -- --model gpt-4o                      # 命令行方式（优先级更高）
```

### 运行

```bash
npm start                    # 交互式 REPL 模式（推荐）
npm start -- --resume        # 恢复上次会话继续对话
npm start -- --yolo          # 跳过安全确认（危险命令自动执行）
```

全局安装后可在任意目录使用：

```bash
npm link                     # 全局安装
cd ~/your-project
mini-claude                  # 直接启动
```

### REPL 命令

| 命令 | 功能 |
|------|------|
| `/clear` | 清空对话历史 |
| `/cost` | 显示累计 token 用量和费用估算 |
| `/compact` | 手动触发对话压缩 |

## 核心能力

- **Agent 循环**：自动调用工具、处理结果、持续迭代，直到任务完成
- **6 个核心工具**：读文件、写文件、编辑代码、搜索文件、搜索内容、执行命令
- **流式输出**：逐字实时显示，Anthropic + OpenAI 双后端
- **上下文管理**：自动追踪 token 用量，对话过长时自动压缩
- **安全确认**：危险命令需要用户确认，`--yolo` 模式可跳过
- **会话持久化**：自动保存对话，`--resume` 恢复上次会话
- **错误恢复**：API 限流/过载时指数退避重试，Ctrl+C 优雅中断

## 架构图

```
用户输入
  │
  ▼
┌─────────────────────────────────────┐
│          Agent Loop                 │
│                                     │
│  消息历史 → API (流式) → 实时输出   │
│       ▲                   │         │
│       │              ┌────┴───┐     │
│       │              │文本输出│     │
│       │              │工具调用│     │
│       │              └────┬───┘     │
│       │                   │         │
│       │   ┌───────┐ ┌────▼───┐     │
│       │   │截断保护│←│工具执行│     │
│       │   └───────┘ └────┬───┘     │
│       │                   │         │
│       │   ┌───────────────▼───┐     │
│       └───│Token 追踪 + 压缩 │     │
│           └───────────────────┘     │
└─────────────────────────────────────┘
  │
  ▼
任务完成 → 自动保存会话
```

## 与 Claude Code 的对比

| 维度 | Claude Code | Mini Claude Code |
|------|------------|-----------------|
| 定位 | 生产级编程智能体 | 教学 / 最小可用实现 |
| 工具数量 | 66+ 内置工具 | 6 个核心工具 |
| 上下文管理 | 4 级压缩流水线 | Token 追踪 + 自动压缩 |
| 流式输出 | Ink/React 渲染 | 原生流式打印 |
| 安全机制 | 5 层权限系统 | 基本危险命令确认 |
| 代码量 | 50 万+ 行 | ~1300 行 |

## 项目结构

```
src/
├── cli.ts      # CLI 入口：参数解析、REPL、Ctrl+C     (209 行)
├── agent.ts    # Agent 循环：流式输出、重试、压缩      (620 行)
├── tools.ts    # 工具定义与实现：6 工具 + 截断保护     (304 行)
├── prompt.ts   # System Prompt：模板 + 环境注入        (65 行)
├── session.ts  # 会话持久化：保存/恢复/列表            (63 行)
└── ui.ts       # 终端输出：彩色显示、格式化            (102 行)
                                          总计: ~1300 行
```

## 相关项目

- [how-claude-code-works](https://github.com/Windy3f3f3f3f/how-claude-code-works) — Claude Code 源码架构深度解析

## License

MIT
