# 14. 功能测试指南

## 本章目标

验证 mini-claude 的 19 项核心功能都正常工作。所有测试均为手动执行 + 目视验证，全部使用 `--yolo` 模式（跳过权限确认）。

```mermaid
graph LR
    Setup["bash test/setup.sh"] --> Build["npm run build（TS 版）"]
    Build --> Test["逐项测试"]
    Test --> Cleanup["bash test/cleanup.sh"]

    style Setup fill:#7c5cfc,color:#fff
    style Test fill:#e8e0ff
```

## 为什么需要手动测试

Coding Agent 的测试和普通软件不同——核心行为取决于 LLM 的响应，输出不确定。自动化单元测试能覆盖工具函数（文件读写、权限检查），但端到端的 Agent 行为只能人工观察：

- 模型是否正确选择了工具？
- 并行执行真的是并行的吗？
- 语义记忆召回的时机对不对？
- Plan mode 的审批流程交互是否流畅？

Claude Code 自身也采用类似策略：核心工具有单元测试，但 Agent 行为依赖人工 QA + 评估套件（eval suite）。

## 准备

```bash
cd claude-code-from-scratch

# 一键配置测试环境（MCP、Skills、CLAUDE.md、大文件、引号测试文件、自定义 Agent）
bash test/setup.sh

# 构建 TS 版（Python 版无需构建）
npm run build
```

确保 `.env` 已配置好 API Key：
```
ANTHROPIC_API_KEY=sk-xxx
ANTHROPIC_BASE_URL=https://aihubmix.com   # 可选
```

> **提示**：如果系统环境里同时有 `OPENAI_API_KEY` + `OPENAI_BASE_URL` 和 `ANTHROPIC_API_KEY`，
> 会优先走 OpenAI 兼容路径。两种路径都支持全部功能。

## 启动方式

**TS 版**：
```bash
# 交互式 REPL（推荐，能测 skill、plan mode 和 REPL 命令）
node dist/cli.js --yolo

# one-shot 模式
node dist/cli.js --yolo "你的提示词"
```

**Python 版**：
```bash
python -m mini_claude --yolo

# one-shot 模式
python -m mini_claude --yolo "你的提示词"
```

> 以下测试步骤中的命令行示例以 TS 版为例，Python 版将 `node dist/cli.js` 替换为 `python -m mini_claude` 即可，功能完全一致。

---

## Phase 1: 基础工具 (Test 1-3)

### 1. MCP 工具调用

**测试目标**：验证 MCP 服务器连接 + 工具发现 + 透明路由。

**预期**：启动时看到 `[mcp] Connected to 'test' — 3 tools`

```
Use the MCP 'add' tool to compute 17+25, then use the 'echo' tool to echo "hello MCP", then use the 'timestamp' tool.
```

✅ 预期输出：
- add 返回 `42`
- echo 返回 `hello MCP`
- timestamp 返回一个 Unix 时间戳
- 工具名带 `mcp__test__` 前缀

**设计意图**：MCP 是 Agent 能力扩展的核心机制。三段式命名 `mcp__server__tool` 既解决了命名冲突，又隐含了路由信息——从名字就知道该转发到哪个服务器。

---

### 2. WebFetch

**测试目标**：验证 HTTP 获取 + HTML 清洗。

```
Fetch the URL https://httpbin.org/json and tell me the slideshow title.
```

✅ 预期：返回 `Sample Slide Show`

```
Fetch https://example.com and tell me what the page is about.
```

✅ 预期：返回 HTML 转换后的纯文本内容

---

### 3. 并行工具执行

**测试目标**：验证并发安全的工具可以同时执行（不是串行）。

```
Read the files src/frontmatter.ts, src/session.ts, and src/skills.ts at the same time, then tell me each file's line count.
```

Python 版可改为读取 Python 文件：
```
Read the files python/mini_claude/frontmatter.py and python/mini_claude/session.py at the same time, then tell me each file's line count.
```

✅ 预期：多个 `read_file` 调用同时出现（不是一个一个来的）

**设计意图**：`CONCURRENCY_SAFE_TOOLS`（read_file、list_files、grep_search、web_fetch）标记为可并行，Agent 在流式输出阶段就开始执行这些工具，不等模型生成完毕。

---

## Phase 2: 记忆与上下文 (Test 4-7)

### 4. 语义记忆召回

**测试目标**：验证记忆保存 → 新对话中语义召回（异步 prefetch 机制）。

**第一步：保存记忆**
```
Save these memories for me:
1. type=project, name="API migration", description="Moving from REST to GraphQL", content="We are migrating our API from REST to GraphQL. Deadline is end of Q2 2025."
2. type=feedback, name="code style", description="Prefers functional programming", content="User prefers functional patterns (map/filter/reduce) over for loops and OOP."
3. type=reference, name="staging server", description="Staging environment URL", content="Staging server: https://staging.example.com, credentials in 1Password."
```

✅ 预期：三个 memory 文件被写入

**第二步：退出，重新启动一个新对话**，然后输入会触发工具调用的查询：

> **原理**：语义召回是异步 prefetch（和 Claude Code 行为一致，zero-wait 不阻塞）。
> prefetch 在用户消息发出时启动，需要几秒完成。如果模型直接文本回答不调工具，
> 循环只跑一次就结束了，prefetch 来不及被消费。所以测试查询需要能触发工具调用，
> 给 prefetch 足够时间在第二轮 iteration 被注入。

```
Read the file tsconfig.json, then tell me: where can I deploy to test my changes?
```
✅ 预期：召回 staging server 记忆，回答 `https://staging.example.com`

```
List the files in the src/ directory, then tell me: what's the deadline for the backend rewrite?
```
✅ 预期：召回 API migration 记忆，回答 `end of Q2 2025`

```
Read package.json, then tell me: how should I write code for this project?
```
✅ 预期：召回 code style 记忆，提到 functional programming

---

### 5. @include 指令 + Rules 自动加载

**测试目标**：验证 CLAUDE.md 的 `@path` 包含指令和 `.claude/rules/` 自动加载。

setup.sh 已经创建了：
- `CLAUDE.md` 包含 `@./.claude/rules/chinese-greeting.md`
- rule 内容：`When the user greets you, respond in Chinese`

```
Hello! Who are you?
```

✅ 预期：模型用**中文**回复（因为 rule 要求打招呼时说中文）

**设计意图**：`@include` 机制支持 `@./相对路径`、`@~/Home路径`、`@/绝对路径` 三种格式，有循环引用检测和最大深度限制（5 层）。Rules 目录下的所有 `.md` 文件按字母排序后拼接到 system prompt 中。

---

### 6. Read-before-edit 保护

**测试目标**：验证编辑未读文件时的安全检查。

```
Edit the file package.json and change the version to "9.9.9". Do NOT read it first.
```

✅ 预期（两种可能都算通过）：
- **最佳**：工具层直接返回 `Error: You must read this file before editing`
- **次佳**：模型因 system prompt 要求，自动先 read 再 edit

测完记得恢复：
```
Now change it back to "1.0.0".
```

---

### 7. 大结果持久化

**测试目标**：验证超大工具结果写入磁盘 + 预览截断。

```
Read the file test/large-file.txt
```

✅ 预期输出包含：
- `[Result too large (XX.X KB, 1000 lines). Full output saved to ...]`
- `Preview (first 200 lines):`
- 只显示前 200 行的预览

然后继续问：
```
What does line 500 say?
```

✅ 预期：模型用 grep_search 或 read_file 从原文件找到 Line 499 的内容

**设计意图**：超过 30KB 的工具结果写入 `~/.mini-claude/tool-results/`，conversation 中只保留预览。这防止一个大文件把整个上下文窗口撑爆。和 Claude Code 的 `LargeResultPersistence` 逻辑对齐。

---

## Phase 3: 技能与工具扩展 (Test 8-10)

### 8. Skill 调用

**测试目标**：验证 skill 发现、inline 调用、slash command。

```
/skills
```
✅ 预期：列出 greet 和 commit 两个 skill

```
/greet Alice
```
✅ 预期：模型生成一段对 Alice 的个性化问候

```
/commit
```
✅ 预期：模型执行 git diff/status，然后尝试创建 commit

---

### 9. ToolSearch / 延迟加载工具

**测试目标**：验证 deferred tool 机制——plan mode 工具初始不发送 schema，搜索后才激活。

```
Use tool_search to find the "plan mode" tool.
```

✅ 预期：
- 模型调用 `tool_search`
- 返回 `enter_plan_mode` 和/或 `exit_plan_mode` 的完整 schema
- 这些工具之前不在工具列表中，被搜索后才激活

**设计意图**：Deferred tools 减少每次 API 调用发送的工具 schema 大小。Claude Code 有 60+ 工具，但大部分场景只用 5-6 个。发送全部 schema 浪费 token，延迟加载按需激活。

---

### 10. REPL 命令

```
/cost
```
✅ 显示 token 用量和费用

```
/memory
```
✅ 列出已保存的记忆

```
/compact
```
✅ 手动触发对话压缩

```
/plan
```
✅ 切换到 plan mode（再输入一次切回来）

---

## Phase 4: Agent 架构 (Test 11-12)

### 11. Sub-agent 系统（Agent Tool）

**测试目标**：验证三种内置 agent 类型的隔离执行和工具限制。

**explore agent**（只读搜索）：
```
Use the agent tool with type "explore" to find all files that import from "./memory.js" in the src/ directory.
```

✅ 预期：
- 输出显示 `[sub-agent:explore]` 标记
- 返回引用 `memory.js` 的文件列表
- 只使用 read_file / list_files / grep_search

**plan agent**（结构化规划）：
```
Use the agent tool with type "plan" to design a plan for adding a "help" REPL command. Identify which files need modification.
```

✅ 预期：输出显示 `[sub-agent:plan]` 标记，返回结构化修改计划

**general agent**（完整工具）：
```
Use the agent tool with type "general" to create a file called /tmp/mini-claude-agent-test.txt with the content "agent test passed", then read it back.
```

✅ 预期：
- 输出显示 `[sub-agent:general]` 标记
- 成功创建并读取文件
- sub-agent 的 token 消耗累加到主 agent（`/cost` 可见）

**设计意图**：Sub-agent 是 Claude Code 的"分治"策略——把大任务拆给子 agent，各自独立上下文，不污染主对话。explore agent 限制为只读工具防止意外修改，general agent 排除了 agent 工具防止无限递归。

---

### 12. Plan Mode（手动进入）

**测试目标**：验证 `/plan` 切换 + 只读限制 + plan file 写入 + 审批流程。

**第一步：进入 plan mode**
```
/plan
```
✅ 预期：显示 plan mode 已开启

**第二步：测试只读限制**
```
Read package.json, then create a plan for changing the project name. Write your plan to the plan file.
```

✅ 预期：
- 模型能读取 package.json（read 工具始终允许）
- 模型写入 plan file（唯一允许编辑的文件）
- 如果尝试编辑其他文件，被拒绝：`Blocked in plan mode`

**第三步：审批流程**

等模型调用 `exit_plan_mode` 后，出现 4 个选项：
1. 选择 `4`（keep-planning），输入反馈："Also add a step for updating README"
2. 模型修改计划后再次 exit_plan_mode，选择 `1`（clear-and-execute）

✅ 预期：选择 1 后上下文清理，切换到执行模式

**第四步：退出 plan mode**
```
/plan
```
✅ 预期：切换回普通模式

**设计意图**：Plan mode 是 Claude Code 的"先想后做"机制。限制为只读 + plan file 写入，防止模型在规划阶段就开始改代码。四选一审批让用户掌控执行方式——可以保留上下文执行（2），也可以清空上下文再执行（1），避免 plan 内容本身占用 token 预算。

---

## Phase 5: 编辑与搜索 (Test 13, 17-18)

### 13. Edit 的引号规范化

**测试目标**：验证 edit_file 的 curly quote → straight quote 回退匹配。

```
Read the file test/quote-test.js
```

然后要求使用弯引号编辑：
```
Use edit_file on test/quote-test.js. In the old_string, use curly double quotes (Unicode U+201C and U+201D) around "Hello World". Replace with straight quotes saying "Hi Universe".
```

✅ 预期：
- 编辑成功，输出包含 `(matched via quote normalization)`
- 文件内容从 `"Hello World"` 变为 `"Hi Universe"`

测完恢复：
```
Edit test/quote-test.js, replace "Hi Universe" with "Hello World"
```

**设计意图**：LLM 输出和用户从文档复制的文本经常包含 Unicode 弯引号（`""`、`''`）。Claude Code 的 `normalizeQuotes` 函数先尝试精确匹配，失败后将两边都规范化为直引号再匹配，避免"找不到要替换的内容"的常见报错。

---

### 17. Grep Search 工具

**测试目标**：验证正则搜索 + include 文件过滤。

```
Use grep_search to find all lines containing "import.*chalk" in the src/ directory
```

✅ 预期：返回 `src/agent.ts` 和/或 `src/ui.ts` 中的匹配行，格式为 `文件路径:行号:匹配内容`

```
Use grep_search to find the pattern "export function" in all .ts files under src/
```

✅ 预期：使用 `include: "*.ts"` 过滤，返回所有导出函数的位置

```
Use grep_search to find "DANGEROUS_PATTERNS" in the project
```

✅ 预期：返回 `src/tools.ts` 中的定义位置

---

### 18. Write File（新文件 + 自动建目录）

**测试目标**：验证文件创建、目录自动创建、内容预览截断。

```
Create a new file at test/tmp/nested/hello.txt with the content:
Line 1: Hello from Mini Claude
Line 2: This is a write test
Line 3: End of file
```

✅ 预期：
- 目录 `test/tmp/nested/` 自动创建
- 返回 `Successfully wrote to test/tmp/nested/hello.txt (3 lines)` 和行号预览

```
Read the file test/tmp/nested/hello.txt to verify.
```
✅ 预期：内容完整

测试长文件预览截断：
```
Create a file test/tmp/long-file.txt with 50 numbered lines like "Line 1: test data", etc.
```

✅ 预期：预览只显示前 30 行，末尾显示 `... (50 lines total)`

---

## Phase 6: 会话与 CLI (Test 14-16)

### 14. Session Resume（--resume）

**测试目标**：验证会话保存和跨进程恢复。

**第一次会话**：
```bash
node dist/cli.js --yolo          # TS 版
python -m mini_claude --yolo     # Python 版
```
```
Remember this: The secret code is BANANA-42. Read package.json and tell me the version.
```
然后 `exit` 退出。

**第二次会话（恢复）**：
```bash
node dist/cli.js --yolo --resume          # TS 版
python -m mini_claude --yolo --resume     # Python 版
```

✅ 预期：启动时显示 session restored 信息

```
What was the secret code I told you earlier?
```

✅ 预期：模型回答 `BANANA-42`

**对比（新会话）**：
```bash
node dist/cli.js --yolo          # TS 版
python -m mini_claude --yolo     # Python 版
```
```
What was the secret code I told you earlier?
```
✅ 预期：模型无法回答

**设计意图**：会话以 JSON 格式存储在 `~/.mini-claude/sessions/`，包含 Anthropic 和 OpenAI 两套消息历史（因为两个后端的消息格式不同）。`--resume` 自动找到最近的 session，恢复后继续对话。

---

### 15. One-shot 模式

**测试目标**：验证传入 prompt 参数时自动执行并退出。

```bash
# TS 版
node dist/cli.js --yolo "Read the file package.json and tell me the project name. Only output the name."
# Python 版
python -m mini_claude --yolo "Read the file package.json and tell me the project name. Only output the name."
```

✅ 预期：
- 模型调用 read_file，输出项目名称
- 程序**自动退出**（返回 shell prompt）

```bash
node dist/cli.js --yolo "List all TypeScript files in the src/ directory"
```

✅ 预期：输出 .ts 文件列表，然后自动退出

错误场景：
```bash
node dist/cli.js --yolo "Read the file /nonexistent/path/file.txt"
```
✅ 预期：工具返回错误信息，但程序不 crash，正常退出

---

### 16. 预算控制（--max-turns）

**测试目标**：验证 agent 循环次数限制。

```bash
# TS 版
node dist/cli.js --yolo --max-turns 2 "Read these files one by one: package.json, tsconfig.json, src/cli.ts, src/agent.ts, src/tools.ts. Tell me the line count of each."
# Python 版
python -m mini_claude --yolo --max-turns 2 "Read these files one by one: package.json, tsconfig.json, src/cli.ts, src/agent.ts, src/tools.ts. Tell me the line count of each."
```

✅ 预期：
- 模型开始读取文件，但在 2 个 agentic turn 后停止
- 输出包含预算超限提示
- **不会**读完所有 5 个文件

**设计意图**：预算控制有两个维度——`--max-cost`（USD 上限）和 `--max-turns`（循环次数上限）。每轮 agent 循环（一次 API 调用 + 工具执行）计为一个 turn。超限时模型被告知 budget exceeded 并停止。这防止 Agent 陷入无限循环烧钱。

---

## Phase 7: 扩展系统 (Test 19)

### 19. 自定义 Agent（.claude/agents/）

**测试目标**：验证用户定义的 agent 类型被正确发现和使用。

```
What agent types are available? List them all.
```

✅ 预期：列表中包含 explore、plan、general 和 **reviewer**

```
Use the agent tool with type "reviewer" to review the file src/frontmatter.ts
```

✅ 预期：
- 输出显示 `[sub-agent:reviewer]` 标记
- reviewer 只使用 read_file / list_files / grep_search（受 allowed-tools 限制）
- 返回代码审查结果

**设计意图**：自定义 agent 通过 `.claude/agents/*.md` 文件定义，frontmatter 指定名称、描述和允许使用的工具。这让用户可以创建专用 agent（代码审查、文档生成、测试编写等），不用改源码。Claude Code 同样支持用户级（`~/.claude/agents/`）和项目级（`.claude/agents/`）两层覆盖。

---

## 测试完成

```bash
bash test/cleanup.sh
```

清理所有测试产生的文件（MCP 配置、skills、rules、记忆文件、自定义 agent、临时文件等）。

---

## 快速对照表

| # | 功能 | 类别 | TS 通过 | PY 通过 | 备注 |
|---|------|------|:---:|:---:|------|
| 1 | MCP 工具调用 | 基础工具 | ☐ | ☐ | 3 个工具 |
| 2 | WebFetch | 基础工具 | ☐ | ☐ | httpbin.org |
| 3 | 并行工具执行 | 基础工具 | ☐ | ☐ | 多文件同时读 |
| 4 | 语义记忆召回 | 记忆上下文 | ☐ | ☐ | 保存→新对话→语义查询 |
| 5 | @include + Rules | 记忆上下文 | ☐ | ☐ | 中文回复 |
| 6 | Read-before-edit | 记忆上下文 | ☐ | ☐ | 代码层或 prompt 层 |
| 7 | 大结果持久化 | 记忆上下文 | ☐ | ☐ | 75KB 文件 |
| 8 | Skill 调用 | 技能扩展 | ☐ | ☐ | /greet /commit |
| 9 | ToolSearch | 技能扩展 | ☐ | ☐ | plan mode 工具 |
| 10 | REPL 命令 | 技能扩展 | ☐ | ☐ | /cost /memory /compact /plan |
| 11 | Sub-agent 系统 | Agent 架构 | ☐ | ☐ | explore/plan/general |
| 12 | Plan Mode | Agent 架构 | ☐ | ☐ | /plan 手动进入 + 审批 |
| 13 | 引号规范化 | 编辑搜索 | ☐ | ☐ | curly → straight quotes |
| 14 | Session Resume | 会话 CLI | ☐ | ☐ | --resume 恢复会话 |
| 15 | One-shot 模式 | 会话 CLI | ☐ | ☐ | 传 prompt 自动退出 |
| 16 | 预算控制 | 会话 CLI | ☐ | ☐ | --max-turns 限制 |
| 17 | Grep Search | 编辑搜索 | ☐ | ☐ | 正则搜索 + include |
| 18 | Write File | 编辑搜索 | ☐ | ☐ | 新文件 + 自动建目录 |
| 19 | 自定义 Agent | 扩展系统 | ☐ | ☐ | .claude/agents/ 定义 |
