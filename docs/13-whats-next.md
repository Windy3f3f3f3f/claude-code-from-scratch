# 13. 架构对比与下一步

> ℹ️ **关于本章对照表的说明**：下面的"架构对比"与"文件映射"用于帮助读者建立 **"我们这份约 5500 行（TS）/ 5000 行（Python）的最小实现"** 与 **"Claude Code 这类生产级 Coding Agent"** 在概念上的对应关系。
> 本项目是**独立的 clean-room 教育实现**——代码并非来自 Claude Code 的内部实现，所有对照仅用于学习与扩展研究的类比目的。具体细节可能与 Claude Code 真实内部实现存在差异。

从第一章那个只会聊天的循环起步，一路加到能读代码、改文件、跑测试、还能自治续跑的 agent——整套地基已经造完了。这一章把它和真实 Claude Code 逐项摆在一起，看清最小实现省掉了什么、生产级多做了什么，以及接下来还能往哪走。

## 完整架构对比

| 组件 | Claude Code | mini-claude | 差异 |
|------|------------|-------------|------|
| **Agent Loop** | 7 种 continue reason | 只检查 tool_use | 简化循环控制 |
| **工具数量** | 66+ 工具 | 12 个常驻工具（6 核心 + web_fetch + tool_search + skill + agent + 2 plan mode），`/loop` dynamic 期间临时挂 `schedule_wakeup` | 去掉特化工具 |
| **工具执行** | 并发执行 + streaming 早期启动 | 并行执行 + streaming 早期启动 | 架构对齐 |
| **API 后端** | Anthropic only | Anthropic + OpenAI 兼容 | 多了 OpenAI |
| **System Prompt** | static/dynamic 分界 + API 缓存 | static/dynamic 分界 + cache_control 断点 | 架构对齐 |
| **权限系统** | 7 层 + AST 分析 + 8 级规则源 | 6 模式 + 规则配置 + 正则 + 确认/Auto 分类器 | 层次对齐 |
| **上下文管理** | 4 级压缩流水线 | 4 层（budget + snip + microcompact + 摘要） | 架构对齐 |
| **记忆系统** | 4 类型 + 语义召回 + MEMORY.md 索引 | 4 类型 + 语义召回 + MEMORY.md + 异步预取 | 架构对齐 |
| **技能系统** | 6 源 + 懒加载 + inline/fork | 2 源 + 预加载 + inline/fork | 去掉高级加载 |
| **多 Agent** | Sub-Agent + 自定义 + Coordinator + Swarm | Sub-Agent（3 内置 + 自定义） | 去掉 Coordinator/Swarm |
| **MCP 集成** | mcpClient.ts + 动态工具发现 | McpManager + JSON-RPC over stdio | 架构对齐 |
| **预算控制** | USD/轮次/abort 三维预算 | USD + 轮次限制 | 去掉 abort signal |
| **编辑验证** | 14 步流水线 | 引号容错 + 唯一性 + diff 输出 | 保留核心步骤 |

## 文件映射表

| mini-claude (TypeScript) | mini-claude (Python) | Claude Code 源码 | 说明 |
|------------|------------|-------------------|------|
| `src/agent.ts` | `python/mini_claude/agent.py` | `src/query.ts` + `src/QueryEngine.ts` | Agent 循环 + 会话管理 |
| `src/tools.ts` | `python/mini_claude/tools.py` | `src/Tool.ts` + `src/tools/` (66 个目录) | 工具定义与执行 |
| `src/prompt.ts` | `python/mini_claude/prompt.py` | `src/constants/prompts.ts` + `src/utils/claudemd.ts` | Prompt 构造 |
| `src/cli.ts` | `python/mini_claude/__main__.py` | `src/entrypoints/cli.tsx` + `src/commands/` | 入口与命令 |
| `src/ui.ts` | `python/mini_claude/ui.py` | `src/components/` (React/Ink 组件) | UI 渲染 |
| `src/session.ts` | `python/mini_claude/session.py` | `src/utils/sessionStorage.ts` + `src/history.ts` | 会话持久化 |
| `src/memory.ts` | `python/mini_claude/memory.py` | `src/utils/memory.ts` + 系统 prompt 注入 | 记忆系统 |
| `src/skills.ts` | `python/mini_claude/skills.py` | `src/utils/skills.ts` + `src/tools/SkillTool/` | 技能系统 |
| `src/subagent.ts` | `python/mini_claude/subagent.py` | `src/tools/AgentTool/` (built-in types) | 子 Agent 类型配置 |
| `src/mcp.ts` | `python/mini_claude/mcp_client.py` | `src/services/mcpClient.ts` | MCP 客户端 |

## 我们没实现的

### Hooks（钩子系统）

Claude Code 有 25 种 hook 事件、6 种 hook 类型，可在工具执行前后插入自定义逻辑——拦截危险操作、记录审计日志、自动运行 lint 检查。它是 Claude Code 从"工具"变成"平台"的关键机制。

我们没实现的原因：核心挑战不在于"调一个函数"，而在于 hook 的发现与加载、错误隔离、stdin/stdout JSON 数据协议。这些工程细节约 500-800 行，但对理解 agent 原理没有帮助。

### Coordinator / Swarm 多 Agent 模式

我们实现了 Sub-Agent（fork-return）。Claude Code 还有两种模式：**Coordinator** 把大任务拆分给多个专业 Agent，**Swarm** 让多个 Agent 对等通信、并行探索。两种模式解决的是单 Agent 上下文不够时的任务分解问题。

没实现的原因：核心挑战是任务分解准确性和 Agent 间通信协议设计，更多是 prompt engineering 问题而非代码架构问题。实现本身不复杂，但要真正好用需要大量 prompt 调优。

### LSP 集成

LSP 让 agent 在编辑文件后毫秒级获得类型错误反馈，而不需要等完整的编译/测试周期。在大型项目中，这能把修复一个 bug 所需的循环次数减少 30-50%。

没实现的原因：需要管理 LSP 服务器进程、实现客户端协议（初始化握手、能力协商、增量同步），1000+ 行且依赖对 LSP 协议的深入理解。通过 shell 命令（`tsc --noEmit`、`python -m py_compile`）获得错误反馈，对教程场景已经足够。

### Bash AST 安全分析

Claude Code 用 tree-sitter 解析 shell 命令的 AST，进行 23 项静态安全检查，能分析出管道组合中的危险命令——这是纯正则做不到的。

没实现的原因：tree-sitter 是 C/C++ 原生库，需要 `node-gyp` 编译环境，环境障碍太高。正则匹配覆盖了 80% 的常见危险模式，教程场景风险可接受。

## 渐进式增强路线图

### 第一阶段：前缀缓存（已完成）

Prompt Caching 已经按 Claude Code 的做法补上了，细节在 [第 7 章：前缀缓存](docs/07-context.md)。做法是给系统提示词的静态部分标 `cache_control: { type: "ephemeral" }`，再给最后一条消息滚动打一个断点；命中的前缀按 0.1× 计费。多轮对话里第二轮起，前面积累的 system、工具定义和历史消息基本都从缓存读，只有最新的增量需要重新处理。

### 自治与续跑三件套（已完成）

`/goal`、`/loop`、Auto Mode 三件套也补上了，细节在 [第 15 章：自治与续跑](docs/15-autonomy.md)。它们让 agent 能跨很多 turn、在无人盯着的情况下继续往前走：`/goal` 用一个独立评估器把停止条件追到达成或判定不可能，`/loop` 让主模型按间隔或自定节奏排下一次运行，Auto Mode 用一个读脱敏对话记录的分类器代替危险操作的确认框。提示词逐字取自泄露实锤，机制上做了几处教学简化：Auto Mode 的两段式分类流程已经复现，只是省了真实客户端的 stop_sequences、thinking-token 那些外围细节；`/loop` 用会话内定时器代替了 KAIROS 常驻进程。本章下面「扩展方向」里原本对这类能力的设想，可以对照第 15 章看已经落地到什么程度。

### 第二阶段：可扩展性（3-5 天）

| 增强项 | 解决的问题 | 预计代码量 |
|--------|-----------|-----------|
| Hook 系统 | 定制 agent 行为需要改源码 | ~300 行 |
| Tool 类型系统 | switch/case 不能扩展到 20+ 工具 | ~200 行 |

核心转变是**从硬编码到插件化**。当前 switch/case 在 10 个工具时没问题，但超过 20 个就需要引入 Tool 接口（或 Python 的 Protocol/ABC），让每个工具成为独立模块。

### 第三阶段：可靠性与安全（1-2 周）

| 增强项 | 解决的问题 | 预计代码量 |
|--------|-----------|-----------|
| 7 种错误恢复策略 | 当前遇到错误直接崩溃 | ~400 行 |
| Bash AST 安全分析 | 正则匹配漏检复杂危险命令 | ~600 行 |

Claude Code 的 `query.ts` 有 1728 行，大部分是边缘情况处理：Prompt Too Long 时自动压缩重试、API 过载时指数退避、工具失败时把错误反馈给模型让它自修复。

### 第四阶段：高级 Agent 能力（2-4 周）

| 增强项 | 解决的问题 | 预计代码量 |
|--------|-----------|-----------|
| Coordinator 模式 | 大任务超出单 Agent 上下文容量 | ~500 行 |
| Swarm 模式 | 探索性任务需要多路径并行 | ~600 行 |
| LSP 集成 | 类型错误只能通过编译发现 | ~1000 行 |

## 扩展方向

### 1. Hooks 系统

最简单的方案是 command hook——在 `executeTool` 前 spawn shell 子进程，通过 stdin JSON 传入工具信息，解析 stdout JSON 决定 allow/deny。

配置示例：
```json
{
  "hooks": {
    "PreToolUse": [
      { "matcher": "run_shell", "command": "./hooks/pre-shell.sh" }
    ]
  }
}
```

核心逻辑：遍历匹配的 hook，spawn 子进程传 JSON，根据 `{"action": "allow"}` / `{"action": "deny", "reason": "..."}` 决定是否继续执行。约 300 行，最耗时的是子进程的超时和 crash 处理。

### 2. 错误自修复

把工具执行错误作为工具结果反馈给模型，而不是中断循环。模型经常能自己修复：路径拼错换路径、命令参数错了改参数。

```typescript
try {
  result = await executeToolImpl(name, input);
} catch (e) {
  result = `Error: ${e.message}\n\nPlease try a different approach.`;
}
// 把 result 作为 tool_result 返回给模型
```

约 50-80 行，但能显著提升 agent 实际可用性——这是 Claude Code 最聪明的设计之一。

## 核心洞察

**1. Agent 的本质是一个 while 循环**

```
while true:
    response = llm.call(messages)
    if no tool_calls in response: break
    for tool_call in response.tool_calls:
        result = execute(tool_call)
        messages.append(result)
```

所有的复杂性——权限、上下文管理、记忆、多 Agent——都是围绕这个循环的增强和防护。

**2. 提示词是最便宜的代码**

系统提示词里的一句话，效果等同于一个 if 语句，实现成本是 0 行代码。agent 开发中很多行为问题的最优解不是写更多代码，而是写更好的提示词——更灵活、更容易修改、非技术人员也能读懂。

**3. 工具设计决定能力上限**

让模型做它擅长的（理解意图、生成代码），让工具做模型不擅长的（精确字符串匹配、文件系统操作、进程管理）。`edit_file` 是典型：模型生成要替换的内容，工具负责在文件中精确定位和替换。

**4. 上下文管理是 agent 的"记忆力"**

上下文管理之于 agent，就像内存管理之于操作系统——用有限资源提供"无限"错觉。4 层压缩流水线让 agent 在有限窗口中保持对长对话的记忆。

**5. 安全不是事后补丁**

权限检查是 agent 循环的一个步骤，不是外挂的 middleware。没有任何工具可以绕过它。更重要的是 fail-closed 设计：新工具如果忘记声明权限级别，被自动当作"需要确认"处理——系统通过默认值保证安全。

**6. 从 3000 行到 50 万行的差距在于边缘情况**

Claude Code 多出来的代码大多是：各运行环境兼容性、网络和 API 不可靠性、用户输入多样性、企业级审计和访问控制。这些"无聊"的代码不会出现在架构图中，却是工具能否在真实世界可靠运行的关键。从原型到产品，80% 的距离在这里。

**7. LLM 与代码的协作边界**

构建 coding agent 最核心的能力：设计好 LLM 和代码之间的协作边界。哪些让 LLM 决定，哪些让代码决定——边界划得好，agent 既灵活又可靠。我们在教程里每个设计决策都体现了这个原则：模型决定"做什么"，代码确保"安全地做"。

## 交叉引用

想深入了解 Claude Code 各模块的设计原理？参考兄弟项目的详细文档：

| 主题 | 本教程 | how-claude-code-works |
|------|--------|----------------------|
| Agent 循环 | [Ch1: Agent Loop](docs/01-agent-loop.md) | [系统主循环](https://windy3f3f3f3f.github.io/how-claude-code-works/#/docs/02-agent-loop) |
| 工具系统 | [Ch2: 工具系统](docs/02-tools.md) | [工具系统](https://windy3f3f3f3f.github.io/how-claude-code-works/#/docs/04-tool-system) |
| 上下文管理 | [Ch7: 上下文管理](docs/07-context.md) | [上下文工程](https://windy3f3f3f3f.github.io/how-claude-code-works/#/docs/03-context-engineering) |
| 权限安全 | [Ch6: 权限与安全](docs/06-permissions.md) | [权限与安全](https://windy3f3f3f3f.github.io/how-claude-code-works/#/docs/10-permission-security) |
| 记忆系统 | [Ch8: 记忆系统](docs/08-memory.md) | [记忆系统](https://windy3f3f3f3f.github.io/how-claude-code-works/#/docs/08-memory-system) |
| 技能系统 | [Ch9: 技能系统](docs/09-skills.md) | [技能系统](https://windy3f3f3f3f.github.io/how-claude-code-works/#/docs/09-skills-system) |
| Plan Mode | [Ch10: Plan Mode](docs/10-plan-mode.md) | — |
| 多 Agent | [Ch11: 多 Agent](docs/11-multi-agent.md) | [多 Agent 架构](https://windy3f3f3f3f.github.io/how-claude-code-works/#/docs/07-multi-agent) |
| MCP 集成 | [Ch12: MCP 集成](docs/12-mcp.md) | — |
| 自治与续跑 | [Ch15: 自治与续跑](docs/15-autonomy.md) | [自治 /goal /loop](https://windy3f3f3f3f.github.io/how-claude-code-works/#/docs/17-autonomy-goal-loop) · [Auto Mode](https://windy3f3f3f3f.github.io/how-claude-code-works/#/docs/18-auto-mode) · [动态工作流](https://windy3f3f3f3f.github.io/how-claude-code-works/#/docs/19-dynamic-workflows) |

---

## 结语

约 5500 行（TS）/ 约 5060 行（Python），12 个 TS 文件 + 13 个 Python 文件，覆盖了一个 coding agent 的核心组件、进阶能力和自主运行：

**Phase 1 — 核心组件：** Agent Loop、工具系统（12 个常驻工具 + mtime 防护 + 延迟加载 + 并行执行）、System Prompt（Markdown 模板 + @include + 环境注入）、CLI / 会话（REPL + JSON 持久化）、流式输出（Anthropic + OpenAI 双后端 + streaming 工具执行）、权限安全（Phase 1 的 5 个基础模式 + 声明式规则 + 正则 + 确认，Phase 3 再加 Auto Mode）、上下文管理（4 层压缩 + 大结果持久化）

**Phase 2 — 进阶能力：** 记忆系统（语义召回 + 异步预取）、技能系统（inline/fork 双模式）、Plan Mode（只读规划 + 4 选项审批）、多 Agent（Sub-Agent + 3 内置类型 + 自定义）、MCP 集成（JSON-RPC over stdio）、预算控制

**Phase 3 — 自主运行：** `/goal`（评估器把停止条件追到底 + impossible 刹车）、`/loop`（interval 定时 + dynamic 自定节奏 + `schedule_wakeup`）、Auto Mode（transcript 分类器权限闸 + reasoning-blind 投影 + fail-closed + denial 回退）

Claude Code 50 万行里的大量代码是边缘情况处理和企业级可靠性。但核心 agent 能力——理解用户意图 → 调用工具操作代码 → 迭代直到完成——就是这几千行的事。

到这里，一个功能完整的最小 coding agent 已经成型，它背后每一行代码的设计意图也都摊开讲过了。后续的扩展，可以沿着上面那几条路线一步步往前推。
