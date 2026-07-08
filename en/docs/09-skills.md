# 9. Skills System

## Chapter Goals

Some prompts get reused constantly — the "read the diff, write a commit message, commit" routine is tedious to retype every time. This chapter builds the agent a skills system that packages such prompts into modules you can invoke on demand.

A skill is a file: a prompt plus a few lines of metadata (name, when to use it, which tools it may use). One `/commit` invokes it, install-and-use like a shell script. Invocation comes in two flavors: inline splices the prompt into the current conversation, and fork hands it to a clean sub-agent to run on its own.

```mermaid
graph TB
    subgraph Skills System
        Discover[Scan .claude/skills/] --> Parse[Parse SKILL.md<br/>frontmatter + template]
        Parse --> Inject[Inject into system prompt<br/>skills variable]
        Parse --> Invoke{Invocation method}
        Invoke -->|User /name| REPL[CLI direct execution]
        Invoke -->|Model decides| Tool[skill tool call]
    end

    subgraph Shared Foundation
        FM[frontmatter.ts<br/>YAML parse/serialize]
    end

    Parse -.-> FM

    style FM fill:#7c5cfc,color:#fff
    style Inject fill:#e8e0ff
```

> ▶ **Run this chapter**: `node steps/run.mjs 9` (no API key) — watch `/commit` invoke a skill. Add `--diff` to see what it added over the previous chapter.

---

## Our Implementation

Some prompts get reused constantly — the "read the diff, write a commit message" routine is tedious to retype. This chapter gives the agent skills: save such a prompt as a file and invoke it with `/commit`, install-and-use like a shell script. Relative to last chapter, it adds a `skills.ts`, and the CLI turns a `/name` into that skill's prompt:

<!-- @diff file=cli.ts step=9 lang=ts -->
```diff
@@ -3,4 +3,5 @@ import { pathToFileURL } from "url";
 import { Agent } from "./agent.js";
 import { saveSession, loadSession } from "./session.js";
+import { resolveSkill } from "./skills.js";
 
 // A tiny REPL: read a line, hand it to the agent, repeat. One-shot mode runs a
@@ -24,5 +25,6 @@ export async function runCli(argv: string[] = process.argv.slice(2)): Promise<vo
   const oneShot = argv.join(" ").trim();
   if (oneShot) {
-    const input = oneShot;
+    // "/name ..." runs a skill's prompt template; anything else is a plain message.
+    const input = resolveSkill(oneShot) ?? oneShot;
     await agent.chat(input);
     saveSession(agent.history());
@@ -38,5 +40,5 @@ export async function runCli(argv: string[] = process.argv.slice(2)): Promise<vo
         if (input === "exit" || input === "quit") { rl.close(); resolve(); return; }
         if (input === "/clear") { agent.clearHistory(); saveSession(agent.history()); console.log("(history cleared)"); ask(); return; }
-        if (input) await agent.chat(input);
+        if (input) await agent.chat(resolveSkill(input) ?? input);
         if (input) saveSession(agent.history());
         ask();
```
<!-- @enddiff -->

A skill is just a file; resolving one is "if it starts with `/`, find the same-named file under `.mini-skills/` and read its prompt":

<!-- tabs:start -->
#### **TypeScript**
<!-- @snippet lang=ts file=skills.ts region=skill step=9 -->
```typescript
export function resolveSkill(input: string): string | null {
  if (!input.startsWith("/")) return null;
  const [name, ...rest] = input.slice(1).split(" ");
  const file = join(SKILLS_DIR, `${name}.md`);
  if (!existsSync(file)) return null;
  const prompt = readFileSync(file, "utf-8").trim();
  const args = rest.join(" ").trim();
  return args ? `${prompt}\n\n${args}` : prompt;
}
```
<!-- @endsnippet -->
#### **Python**
<!-- @snippet lang=py file=skills.py region=skill step=9 -->
```python
def resolve_skill(text):
    if not text.startswith("/"):
        return None
    name, _, rest = text[1:].partition(" ")
    path = os.path.join(SKILLS_DIR, f"{name}.md")
    if not os.path.exists(path):
        return None
    prompt = open(path, encoding="utf-8").read().strip()
    args = rest.strip()
    return f"{prompt}\n\n{args}" if args else prompt
```
<!-- @endsnippet -->
<!-- tabs:end -->

Run it: `.mini-skills/commit.md` holds a commit-writing prompt, and `/commit` invokes it:

<!-- @transcript step=9 lang=ts -->
```
$ node steps/run.mjs 9
▶ step 9 demo (no API key — local mock model)   sandbox: <sandbox>
  $ mini-claude /commit

feat: add the new thing
```
<!-- @endtranscript -->

> That is the whole runnable step for this chapter — everything `node steps/run.mjs` actually executes here is above. Below is how the repo's production mini-claude does the same thing in full: more edge cases and engineering detail. Read it as an **optional deep-dive**; it is not the code the runnable step runs.

### SKILL.md Format

```markdown
---
name: commit
description: Create a git commit with a descriptive message
when_to_use: When the user asks to commit changes or says "commit"
allowed-tools: run_shell, read_file
user-invocable: true
---
Look at the current git diff and staged changes. Write a clear, concise
commit message following conventional commits format.

The user's request: $ARGUMENTS

Project skill directory: ${CLAUDE_SKILL_DIR}
```

- `when_to_use`: Trigger condition shown to the model, which decides whether to auto-invoke based on this
- `allowed-tools`: Security boundary, limiting which tools the skill can use
- `user-invocable`: Skills with `false` can only be triggered automatically by the model

### Discovery and Loading

```mermaid
flowchart LR
    U["~/.claude/skills/*"] -->|Lower priority| Map["Map<name, Skill>"]
    P[".claude/skills/*"] -->|Higher priority override| Map
    Map --> Cache["cachedSkills[]"]
```

<!-- tabs:start -->
#### **TypeScript**
```typescript
// skills.ts -- discoverSkills

let cachedSkills: SkillDefinition[] | null = null;

export function discoverSkills(): SkillDefinition[] {
  if (cachedSkills) return cachedSkills;

  const skills = new Map<string, SkillDefinition>();

  loadSkillsFromDir(join(homedir(), ".claude", "skills"), "user", skills);
  loadSkillsFromDir(join(process.cwd(), ".claude", "skills"), "project", skills);

  cachedSkills = Array.from(skills.values());
  return cachedSkills;
}
```
#### **Python**
```python
# skills.py -- discover_skills

_cached_skills: list[SkillDefinition] | None = None


def discover_skills() -> list[SkillDefinition]:
    global _cached_skills
    if _cached_skills is not None:
        return _cached_skills

    skills: dict[str, SkillDefinition] = {}

    _load_skills_from_dir(Path.home() / ".claude" / "skills", "user", skills)
    _load_skills_from_dir(Path.cwd() / ".claude" / "skills", "project", skills)

    _cached_skills = list(skills.values())
    return _cached_skills
```
<!-- tabs:end -->

Using a Map for deduplication naturally implements "project-level overrides user-level" -- load user first, then project; same-name keys get overwritten by the latter. Claude Code has 6 sources because it needs to support enterprise and MCP scenarios; project + user covers the core needs of individual developers.

### Skill Parsing

<!-- tabs:start -->
#### **TypeScript**
```typescript
// skills.ts -- parseSkillFile

function parseSkillFile(
  filePath: string, source: "project" | "user", skillDir: string
): SkillDefinition | null {
  const raw = readFileSync(filePath, "utf-8");
  const { meta, body } = parseFrontmatter(raw);

  const name = meta.name || skillDir.split("/").pop() || "unknown";
  const userInvocable = meta["user-invocable"] !== "false";

  let allowedTools: string[] | undefined;
  if (meta["allowed-tools"]) {
    const raw = meta["allowed-tools"];
    if (raw.startsWith("[")) {
      try { allowedTools = JSON.parse(raw); } catch {
        allowedTools = raw.replace(/[\[\]]/g, "").split(",").map((s) => s.trim());
      }
    } else {
      allowedTools = raw.split(",").map((s) => s.trim());
    }
  }

  return {
    name, description: meta.description || "",
    whenToUse: meta.when_to_use || meta["when-to-use"],
    allowedTools, userInvocable,
    promptTemplate: body, source, skillDir,
  };
}
```
#### **Python**
```python
# skills.py -- _parse_skill_file

def _parse_skill_file(
    file_path: Path, source: str, skill_dir: str
) -> SkillDefinition | None:
    try:
        raw = file_path.read_text()
        result = parse_frontmatter(raw)
        meta = result.meta

        name = meta.get("name") or file_path.parent.name or "unknown"
        user_invocable = meta.get("user-invocable", "true") != "false"
        context = "fork" if meta.get("context") == "fork" else "inline"

        allowed_tools: list[str] | None = None
        if "allowed-tools" in meta:
            raw_tools = meta["allowed-tools"]
            if raw_tools.startswith("["):
                try:
                    allowed_tools = json.loads(raw_tools)
                except Exception:
                    allowed_tools = [s.strip() for s in raw_tools.strip("[]").split(",")]
            else:
                allowed_tools = [s.strip() for s in raw_tools.split(",")]

        return SkillDefinition(
            name=name, description=meta.get("description", ""),
            when_to_use=meta.get("when_to_use") or meta.get("when-to-use"),
            allowed_tools=allowed_tools, user_invocable=user_invocable,
            context=context, prompt_template=result.body,
            source=source, skill_dir=skill_dir,
        )
    except Exception:
        return None
```
<!-- tabs:end -->

`allowed-tools` supports both comma-separated and JSON array formats, trying JSON.parse first and falling back to comma splitting on failure -- both formats are natural when writing YAML, and fault-tolerant parsing prevents skill loading failures due to formatting issues. `when_to_use` accepts both underscore and hyphen key names for the same reason.

### Prompt Template Substitution

<!-- tabs:start -->
#### **TypeScript**
```typescript
// skills.ts -- resolveSkillPrompt

export function resolveSkillPrompt(skill: SkillDefinition, args: string): string {
  let prompt = skill.promptTemplate;
  prompt = prompt.replace(/\$ARGUMENTS|\$\{ARGUMENTS\}/g, args);
  prompt = prompt.replace(/\$\{CLAUDE_SKILL_DIR\}/g, skill.skillDir);
  return prompt;
}
```
#### **Python**
```python
# skills.py -- resolve_skill_prompt

def resolve_skill_prompt(skill: SkillDefinition, args: str) -> str:
    prompt = skill.prompt_template
    prompt = re.sub(r"\$ARGUMENTS|\$\{ARGUMENTS\}", args, prompt)
    prompt = prompt.replace("${CLAUDE_SKILL_DIR}", skill.skill_dir)
    return prompt
```
<!-- tabs:end -->

`$ARGUMENTS` is replaced with user-provided arguments, and `${CLAUDE_SKILL_DIR}` is replaced with the skill directory path (skills can place template files in their directory and reference them with `read_file` in the prompt). Claude Code also supports `` !`shell_command` `` inline execution, which we haven't implemented -- it adds security risk and isn't needed for tutorial scenarios.

### Dual Invocation Paths

```mermaid
flowchart TD
    User["User input"] --> Check{Starts with /?}
    Check -->|"/commit fix types"| Parse["Parse: name=commit, args=fix types"]
    Check -->|"help me commit code"| Model["Model understands intent"]

    Parse --> Resolve["resolveSkillPrompt()"]
    Model --> SkillTool["Call skill tool"]
    SkillTool --> Execute["executeSkill()"]
    Execute --> Resolve

    Resolve --> Inject["Inject as user message"]
    Inject --> Chat["agent.chat()"]

    style Check fill:#7c5cfc,color:#fff
```

**Path 1: User manual invocation** (cli.ts)

<!-- tabs:start -->
#### **TypeScript**
```typescript
if (input.startsWith("/")) {
  const spaceIdx = input.indexOf(" ");
  const cmdName = spaceIdx > 0 ? input.slice(1, spaceIdx) : input.slice(1);
  const cmdArgs = spaceIdx > 0 ? input.slice(spaceIdx + 1) : "";
  const skill = getSkillByName(cmdName);
  if (skill && skill.userInvocable) {
    const resolved = resolveSkillPrompt(skill, cmdArgs);
    printInfo(`Invoking skill: ${skill.name}`);
    await agent.chat(resolved);
    return;
  }
}
```
#### **Python**
```python
if inp.startswith("/"):
    space_idx = inp.find(" ")
    cmd_name = inp[1:space_idx] if space_idx > 0 else inp[1:]
    cmd_args = inp[space_idx + 1:] if space_idx > 0 else ""
    skill = get_skill_by_name(cmd_name)
    if skill and skill.user_invocable:
        resolved = resolve_skill_prompt(skill, cmd_args)
        print_info(f"Invoking skill: {skill.name}")
        await agent.chat(resolved)
        continue
```
<!-- tabs:end -->

**Path 2: Model programmatic invocation** (tools.ts)

<!-- tabs:start -->
#### **TypeScript**
```typescript
// tools.ts -- skill tool definition and execution

{
  name: "skill",
  description: "Invoke a registered skill by name...",
  input_schema: {
    properties: {
      skill_name: { type: "string" },
      args: { type: "string" },
    },
    required: ["skill_name"],
  },
}

function runSkillTool(input: { skill_name: string; args?: string }): string {
  const result = executeSkill(input.skill_name, input.args || "");
  if (!result) return `Unknown skill: ${input.skill_name}`;
  return `[Skill "${input.skill_name}" activated]\n\n${result.prompt}`;
}
```
#### **Python**
```python
# tools.py -- skill tool definition and execution

{
    "name": "skill",
    "description": "Invoke a registered skill by name...",
    "input_schema": {
        "type": "object",
        "properties": {
            "skill_name": {"type": "string"},
            "args": {"type": "string"},
        },
        "required": ["skill_name"],
    },
}

async def _execute_skill_tool(self, inp: dict) -> str:
    result = execute_skill(inp.get("skill_name", ""), inp.get("args", ""))
    if not result:
        return f"Unknown skill: {inp.get('skill_name', '')}"
    return f'[Skill "{inp.get("skill_name", "")}" activated]\n\n{result["prompt"]}'
```
<!-- tabs:end -->

After the model calls the `skill` tool, it receives the expanded prompt text and executes the task according to that prompt in subsequent turns. This is essentially a **meta-tool** -- the tool's return value isn't data, but instructions.

### Execution Modes: inline vs fork

<!-- tabs:start -->
#### **TypeScript**
```typescript
// agent.ts -- executeSkillTool

private async executeSkillTool(input: Record<string, any>): Promise<string> {
  const result = executeSkill(input.skill_name, input.args || "");
  if (!result) return `Unknown skill: ${input.skill_name}`;

  if (result.context === "fork") {
    const tools = result.allowedTools
      ? this.tools.filter(t => result.allowedTools!.includes(t.name))
      : this.tools.filter(t => t.name !== "agent");
    const subAgent = new Agent({
      customSystemPrompt: result.prompt,
      customTools: tools,
      isSubAgent: true,
      permissionMode: "bypassPermissions",
    });
    const subResult = await subAgent.runOnce(input.args || "Execute this skill task.");
    return subResult.text;
  }

  return `[Skill "${input.skill_name}" activated]\n\n${result.prompt}`;
}
```
#### **Python**
```python
# agent.py -- _execute_skill_tool

async def _execute_skill_tool(self, inp: dict) -> str:
    result = execute_skill(inp.get("skill_name", ""), inp.get("args", ""))
    if not result:
        return f"Unknown skill: {inp.get('skill_name', '')}"

    if result["context"] == "fork":
        tools = (
            [t for t in self.tools if t["name"] in result["allowed_tools"]]
            if result.get("allowed_tools")
            else [t for t in self.tools if t["name"] != "agent"]
        )
        sub_agent = Agent(
            model=self.model,
            custom_system_prompt=result["prompt"],
            custom_tools=tools,
            is_sub_agent=True,
            permission_mode="bypassPermissions",
        )
        sub_result = await sub_agent.run_once(inp.get("args") or "Execute this skill task.")
        return sub_result["text"] or "(Skill produced no output)"

    return f'[Skill "{inp.get("skill_name", "")}" activated]\n\n{result["prompt"]}'
```
<!-- tabs:end -->

When forking, the sub-Agent's tools are constrained by the `allowedTools` whitelist; if unspecified, the `agent` tool is excluded to prevent recursion. Use fork when a skill needs multiple rounds of tool calls (like code review reading multiple files) to keep the main conversation clean.

### System Prompt Description

<!-- tabs:start -->
#### **TypeScript**
```typescript
// skills.ts -- buildSkillDescriptions

export function buildSkillDescriptions(): string {
  const skills = discoverSkills();
  if (skills.length === 0) return "";

  const lines = ["# Available Skills", ""];
  const invocable = skills.filter((s) => s.userInvocable);
  const autoOnly = skills.filter((s) => !s.userInvocable);

  if (invocable.length > 0) {
    lines.push("User-invocable skills (user types /<name> to invoke):");
    for (const s of invocable) {
      lines.push(`- **/${s.name}**: ${s.description}`);
      if (s.whenToUse) lines.push(`  When to use: ${s.whenToUse}`);
    }
  }

  if (autoOnly.length > 0) {
    lines.push("Auto-invocable skills (use the skill tool when appropriate):");
    for (const s of autoOnly) {
      lines.push(`- **${s.name}**: ${s.description}`);
      if (s.whenToUse) lines.push(`  When to use: ${s.whenToUse}`);
    }
  }

  lines.push("To invoke a skill programmatically, use the `skill` tool.");
  return lines.join("\n");
}
```
#### **Python**
```python
# skills.py -- build_skill_descriptions

def build_skill_descriptions() -> str:
    skills = discover_skills()
    if not skills:
        return ""

    lines = ["# Available Skills", ""]
    invocable = [s for s in skills if s.user_invocable]
    auto_only = [s for s in skills if not s.user_invocable]

    if invocable:
        lines.append("User-invocable skills (user types /<name> to invoke):")
        for s in invocable:
            lines.append(f"- **/{s.name}**: {s.description}")
            if s.when_to_use:
                lines.append(f"  When to use: {s.when_to_use}")
        lines.append("")

    if auto_only:
        lines.append("Auto-invocable skills (use the skill tool when appropriate):")
        for s in auto_only:
            lines.append(f"- **{s.name}**: {s.description}")
            if s.when_to_use:
                lines.append(f"  When to use: {s.when_to_use}")
        lines.append("")

    lines.append("To invoke a skill programmatically, use the `skill` tool.")
    return "\n".join(lines)
```
<!-- tabs:end -->

Skills are displayed in two groups: user-invocable ones get the `/` prefix, model-only ones don't. `whenToUse` is the judgment condition shown to the model for deciding whether to trigger proactively. Claude Code also implements token budget control (`formatCommandsWithinBudget()`), which we skip -- tutorial scenarios have limited skill counts.

---

## What the Real Claude Code Does Beyond This

Our skills are two load modes plus a file parser. Claude Code is more complete on where skills are discovered, how they lazy-load, and how a fork is isolated — starting with how it locates a skill.

Skills are Claude Code's "AI Shell Scripts" -- templatizing AI workflows for one-time definition and repeated reuse. A `/commit` skill encapsulates the complete prompt for "read diff -> analyze changes -> write commit message -> commit."

Skills are loaded from 6 sources, with priority from high to low: enterprise policy (managed) > project-level > user-level > plugin > built-in (bundled) > MCP. The pattern is simple: sources closer to user control have higher priority, while MCP sits at the bottom since it comes from untrusted remote servers. Each skill must be in directory format `skill-name/SKILL.md`, allowing skills to bundle resource files referenced via `${CLAUDE_SKILL_DIR}`.

At startup, only frontmatter is preloaded (name/description/whenToUse); the full prompt is read only when invoked. Loading all skills fully with dozens of them would consume significant context space, so lazy loading defers the cost to the moment it's actually needed. Even just frontmatter requires token space -- `formatCommandsWithinBudget()` uses a three-stage algorithm: when budget is ample, show everything; when exceeded, built-in skills (`/commit`, `/review`) always keep full descriptions while others split the remaining budget equally; when each skill gets fewer than 20 characters, degrade to showing names only.

Skill prompts undergo multi-layer substitution before execution: `$ARGUMENTS` replaces user arguments, `${CLAUDE_SKILL_DIR}` replaces the skill directory path, and `` !`command` `` executes inline shell commands (disabled for MCP skills to prevent remote prompt injection from executing arbitrary commands).

There are two execution modes: **inline** (default) injects directly into the current conversation, and **fork** creates an independent sub-Agent that executes and returns results. Fork is suitable for skills requiring many tool calls -- for example, code review needs to read multiple files, and those calls would pollute the main conversation context. With fork, only the final result returns to the main thread.

---

## Key Design Decisions

**Why Markdown instead of JSON/YAML for skills?** The essence of a skill is a large block of natural language prompt. Markdown's body is directly the prompt itself, with frontmatter providing structured metadata. Storing in JSON would require escaping newlines and quotes in the prompt, resulting in poor readability.

**Why dual invocation paths?** Supporting only `/commit` for manual invocation isn't enough -- users might say "help me commit code" without knowing the skill exists. Supporting only model auto-invocation isn't enough either -- users sometimes want precise control over trigger timing. Both paths ultimately converge at the same `resolveSkillPrompt()`, so logic isn't duplicated.

### Comparison Overview

| Dimension | Claude Code | mini-claude |
|-----------|------------|-------------|
| **Skill sources** | 6 (managed/project/user/plugin/bundled/MCP) | 2 (project + user) |
| **Skill loading** | Lazy loading + token budget control | Full loading at startup + caching |
| **Prompt substitution** | `$ARGUMENTS` + `${CLAUDE_SKILL_DIR}` + `` !`shell` `` | `$ARGUMENTS` + `${CLAUDE_SKILL_DIR}` |

---

> **Next chapter**: Let the Agent think before acting -- Plan Mode, read-only planning mode.
