# 13. Architecture Comparison and What's Next

> ℹ️ **About the comparison tables in this chapter**: The "Architecture Comparison" and "File Mapping" below are meant to help readers build a conceptual correspondence between **our roughly 5,500-line (TS) / 5,000-line (Python) minimal implementation** and **a production-grade coding agent like Claude Code**.
> This project is an **independent clean-room educational implementation** -- the code does not come from Claude Code's internal implementation, and all comparisons are analogies for learning and further research only. Specific details may differ from Claude Code's real internals.

Starting from Chapter 1's chat-only loop, we've built all the way up to an agent that reads code, edits files, runs tests, and even runs autonomously — the whole foundation is done. This chapter lays it side by side with the real Claude Code, to see what the minimal build left out, what the production one adds, and where to go from here.

## Full Architecture Comparison

| Component | Claude Code | mini-claude | Difference |
|-----------|------------|-------------|------------|
| **Agent Loop** | 7 continue reasons | Only checks tool_use | Simplified loop control |
| **Tool count** | 66+ tools | 12 resident tools (6 core + web_fetch + tool_search + skill + agent + 2 plan mode), plus `schedule_wakeup` temporarily during `/loop` dynamic | Removed specialized tools |
| **Tool execution** | Concurrent execution + streaming early start | Parallel execution + streaming early start | Architecture aligned |
| **API backend** | Anthropic only | Anthropic + OpenAI compatible | Added OpenAI |
| **System Prompt** | static/dynamic split + API caching | static/dynamic split + cache_control breakpoint | Architecture aligned |
| **Permission system** | 7 layers + AST analysis + 8-level rule sources | 6 modes + rule config + regex + confirmation/Auto classifier | Layer alignment |
| **Context management** | 4-level compression pipeline | 4 layers (budget + snip + microcompact + summary) | Architecture aligned |
| **Memory system** | 4 types + semantic recall + MEMORY.md index | 4 types + semantic recall + MEMORY.md + async prefetch | Architecture aligned |
| **Skills system** | 6 sources + lazy loading + inline/fork | 2 sources + preloading + inline/fork | Removed advanced loading |
| **Multi-Agent** | Sub-Agent + custom + Coordinator + Swarm | Sub-Agent (3 built-in + custom) | Removed Coordinator/Swarm |
| **MCP integration** | mcpClient.ts + dynamic tool discovery | McpManager + JSON-RPC over stdio | Architecture aligned |
| **Budget control** | USD/turns/abort three-dimensional budget | USD + turn limits | Removed abort signal |
| **Edit validation** | 14-step pipeline | Quote normalization + uniqueness + diff output | Kept core steps |

## File Mapping Table

| mini-claude (TypeScript) | mini-claude (Python) | Claude Code Source | Description |
|------------|------------|-------------------|-------------|
| `src/agent.ts` | `python/mini_claude/agent.py` | `src/query.ts` + `src/QueryEngine.ts` | Agent loop + session management |
| `src/tools.ts` | `python/mini_claude/tools.py` | `src/Tool.ts` + `src/tools/` (66 directories) | Tool definitions and execution |
| `src/prompt.ts` | `python/mini_claude/prompt.py` | `src/constants/prompts.ts` + `src/utils/claudemd.ts` | Prompt construction |
| `src/cli.ts` | `python/mini_claude/__main__.py` | `src/entrypoints/cli.tsx` + `src/commands/` | Entry point and commands |
| `src/ui.ts` | `python/mini_claude/ui.py` | `src/components/` (React/Ink components) | UI rendering |
| `src/session.ts` | `python/mini_claude/session.py` | `src/utils/sessionStorage.ts` + `src/history.ts` | Session persistence |
| `src/memory.ts` | `python/mini_claude/memory.py` | `src/utils/memory.ts` + system prompt injection | Memory system |
| `src/skills.ts` | `python/mini_claude/skills.py` | `src/utils/skills.ts` + `src/tools/SkillTool/` | Skills system |
| `src/subagent.ts` | `python/mini_claude/subagent.py` | `src/tools/AgentTool/` (built-in types) | Sub-agent type configuration |
| `src/mcp.ts` | `python/mini_claude/mcp_client.py` | `src/services/mcpClient.ts` | MCP client |

## What We Didn't Implement

### Hooks (Hook System)

Claude Code has 25 hook events and 6 hook types, allowing custom logic to be inserted before and after tool execution -- intercepting dangerous operations, recording audit logs, automatically running lint checks. It's the key mechanism that transforms Claude Code from a "tool" into a "platform."

Why we didn't implement it: The core challenge isn't "calling a function" but hook discovery and loading, error isolation, and the stdin/stdout JSON data protocol. These engineering details amount to about 500-800 lines but don't help with understanding agent principles.

### Coordinator / Swarm Multi-Agent Modes

We implemented Sub-Agent (fork-return). Claude Code has two additional modes: **Coordinator** breaks large tasks into pieces for multiple specialized Agents, and **Swarm** allows multiple Agents to communicate as peers and explore in parallel. Both modes solve the task decomposition problem when a single Agent's context isn't enough.

Why we didn't implement them: The core challenge is task decomposition accuracy and inter-Agent communication protocol design -- more of a prompt engineering problem than a code architecture problem. The implementation itself isn't complex, but making it truly useful requires extensive prompt tuning.

### LSP Integration

LSP gives the agent millisecond-level type error feedback after editing files, without waiting for a full compile/test cycle. In large projects, this can reduce the number of iterations needed to fix a bug by 30-50%.

Why we didn't implement it: Requires managing LSP server processes, implementing the client protocol (initialization handshake, capability negotiation, incremental sync) -- 1000+ lines and depends on deep understanding of the LSP protocol. Getting error feedback through shell commands (`tsc --noEmit`, `python -m py_compile`) is sufficient for tutorial scenarios.

### Bash AST Security Analysis

Claude Code uses tree-sitter to parse shell command ASTs, performing 23 static security checks that can analyze dangerous commands within pipe combinations -- something pure regex can't do.

Why we didn't implement it: tree-sitter is a native C/C++ library requiring a `node-gyp` build environment, creating too high an environmental barrier. Regex matching covers 80% of common dangerous patterns, and the risk is acceptable for tutorial scenarios.

## Progressive Enhancement Roadmap

### Phase 1: Prefix Caching (Done)

Prompt Caching has now been added the way Claude Code does it; details are in [Chapter 7: Prefix Caching](/en/docs/07-context.md). The approach marks the static portion of the system prompt with `cache_control: { type: "ephemeral" }` and rolls a breakpoint onto the last message; a cache-hit prefix is billed at 0.1x. From the second turn onward in a multi-turn conversation, the accumulated system prompt, tool definitions, and history messages are mostly read from cache, and only the newest increment needs to be reprocessed.

### The Autonomy Trio (Done)

`/goal`, `/loop`, and Auto Mode have also been added; details are in [Chapter 15: Autonomy & Continuation](/en/docs/15-autonomy.md). They let the agent keep moving across many turns with nobody watching: `/goal` chases a stopping condition with an independent evaluator until it is met or judged impossible, `/loop` lets the main model schedule its next run on an interval or at a self-chosen pace, and Auto Mode replaces the confirmation prompt for dangerous actions with a classifier that reads a reasoning-blind transcript. The prompts are quoted verbatim from the leaked binary; a few teaching simplifications are made along the way (the two-stage classification flow is reproduced, minus the real client's stop_sequences / thinking-token details; an in-session timer instead of KAIROS) -- the "Extension Directions" further down that originally sketched such capabilities can be read against Chapter 15 to see how far they are now realized.

### Phase 2: Extensibility (3-5 days)

| Enhancement | Problem Solved | Estimated Code |
|-------------|---------------|----------------|
| Hook system | Customizing agent behavior requires modifying source code | ~300 lines |
| Tool type system | switch/case doesn't scale to 20+ tools | ~200 lines |

The core transition is **from hardcoded to plugin-based**. The current switch/case works fine at 10 tools, but beyond 20 you need to introduce a Tool interface (or Python's Protocol/ABC), making each tool an independent module.

### Phase 3: Reliability and Security (1-2 weeks)

| Enhancement | Problem Solved | Estimated Code |
|-------------|---------------|----------------|
| 7 error recovery strategies | Currently crashes on errors | ~400 lines |
| Bash AST security analysis | Regex misses complex dangerous commands | ~600 lines |

Claude Code's `query.ts` has 1728 lines, most of which handle edge cases: auto-compress and retry on Prompt Too Long, exponential backoff on API overload, feed tool failures back to the model so it can self-repair.

### Phase 4: Advanced Agent Capabilities (2-4 weeks)

| Enhancement | Problem Solved | Estimated Code |
|-------------|---------------|----------------|
| Coordinator mode | Large tasks exceed single Agent context capacity | ~500 lines |
| Swarm mode | Exploratory tasks need multi-path parallelism | ~600 lines |
| LSP integration | Type errors can only be found through compilation | ~1000 lines |

## Extension Directions

### 1. Hooks System

The simplest approach is command hooks -- spawn a shell child process before `executeTool`, pass tool information via stdin JSON, and parse stdout JSON to decide allow/deny.

Configuration example:
```json
{
  "hooks": {
    "PreToolUse": [
      { "matcher": "run_shell", "command": "./hooks/pre-shell.sh" }
    ]
  }
}
```

Core logic: iterate over matching hooks, spawn child processes passing JSON, and decide whether to continue execution based on `{"action": "allow"}` / `{"action": "deny", "reason": "..."}`. About 300 lines; the most time-consuming part is handling child process timeouts and crashes.

### 2. Error Self-Repair

Feed tool execution errors back to the model as tool results instead of breaking the loop. The model can often self-repair: wrong path, try a different path; wrong command arguments, fix the arguments.

```typescript
try {
  result = await executeToolImpl(name, input);
} catch (e) {
  result = `Error: ${e.message}\n\nPlease try a different approach.`;
}
// Return result as tool_result to the model
```

About 50-80 lines, but significantly improves the agent's real-world usability -- this is one of Claude Code's smartest designs.

## Core Insights

**1. An Agent is essentially a while loop**

```
while true:
    response = llm.call(messages)
    if no tool_calls in response: break
    for tool_call in response.tool_calls:
        result = execute(tool_call)
        messages.append(result)
```

All the complexity -- permissions, context management, memory, multi-agent -- is enhancement and protection built around this loop.

**2. Prompts are the cheapest code**

A single sentence in the system prompt has the same effect as an if statement, with an implementation cost of 0 lines of code. In agent development, the optimal solution for many behavioral issues isn't writing more code but writing better prompts -- more flexible, easier to modify, and readable by non-technical people.

**3. Tool design determines the capability ceiling**

Let the model do what it's good at (understanding intent, generating code), and let tools do what the model isn't good at (exact string matching, filesystem operations, process management). `edit_file` is the classic example: the model generates the content to replace, and the tool handles precisely locating and replacing it in the file.

**4. Context management is the agent's "memory"**

Context management is to an agent what memory management is to an operating system -- using limited resources to provide the illusion of "infinite." The 4-layer compression pipeline lets the agent maintain memory of long conversations within a finite window.

**5. Security is not an afterthought**

Permission checking is a step in the agent loop, not a bolted-on middleware. No tool can bypass it. More importantly, it uses a fail-closed design: if a new tool forgets to declare its permission level, it's automatically treated as "requires confirmation" -- the system guarantees safety through defaults.

**6. The gap from 3,000 lines to 500,000 lines is edge cases**

Most of Claude Code's additional code handles: cross-environment compatibility, network and API unreliability, user input diversity, enterprise-grade auditing and access control. These "boring" pieces of code don't appear in architecture diagrams, yet they're the key to whether a tool can run reliably in the real world. From prototype to product, 80% of the distance is here.

**7. The collaboration boundary between LLM and code**

The most essential skill in building a coding agent: designing the right collaboration boundary between the LLM and code. What does the LLM decide, and what does the code decide? When the boundary is well-drawn, the agent is both flexible and reliable. Every design decision in this tutorial reflects this principle: the model decides "what to do," and the code ensures "it's done safely."

## Cross-Reference

Want to dive deeper into the design principles of each Claude Code module? Check out the detailed documentation in the companion project:

| Topic | This Tutorial | how-claude-code-works |
|-------|--------------|----------------------|
| Agent loop | [Ch1: Agent Loop](/en/docs/01-agent-loop.md) | [System Main Loop](https://windy3f3f3f3f.github.io/how-claude-code-works/#/docs/02-agent-loop) |
| Tool system | [Ch2: Tool System](/en/docs/02-tools.md) | [Tool System](https://windy3f3f3f3f.github.io/how-claude-code-works/#/docs/04-tool-system) |
| Context management | [Ch7: Context Management](/en/docs/07-context.md) | [Context Engineering](https://windy3f3f3f3f.github.io/how-claude-code-works/#/docs/03-context-engineering) |
| Permission security | [Ch6: Permissions and Security](/en/docs/06-permissions.md) | [Permissions and Security](https://windy3f3f3f3f.github.io/how-claude-code-works/#/docs/10-permission-security) |
| Memory system | [Ch8: Memory System](/en/docs/08-memory.md) | [Memory System](https://windy3f3f3f3f.github.io/how-claude-code-works/#/docs/08-memory-system) |
| Skills system | [Ch9: Skills System](/en/docs/09-skills.md) | [Skills System](https://windy3f3f3f3f.github.io/how-claude-code-works/#/docs/09-skills-system) |
| Plan Mode | [Ch10: Plan Mode](/en/docs/10-plan-mode.md) | -- |
| Multi-Agent | [Ch11: Multi-Agent](/en/docs/11-multi-agent.md) | [Multi-Agent Architecture](https://windy3f3f3f3f.github.io/how-claude-code-works/#/docs/07-multi-agent) |
| MCP integration | [Ch12: MCP Integration](/en/docs/12-mcp.md) | -- |
| Autonomy & continuation | [Ch15: Autonomy & Continuation](/en/docs/15-autonomy.md) | [Autonomy /goal /loop](https://windy3f3f3f3f.github.io/how-claude-code-works/#/en/docs/17-autonomy-goal-loop) · [Auto Mode](https://windy3f3f3f3f.github.io/how-claude-code-works/#/en/docs/18-auto-mode) · [Dynamic Workflows](https://windy3f3f3f3f.github.io/how-claude-code-works/#/en/docs/19-dynamic-workflows) |

---

## Conclusion

~5500 lines (TS) / ~5060 lines (Python), 12 TS files + 13 Python files, covering the core components, advanced capabilities, and autonomous operation of a coding agent:

**Phase 1 -- Core Components:** Agent Loop, Tool System (12 resident tools + mtime protection + lazy loading + parallel execution), System Prompt (Markdown template + @include + environment injection), CLI / Session (REPL + JSON persistence), Streaming Output (Anthropic + OpenAI dual backend + streaming tool execution), Permission Security (the 5 base modes from Phase 1 + declarative rules + regex + confirmation, with Auto Mode added in Phase 3), Context Management (4-layer compression + large result persistence)

**Phase 2 -- Advanced Capabilities:** Memory System (semantic recall + async prefetch), Skills System (inline/fork dual mode), Plan Mode (read-only planning + 4-option approval), Multi-Agent (Sub-Agent + 3 built-in types + custom), MCP Integration (JSON-RPC over stdio), Budget Control

**Phase 3 -- Autonomous Operation:** `/goal` (an evaluator chases the stopping condition to the end + impossible brake), `/loop` (interval scheduling + dynamic self-pacing + `schedule_wakeup`), Auto Mode (transcript-classifier permission gate + reasoning-blind projection + fail-closed + denial fallback)

A huge amount of the code in Claude Code's 500,000 lines is edge case handling and enterprise-grade reliability. But the core agent capabilities -- understand user intent -> call tools to manipulate code -> iterate until complete -- are exactly what these few thousand lines do.

At this point a complete minimal coding agent has taken shape, and the design intent behind every line of its code has been laid out. Further extensions can move forward step by step along the routes above.
