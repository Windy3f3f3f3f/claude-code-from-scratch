# 14. Functional Testing Guide

## Chapter Goals

With the whole tutorial built, the agent is complete. This chapter writes no new code — it runs the agent end to end through 22 manual scenarios to confirm every piece works: tools, memory, skills, sub-agents, editing, sessions, autonomous continuation. Most run in `--yolo` mode (skipping permission confirmations); the three autonomy scenarios (Test 20-22) get their own section, and Auto Mode uses `--auto`.

```mermaid
graph LR
    Setup["bash test/setup.sh"] --> Build["npm run build (TS version)"]
    Build --> Test["Run tests one by one"]
    Test --> Cleanup["bash test/cleanup.sh"]

    style Setup fill:#7c5cfc,color:#fff
    style Test fill:#e8e0ff
```

## Automated Integration Tests (Complementing the Manual Scenarios)

The long list of **manual** acceptance scenarios below isn't the whole story. The repo also ships an **automated integration suite** that catches regressions as you edit: it starts a local mock model and drives the REAL REPL as a subprocess, feeding commands in and asserting the output — covering /goal, /loop, Auto Mode, streaming, permissions, multi-turn tool chains, and MCP, across BOTH the OpenAI and Anthropic backends and BOTH the TypeScript and Python implementations. No network, no key:

```bash
npm run check:full      # TS/Python unit + dual-backend integration (mock)
npm run test:live       # real-model smoke; runs only when .env has a key, else skips
```

`test:live` catches wire drift between the mock and the real API. The manual scenarios still matter: they cover the real model's judgment and the interaction feel that the automated asserts don't reach. The two complement each other rather than replace.

## Why Manual Testing Is Needed

Testing a coding agent is different from testing regular software -- core behavior depends on LLM responses, and output is non-deterministic. Automated unit tests can cover tool functions (file I/O, permission checks), but end-to-end Agent behavior can only be observed manually:

- Did the model choose the right tool?
- Is parallel execution actually parallel?
- Is semantic memory recall timing correct?
- Is the Plan Mode approval workflow interaction smooth?

Claude Code itself uses a similar strategy: core tools have unit tests, but Agent behavior relies on manual QA + evaluation suites (eval suite).

## Preparation

```bash
cd claude-code-from-scratch

# One-command setup for test environment (MCP, Skills, CLAUDE.md, large file, quote test file, custom Agent)
bash test/setup.sh

# Build TS version (Python version doesn't need building)
npm run build
```

Make sure `.env` has API keys configured:
```
ANTHROPIC_API_KEY=sk-xxx
ANTHROPIC_BASE_URL=https://aihubmix.com   # Optional
```

> **Tip**: If the system environment has both `OPENAI_API_KEY` + `OPENAI_BASE_URL` and `ANTHROPIC_API_KEY`,
> it will prefer the OpenAI-compatible path. Both paths support all features.

## How to Launch

**TS version**:
```bash
# Interactive REPL (recommended; can test skill, plan mode, and REPL commands)
node dist/cli.js --yolo

# One-shot mode
node dist/cli.js --yolo "your prompt"
```

**Python version**:
```bash
python -m mini_claude --yolo

# One-shot mode
python -m mini_claude --yolo "your prompt"
```

> The following test steps use the TS version in command-line examples. For the Python version, replace `node dist/cli.js` with `python -m mini_claude` -- functionality is identical.

---

## Phase 1: Basic Tools (Test 1-3)

### 1. MCP Tool Invocation

**Test objective**: Verify MCP server connection + tool discovery + transparent routing.

**Expected**: On startup, see `[mcp] Connected to 'test' — 3 tools`

```
Use the MCP 'add' tool to compute 17+25, then use the 'echo' tool to echo "hello MCP", then use the 'timestamp' tool.
```

Pass criteria:
- add returns `42`
- echo returns `hello MCP`
- timestamp returns a Unix timestamp
- Tool names have the `mcp__test__` prefix

**Design intent**: MCP is the core mechanism for extending Agent capabilities. The three-segment naming `mcp__server__tool` solves both naming conflicts and routing -- you can tell from the name which server to forward to.

---

### 2. WebFetch

**Test objective**: Verify HTTP fetching + HTML cleaning.

```
Fetch the URL https://httpbin.org/json and tell me the slideshow title.
```

Pass criteria: Returns `Sample Slide Show`

```
Fetch https://example.com and tell me what the page is about.
```

Pass criteria: Returns plain text content converted from HTML

---

### 3. Parallel Tool Execution

**Test objective**: Verify that concurrency-safe tools can execute simultaneously (not serially).

```
Read the files src/frontmatter.ts, src/session.ts, and src/skills.ts at the same time, then tell me each file's line count.
```

Python version alternative -- read Python files:
```
Read the files python/mini_claude/frontmatter.py and python/mini_claude/session.py at the same time, then tell me each file's line count.
```

Pass criteria: Multiple `read_file` calls appear simultaneously (not one after another)

**Design intent**: `CONCURRENCY_SAFE_TOOLS` (read_file, list_files, grep_search, web_fetch) are marked as parallelizable. The Agent starts executing these tools during the streaming output phase without waiting for the model to finish generating.

---

## Phase 2: Memory and Context (Test 4-7)

### 4. Semantic Memory Recall

**Test objective**: Verify memory saving -> semantic recall in a new conversation (async prefetch mechanism).

**Step 1: Save memories**
```
Save these memories for me:
1. type=project, name="API migration", description="Moving from REST to GraphQL", content="We are migrating our API from REST to GraphQL. Deadline is end of Q2 2025."
2. type=feedback, name="code style", description="Prefers functional programming", content="User prefers functional patterns (map/filter/reduce) over for loops and OOP."
3. type=reference, name="staging server", description="Staging environment URL", content="Staging server: https://staging.example.com, credentials in 1Password."
```

Pass criteria: Three memory files are written

**Step 2: Exit and start a new conversation**, then enter a query that triggers tool calls:

> **How it works**: Semantic recall uses async prefetch (consistent with Claude Code behavior, zero-wait non-blocking).
> Prefetch starts when the user message is sent and takes a few seconds to complete. If the model responds
> with text directly without calling tools, the loop runs only once and finishes before prefetch can be consumed.
> Therefore, test queries need to trigger tool calls to give prefetch enough time to be injected in the second iteration.

```
Read the file tsconfig.json, then tell me: where can I deploy to test my changes?
```
Pass criteria: Recalls the staging server memory, answers `https://staging.example.com`

```
List the files in the src/ directory, then tell me: what's the deadline for the backend rewrite?
```
Pass criteria: Recalls the API migration memory, answers `end of Q2 2025`

```
Read package.json, then tell me: how should I write code for this project?
```
Pass criteria: Recalls the code style memory, mentions functional programming

---

### 5. @include Directive + Rules Auto-Loading

**Test objective**: Verify CLAUDE.md's `@path` include directive and `.claude/rules/` auto-loading.

setup.sh has already created:
- `CLAUDE.md` containing `@./.claude/rules/chinese-greeting.md`
- Rule content: `When the user greets you, respond in Chinese`

```
Hello! Who are you?
```

Pass criteria: The model responds in **Chinese** (because the rule requires greeting in Chinese)

**Design intent**: The `@include` mechanism supports three formats: `@./relative-path`, `@~/home-path`, and `@/absolute-path`, with circular reference detection and a maximum depth limit (5 levels). All `.md` files in the rules directory are sorted alphabetically and concatenated into the system prompt.

---

### 6. Read-Before-Edit Protection

**Test objective**: Verify the safety check when editing an unread file.

```
Edit the file package.json and change the version to "9.9.9". Do NOT read it first.
```

Pass criteria (either counts as passing):
- **Best**: Tool layer directly returns `Error: You must read this file before editing`
- **Acceptable**: The model, prompted by the system prompt, automatically reads before editing

After testing, restore:
```
Now change it back to "1.0.0".
```

---

### 7. Large Result Persistence

**Test objective**: Verify that oversized tool results are written to disk + preview truncation.

```
Read the file test/large-file.txt
```

Pass criteria (output includes):
- `[Result too large (XX.X KB, 1000 lines). Full output saved to ...]`
- `Preview (first 200 lines):`
- Only the first 200 lines of preview are shown

Then continue asking:
```
What does line 500 say?
```

Pass criteria: The model uses grep_search or read_file to find the content of Line 499 from the original file

**Design intent**: Tool results exceeding 30KB are written to `~/.mini-claude/tool-results/`; only a preview is kept in the conversation. This prevents a single large file from blowing up the entire context window. Aligned with Claude Code's `LargeResultPersistence` logic.

---

## Phase 3: Skills and Tool Extensions (Test 8-10)

### 8. Skill Invocation

**Test objective**: Verify skill discovery, inline invocation, and slash commands.

```
/skills
```
Pass criteria: Lists the greet and commit skills

```
/greet Alice
```
Pass criteria: The model generates a personalized greeting for Alice

```
/commit
```
Pass criteria: The model runs git diff/status, then attempts to create a commit

---

### 9. ToolSearch / Lazy-Loaded Tools

**Test objective**: Verify the deferred tool mechanism -- plan mode tools initially don't send schemas and are only activated after being searched.

```
Use tool_search to find the "plan mode" tool.
```

Pass criteria:
- The model calls `tool_search`
- Returns the full schema for `enter_plan_mode` and/or `exit_plan_mode`
- These tools were not in the tool list before and are only activated after being searched

**Design intent**: Deferred tools reduce the size of tool schemas sent with each API call. Claude Code has 60+ tools, but most scenarios only use 5-6. Sending all schemas wastes tokens; lazy loading activates on demand.

---

### 10. REPL Commands

```
/cost
```
Pass criteria: Shows token usage and cost

```
/memory
```
Pass criteria: Lists saved memories

```
/compact
```
Pass criteria: Manually triggers conversation compression

```
/plan
```
Pass criteria: Switches to plan mode (enter again to switch back)

---

## Phase 4: Agent Architecture (Test 11-12)

### 11. Sub-Agent System (Agent Tool)

**Test objective**: Verify isolated execution and tool restrictions for the three built-in agent types.

**explore agent** (read-only search):
```
Use the agent tool with type "explore" to find all files that import from "./memory.js" in the src/ directory.
```

Pass criteria:
- Output shows the `[sub-agent:explore]` marker
- Returns a list of files referencing `memory.js`
- Only uses read_file / list_files / grep_search

**plan agent** (structured planning):
```
Use the agent tool with type "plan" to design a plan for adding a "help" REPL command. Identify which files need modification.
```

Pass criteria: Output shows the `[sub-agent:plan]` marker, returns a structured modification plan

**general agent** (full tools):
```
Use the agent tool with type "general" to create a file called /tmp/mini-claude-agent-test.txt with the content "agent test passed", then read it back.
```

Pass criteria:
- Output shows the `[sub-agent:general]` marker
- Successfully creates and reads the file
- Sub-agent token consumption is added to the main agent (visible in `/cost`)

**Design intent**: Sub-agents are Claude Code's "divide and conquer" strategy -- breaking large tasks into sub-agents, each with isolated context that doesn't pollute the main conversation. The explore agent is restricted to read-only tools to prevent accidental modifications; the general agent excludes the agent tool to prevent infinite recursion.

---

### 12. Plan Mode (Manual Entry)

**Test objective**: Verify `/plan` toggle + read-only restriction + plan file writing + approval workflow.

**Step 1: Enter plan mode**
```
/plan
```
Pass criteria: Shows that plan mode is enabled

**Step 2: Test read-only restriction**
```
Read package.json, then create a plan for changing the project name. Write your plan to the plan file.
```

Pass criteria:
- The model can read package.json (read tools are always allowed)
- The model writes to the plan file (the only file allowed for editing)
- If it tries to edit other files, it's rejected: `Blocked in plan mode`

**Step 3: Approval workflow**

After the model calls `exit_plan_mode`, 4 options appear:
1. Choose `4` (keep-planning), enter feedback: "Also add a step for updating README"
2. After the model revises the plan and calls exit_plan_mode again, choose `1` (clear-and-execute)

Pass criteria: After choosing 1, context is cleared and mode switches to execution

**Step 4: Exit plan mode**
```
/plan
```
Pass criteria: Switches back to normal mode

**Design intent**: Plan Mode is Claude Code's "think before you act" mechanism. Restricting to read-only + plan file writing prevents the model from making code changes during the planning phase. The four-option approval gives users control over the execution method -- they can keep context and execute (2), or clear context and execute (1), avoiding the plan content itself from consuming the token budget.

---

## Phase 5: Editing and Search (Test 13, 17-18)

### 13. Quote Normalization in Edit

**Test objective**: Verify edit_file's curly quote -> straight quote fallback matching.

```
Read the file test/quote-test.js
```

Then request an edit using curly quotes:
```
Use edit_file on test/quote-test.js. In the old_string, use curly double quotes (Unicode U+201C and U+201D) around "Hello World". Replace with straight quotes saying "Hi Universe".
```

Pass criteria:
- Edit succeeds, output includes `(matched via quote normalization)`
- File content changes from `"Hello World"` to `"Hi Universe"`

After testing, restore:
```
Edit test/quote-test.js, replace "Hi Universe" with "Hello World"
```

**Design intent**: LLM output and text copied from documents often contain Unicode curly quotes (`""`, `''`). Claude Code's `normalizeQuotes` function first attempts an exact match, then normalizes both sides to straight quotes on failure, avoiding the common "can't find content to replace" error.

---

### 17. Grep Search Tool

**Test objective**: Verify regex search + include file filtering.

```
Use grep_search to find all lines containing "import.*chalk" in the src/ directory
```

Pass criteria: Returns matching lines from `src/agent.ts` and/or `src/ui.ts` in the format `filepath:line_number:matched_content`

```
Use grep_search to find the pattern "export function" in all .ts files under src/
```

Pass criteria: Uses `include: "*.ts"` filter, returns locations of all exported functions

```
Use grep_search to find "DANGEROUS_PATTERNS" in the project
```

Pass criteria: Returns the definition location in `src/tools.ts`

---

### 18. Write File (New File + Auto Directory Creation)

**Test objective**: Verify file creation, automatic directory creation, and content preview truncation.

```
Create a new file at test/tmp/nested/hello.txt with the content:
Line 1: Hello from Mini Claude
Line 2: This is a write test
Line 3: End of file
```

Pass criteria:
- Directory `test/tmp/nested/` is automatically created
- Returns `Successfully wrote to test/tmp/nested/hello.txt (3 lines)` with line number preview

```
Read the file test/tmp/nested/hello.txt to verify.
```
Pass criteria: Content is complete

Test long file preview truncation:
```
Create a file test/tmp/long-file.txt with 50 numbered lines like "Line 1: test data", etc.
```

Pass criteria: Preview shows only the first 30 lines, with `... (50 lines total)` at the end

---

## Phase 6: Session and CLI (Test 14-16)

### 14. Session Resume (--resume)

**Test objective**: Verify session saving and cross-process restoration.

**First session**:
```bash
node dist/cli.js --yolo          # TS version
python -m mini_claude --yolo     # Python version
```
```
Remember this: The secret code is BANANA-42. Read package.json and tell me the version.
```
Then `exit` to quit.

**Second session (resume)**:
```bash
node dist/cli.js --yolo --resume          # TS version
python -m mini_claude --yolo --resume     # Python version
```

Pass criteria: On startup, shows session restored information

```
What was the secret code I told you earlier?
```

Pass criteria: The model answers `BANANA-42`

**Comparison (new session)**:
```bash
node dist/cli.js --yolo          # TS version
python -m mini_claude --yolo     # Python version
```
```
What was the secret code I told you earlier?
```
Pass criteria: The model cannot answer

**Design intent**: Sessions are stored in JSON format in `~/.mini-claude/sessions/`, containing both Anthropic and OpenAI message histories (because the two backends have different message formats). `--resume` automatically finds the most recent session and continues the conversation from there.

---

### 15. One-Shot Mode

**Test objective**: Verify that when a prompt argument is passed, it executes automatically and exits.

```bash
# TS version
node dist/cli.js --yolo "Read the file package.json and tell me the project name. Only output the name."
# Python version
python -m mini_claude --yolo "Read the file package.json and tell me the project name. Only output the name."
```

Pass criteria:
- The model calls read_file, outputs the project name
- The program **exits automatically** (returns to shell prompt)

```bash
node dist/cli.js --yolo "List all TypeScript files in the src/ directory"
```

Pass criteria: Outputs the .ts file list, then exits automatically

Error scenario:
```bash
node dist/cli.js --yolo "Read the file /nonexistent/path/file.txt"
```
Pass criteria: The tool returns an error message, but the program doesn't crash and exits normally

---

### 16. Budget Control (--max-turns)

**Test objective**: Verify agent loop iteration limits.

```bash
# TS version
node dist/cli.js --yolo --max-turns 2 "Read these files one by one: package.json, tsconfig.json, src/cli.ts, src/agent.ts, src/tools.ts. Tell me the line count of each."
# Python version
python -m mini_claude --yolo --max-turns 2 "Read these files one by one: package.json, tsconfig.json, src/cli.ts, src/agent.ts, src/tools.ts. Tell me the line count of each."
```

Pass criteria:
- The model starts reading files but stops after 2 agentic turns
- Output includes a budget exceeded message
- Does **not** finish reading all 5 files

**Design intent**: Budget control has two dimensions -- `--max-cost` (USD limit) and `--max-turns` (loop iteration limit). Each agent loop (one API call + tool execution) counts as one turn. When the limit is exceeded, the model is told "budget exceeded" and stops. This prevents the Agent from entering infinite loops and burning money.

---

## Phase 7: Extension System (Test 19)

### 19. Custom Agent (.claude/agents/)

**Test objective**: Verify that user-defined agent types are correctly discovered and used.

```
What agent types are available? List them all.
```

Pass criteria: The list includes explore, plan, general, and **reviewer**

```
Use the agent tool with type "reviewer" to review the file src/frontmatter.ts
```

Pass criteria:
- Output shows the `[sub-agent:reviewer]` marker
- The reviewer only uses read_file / list_files / grep_search (restricted by allowed-tools)
- Returns a code review result

**Design intent**: Custom agents are defined via `.claude/agents/*.md` files, with frontmatter specifying name, description, and allowed tools. This lets users create specialized agents (code review, documentation generation, test writing, etc.) without modifying source code. Claude Code similarly supports both user-level (`~/.claude/agents/`) and project-level (`.claude/agents/`) two-layer override.

---

## Phase 8: Autonomy & Continuation (Test 20-22)

The trio added in Chapter 15 needs its own verification, because these run across many turns and Auto Mode uses `--auto` rather than `--yolo`.

### 20. `/goal` Reinjection and Completion

**Test goal**: verify that an unmet condition is reinjected into the next turn, and that the goal is cleared and stopped once met.

In the REPL, set a condition reachable within a couple of turns:

```
/goal Create a hello.txt in the project root with the content GOALPROBE
```

✅ Expected:
- After setting the goal, the agent briefly acknowledges, then starts working immediately
- Each turn is judged by the evaluator; if unmet, it prints `condition was not met: <reason>` and continues
- Once the file exists with matching content, the evaluator returns `ok`, prints completion, and clears the goal
- Then set an impossible condition (e.g. `/goal Download and install a GUI over the network`) and watch the evaluator return `impossible` and brake on its own, rather than spinning until the budget runs out

### 21. `/loop` Two Cadences

**Test goal**: verify both the interval (timed re-submit) and dynamic (self-paced) paths.

```
/loop 1m Check whether src/ has any new .ts files
```

✅ Expected: prints `Scheduled every 1m (session-only)`; wait one tick to see it re-submit once; Ctrl+C to stop.

```
/loop Read out the README's title
```

✅ Expected: in dynamic mode the agent judges once, completes, schedules no next wakeup, and exits cleanly.

### 22. Auto Mode Blocks a Dangerous Operation

**Test goal**: verify that under `--auto`, read-only tools pass via the fast-path while a dangerous write operation is blocked by the classifier.

Start with `--auto` (**not `--yolo`**), first run a read-only task (like "list the files under src/") — it should pass straight through with no confirmation prompt. Then have it run:

```
git push origin main
```

✅ Expected:
- Read-only tools (read_file / grep_search, etc.) take the fast-path, skipping the classifier
- `git push origin main` triggers the classifier, hits a "don't push" rule, and is blocked with a `reason` that starts with the rule name
- When the classifier output can't be parsed, it fails closed (treated as a block); hitting the denial limit falls back to manual confirmation

**Design intent**: Auto Mode replaces the confirmation prompt for dangerous operations with a classifier that reads a reasoning-blind transcript, so continuation turns don't need someone watching. Details are in [Chapter 15](15-autonomy.md).

---

## Testing Complete

```bash
bash test/cleanup.sh
```

Cleans up all test-generated files (MCP config, skills, rules, memory files, custom agents, temporary files, etc.).

---

## Quick Reference Table

| # | Feature | Category | TS Pass | PY Pass | Notes |
|---|---------|----------|:-------:|:-------:|-------|
| 1 | MCP tool invocation | Basic tools | ☐ | ☐ | 3 tools |
| 2 | WebFetch | Basic tools | ☐ | ☐ | httpbin.org |
| 3 | Parallel tool execution | Basic tools | ☐ | ☐ | Multi-file simultaneous read |
| 4 | Semantic memory recall | Memory & context | ☐ | ☐ | Save -> new conversation -> semantic query |
| 5 | @include + Rules | Memory & context | ☐ | ☐ | Chinese response |
| 6 | Read-before-edit | Memory & context | ☐ | ☐ | Code layer or prompt layer |
| 7 | Large result persistence | Memory & context | ☐ | ☐ | ~68KB file |
| 8 | Skill invocation | Skills & extensions | ☐ | ☐ | /greet /commit |
| 9 | ToolSearch | Skills & extensions | ☐ | ☐ | Plan mode tools |
| 10 | REPL commands | Skills & extensions | ☐ | ☐ | /cost /memory /compact /plan |
| 11 | Sub-agent system | Agent architecture | ☐ | ☐ | explore/plan/general |
| 12 | Plan Mode | Agent architecture | ☐ | ☐ | /plan manual entry + approval |
| 13 | Quote normalization | Editing & search | ☐ | ☐ | curly -> straight quotes |
| 14 | Session Resume | Session & CLI | ☐ | ☐ | --resume restore session |
| 15 | One-shot mode | Session & CLI | ☐ | ☐ | Pass prompt, auto exit |
| 16 | Budget control | Session & CLI | ☐ | ☐ | --max-turns limit |
| 17 | Grep Search | Editing & search | ☐ | ☐ | Regex search + include |
| 18 | Write File | Editing & search | ☐ | ☐ | New file + auto directory creation |
| 19 | Custom Agent | Extension system | ☐ | ☐ | .claude/agents/ definition |
| 20 | `/goal` reinjection & completion | Autonomy | ☐ | ☐ | unmet reinjection + impossible brake |
| 21 | `/loop` two cadences | Autonomy | ☐ | ☐ | interval timer + dynamic convergence |
| 22 | Auto Mode blocking | Autonomy | ☐ | ☐ | `--auto`, blocks git push |
