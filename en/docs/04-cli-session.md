# 4. CLI and Sessions

## Chapter Goals

By the end of last chapter the agent's core is complete — loop, tools, System Prompt — but it still has no face to talk to a person through. This chapter builds the user interface.

A command-line entry point parses the arguments (switches like `--yolo`, `--resume`), a REPL lets a person chat a line at a time, Ctrl+C interrupts the current turn midway, and finished conversations are written to disk so `--resume` can pick them back up next time.

```mermaid
graph TB
    Entry[cli.ts Entry] --> Parse[parseArgs<br/>Argument Parsing]
    Parse --> |has prompt| OneShot[One-shot Mode<br/>agent.chat -> exit]
    Parse --> |no prompt| REPL[REPL Mode<br/>readline loop]
    Parse --> |--resume| Restore[Restore Session]
    Restore --> REPL
    REPL --> |user input| Cmd{Command?}
    Cmd -->|/clear| Clear[Clear History]
    Cmd -->|/cost| Cost[Show Cost]
    Cmd -->|/compact| Compact[Compact Context]
    Cmd -->|/plan| Plan[Toggle Plan Mode]
    Cmd -->|plain text| Chat[agent.chat]
    Chat --> Save[Auto-save Session]

    style Entry fill:#7c5cfc,color:#fff
    style REPL fill:#e8e0ff
```

## Our Implementation

### Argument Parsing

<!-- tabs:start -->
#### **TypeScript**
```typescript
// cli.ts -- parseArgs

function parseArgs(): ParsedArgs {
  const args = process.argv.slice(2);
  let permissionMode: PermissionMode = "default";
  let thinking = false;
  let model = process.env.MINI_CLAUDE_MODEL || "claude-opus-4-6";
  let apiBase: string | undefined;
  let resume = false;
  let maxCost: number | undefined;
  let maxTurns: number | undefined;
  const positional: string[] = [];

  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--yolo" || args[i] === "-y") {
      permissionMode = "bypassPermissions";
    } else if (args[i] === "--plan") {
      permissionMode = "plan";
    } else if (args[i] === "--accept-edits") {
      permissionMode = "acceptEdits";
    } else if (args[i] === "--dont-ask") {
      permissionMode = "dontAsk";
    } else if (args[i] === "--thinking") {
      thinking = true;
    } else if (args[i] === "--model" || args[i] === "-m") {
      model = args[++i] || model;
    } else if (args[i] === "--api-base") {
      apiBase = args[++i];
    } else if (args[i] === "--resume") {
      resume = true;
    } else if (args[i] === "--max-cost") {
      const v = parseFloat(args[++i]);
      if (!isNaN(v)) maxCost = v;
    } else if (args[i] === "--max-turns") {
      const v = parseInt(args[++i], 10);
      if (!isNaN(v)) maxTurns = v;
    } else if (args[i] === "--help" || args[i] === "-h") {
      console.log(`Usage: mini-claude [options] [prompt] ...`);
      process.exit(0);
    } else {
      positional.push(args[i]);
    }
  }

  return {
    permissionMode, model, apiBase, resume, thinking, maxCost, maxTurns,
    prompt: positional.length > 0 ? positional.join(" ") : undefined,
  };
}
```
#### **Python**
```python
# __main__.py -- parse_args

def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(prog="mini-claude", add_help=False)
    parser.add_argument("prompt", nargs="*")
    parser.add_argument("--yolo", "-y", action="store_true")
    parser.add_argument("--plan", action="store_true")
    parser.add_argument("--accept-edits", action="store_true")
    parser.add_argument("--dont-ask", action="store_true")
    parser.add_argument("--thinking", action="store_true")
    parser.add_argument("--model", "-m", default=None)
    parser.add_argument("--api-base", default=None)
    parser.add_argument("--resume", action="store_true")
    parser.add_argument("--max-cost", type=float, default=None)
    parser.add_argument("--max-turns", type=int, default=None)
    parser.add_argument("--help", "-h", action="store_true")
    return parser.parse_args()


def _resolve_permission_mode(args: argparse.Namespace) -> str:
    if args.yolo: return "bypassPermissions"
    if args.plan: return "plan"
    if args.accept_edits: return "acceptEdits"
    if args.dont_ask: return "dontAsk"
    return "default"
```
<!-- tabs:end -->

The TypeScript version uses a hand-written loop instead of commander.js, since there are only 11 arguments -- zero dependencies is lighter. It uses `for` instead of `forEach` because value-taking arguments (`--model claude-sonnet`) need `++i` to skip to the next element. The Python version uses the standard library `argparse` directly.

### Two Execution Modes

<!-- tabs:start -->
#### **TypeScript**
```typescript
// cli.ts -- main

async function main() {
  const { permissionMode, model, apiBase, prompt, resume, thinking, maxCost, maxTurns } = parseArgs();

  // API key from environment variables, not command-line (to avoid leaking into shell history)
  // Priority: OPENAI_API_KEY + OPENAI_BASE_URL -> ANTHROPIC_API_KEY -> OPENAI_API_KEY
  const resolvedApiKey = resolveApiKey(apiBase);
  if (!resolvedApiKey) {
    printError(`API key is required. Set ANTHROPIC_API_KEY or OPENAI_API_KEY env var.`);
    process.exit(1);
  }

  const agent = new Agent({ permissionMode, model, apiBase, apiKey: resolvedApiKey, thinking, maxCost, maxTurns });

  if (resume) {
    const sessionId = getLatestSessionId();
    if (sessionId) {
      const session = loadSession(sessionId);
      if (session) agent.restoreSession(session);
    }
  }

  if (prompt) {
    await agent.chat(prompt);       // One-shot mode: execute then exit
  } else {
    await runRepl(agent);           // REPL mode: interactive loop
  }
}
```
#### **Python**
```python
# __main__.py -- main

def main() -> None:
    args = parse_args()
    permission_mode = _resolve_permission_mode(args)
    model = args.model or os.environ.get("MINI_CLAUDE_MODEL", "claude-opus-4-6")

    resolved_api_key: str | None = None
    resolved_use_openai = bool(args.api_base)
    if os.environ.get("OPENAI_API_KEY") and os.environ.get("OPENAI_BASE_URL"):
        resolved_api_key = os.environ["OPENAI_API_KEY"]
        resolved_use_openai = True
    elif os.environ.get("ANTHROPIC_API_KEY"):
        resolved_api_key = os.environ["ANTHROPIC_API_KEY"]
    elif os.environ.get("OPENAI_API_KEY"):
        resolved_api_key = os.environ["OPENAI_API_KEY"]
        resolved_use_openai = True

    if not resolved_api_key:
        print_error("API key is required.")
        sys.exit(1)

    agent = Agent(permission_mode=permission_mode, model=model, thinking=args.thinking,
                  max_cost_usd=args.max_cost, max_turns=args.max_turns, api_key=resolved_api_key)

    if args.resume:
        session_id = get_latest_session_id()
        if session_id:
            session = load_session(session_id)
            if session: agent.restore_session(session)

    prompt = " ".join(args.prompt) if args.prompt else None
    if prompt:
        asyncio.run(agent.chat(prompt))
    else:
        asyncio.run(run_repl(agent))
```
<!-- tabs:end -->

### REPL Implementation

<!-- tabs:start -->
#### **TypeScript**
```typescript
// cli.ts -- runRepl

async function runRepl(agent: Agent) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });

  let sigintCount = 0;
  process.on("SIGINT", () => {
    if (agent.isProcessing) {
      agent.abort();
      console.log("\n  (interrupted)");
      sigintCount = 0;
      printUserPrompt();
    } else {
      sigintCount++;
      if (sigintCount >= 2) { console.log("\nBye!\n"); process.exit(0); }
      console.log("\n  Press Ctrl+C again to exit.");
      printUserPrompt();
    }
  });

  printWelcome();

  // rl.once instead of rl.on: ensures strict serialization, prevents multiple chats from concurrently modifying message history
  const askQuestion = (): void => {
    printUserPrompt();
    rl.once("line", async (line) => {
      const input = line.trim();
      sigintCount = 0;

      if (!input) { askQuestion(); return; }
      if (input === "exit" || input === "quit") { console.log("\nBye!\n"); process.exit(0); }

      if (input === "/clear") { agent.clearHistory(); askQuestion(); return; }
      if (input === "/cost")  { agent.showCost(); askQuestion(); return; }
      if (input === "/compact") {
        try { await agent.compact(); } catch (e: any) { printError(e.message); }
        askQuestion(); return;
      }
      if (input === "/plan") { agent.togglePlanMode(); askQuestion(); return; }

      try {
        await agent.chat(input);
      } catch (e: any) {
        if (e.name !== "AbortError" && !e.message?.includes("aborted")) printError(e.message);
      }

      askQuestion();
    });
  };

  askQuestion();
}
```
#### **Python**
```python
# __main__.py -- run_repl

async def run_repl(agent: Agent) -> None:
    sigint_count = 0

    def handle_sigint(sig, frame):
        nonlocal sigint_count
        if agent._aborted is False and agent._output_buffer is not None:
            agent.abort()
            print("\n  (interrupted)")
            sigint_count = 0
            print_user_prompt()
        else:
            sigint_count += 1
            if sigint_count >= 2: print("\nBye!\n"); sys.exit(0)
            print("\n  Press Ctrl+C again to exit.")
            print_user_prompt()

    signal.signal(signal.SIGINT, handle_sigint)
    print_welcome()

    while True:
        print_user_prompt()
        try:
            line = input()
        except (EOFError, KeyboardInterrupt):
            print("\nBye!\n"); break

        inp = line.strip()
        sigint_count = 0
        if not inp: continue
        if inp in ("exit", "quit"): print("\nBye!\n"); break

        if inp == "/clear": agent.clear_history(); continue
        if inp == "/cost": agent.show_cost(); continue
        if inp == "/compact": await agent.compact(); continue
        if inp == "/plan": agent.toggle_plan_mode(); continue

        try:
            await agent.chat(inp)
        except Exception as e:
            if "abort" not in str(e).lower(): print_error(str(e))
```
<!-- tabs:end -->

**Dual semantics of Ctrl+C**: While processing, pressing it -> interrupts the current operation and returns to the input prompt; while idle, pressing it -> first time shows a reminder, second time exits. This avoids two undesirable scenarios: accidentally pressing Ctrl+C and losing the entire session, and watching helplessly while the Agent runs off track.

**`rl.once` vs `rl.on`**: A handler registered with `rl.on` responds to the next line of input without waiting for `await agent.chat()` to complete, causing multiple chats to concurrently modify message history. `rl.once` listens for only one line at a time, recursively re-registering after processing -- naturally serial. Python's `while + input() + await` doesn't have this problem.

### Session Persistence

<!-- tabs:start -->
#### **TypeScript**
```typescript
// session.ts

const SESSION_DIR = join(homedir(), ".mini-claude", "sessions");

export function saveSession(id: string, data: SessionData): void {
  ensureDir();
  writeFileSync(join(SESSION_DIR, `${id}.json`), JSON.stringify(data, null, 2));
}

export function getLatestSessionId(): string | null {
  const sessions = listSessions();
  if (sessions.length === 0) return null;
  sessions.sort((a, b) => new Date(b.startTime).getTime() - new Date(a.startTime).getTime());
  return sessions[0].id;
}
```
#### **Python**
```python
# session.py

SESSION_DIR = Path.home() / ".mini-claude" / "sessions"

def save_session(session_id: str, data: dict[str, Any]) -> None:
    SESSION_DIR.mkdir(parents=True, exist_ok=True)
    (SESSION_DIR / f"{session_id}.json").write_text(json.dumps(data, indent=2, default=str))

def get_latest_session_id() -> str | None:
    sessions = list_sessions()
    if not sessions: return None
    sessions.sort(key=lambda s: s.get("startTime", ""), reverse=True)
    return sessions[0].get("id")
```
<!-- tabs:end -->

Auto-saves after each `agent.chat()` completes; save failures are silently ignored (a full disk shouldn't crash the entire conversation). Recovery simply loads the message array back into the Agent:

<!-- tabs:start -->
#### **TypeScript**
```typescript
// agent.ts
private autoSave() {
  try {
    saveSession(this.sessionId, {
      metadata: { id: this.sessionId, model: this.model, cwd: process.cwd(),
                  startTime: this.sessionStartTime, messageCount: this.getMessageCount() },
      anthropicMessages: this.useOpenAI ? undefined : this.anthropicMessages,
      openaiMessages: this.useOpenAI ? this.openaiMessages : undefined,
    });
  } catch {}
}

restoreSession(data: { anthropicMessages?: any[]; openaiMessages?: any[] }) {
  if (data.anthropicMessages) this.anthropicMessages = data.anthropicMessages;
  if (data.openaiMessages) this.openaiMessages = data.openaiMessages;
  printInfo(`Session restored (${this.getMessageCount()} messages).`);
}
```
#### **Python**
```python
# agent.py
def _auto_save(self) -> None:
    try:
        save_session(self.session_id, {
            "metadata": { "id": self.session_id, "model": self.model,
                          "cwd": str(Path.cwd()), "startTime": self.session_start_time,
                          "messageCount": self._get_message_count() },
            "anthropicMessages": self._anthropic_messages if not self.use_openai else None,
            "openaiMessages": self._openai_messages if self.use_openai else None,
        })
    except Exception:
        pass

def restore_session(self, data: dict) -> None:
    if data.get("anthropicMessages"): self._anthropic_messages = data["anthropicMessages"]
    if data.get("openaiMessages"): self._openai_messages = data["openaiMessages"]
    print_info(f"Session restored ({self._get_message_count()} messages).")
```
<!-- tabs:end -->

### Terminal UI -- ui.ts

All output is uniformly formatted through `ui.ts`:

<!-- tabs:start -->
#### **TypeScript**
```typescript
// ui.ts (using chalk)

export function printToolCall(name: string, input: Record<string, any>) {
  const icon = getToolIcon(name);      // read_file -> book icon, run_shell -> computer icon
  const summary = getToolSummary(name, input);
  console.log(chalk.yellow(`\n  ${icon} ${name}`) + chalk.gray(` ${summary}`));
}

export function printToolResult(name: string, result: string) {
  const maxLen = 500;
  const truncated = result.length > maxLen
    ? result.slice(0, maxLen) + chalk.gray(`\n  ... (${result.length} chars total)`)
    : result;
  console.log(chalk.dim(truncated.split("\n").map((l) => "  " + l).join("\n")));
}
```
#### **Python**
```python
# ui.py (using rich)

def print_tool_call(name: str, inp: dict) -> None:
    icon = _get_tool_icon(name)
    summary = _get_tool_summary(name, inp)
    console.print(f"\n  [yellow]{icon} {name}[/yellow][dim] {summary}[/dim]")

def print_tool_result(name: str, result: str) -> None:
    max_len = 500
    truncated = result[:max_len] + f"\n  ... ({len(result)} chars total)" if len(result) > max_len else result
    lines = "\n".join("  " + l for l in truncated.split("\n"))
    console.print(f"[dim]{lines}[/dim]")
```
<!-- tabs:end -->

Tool results are truncated to 500 characters at the UI layer -- this display is for humans; the complete result is already in the message history.

> **Next chapter**: Making the Agent's output appear in real time -- streaming output and dual-backend support.
## What the Real Claude Code Does Beyond This

Our interface is a readline plus a few print calls. Claude Code's is a whole UI framework running in the terminal — the gap is all in making it stable, pleasant, and crash-proof in a real terminal.

Claude Code's entry point is `src/entrypoints/cli.tsx` -- using React/Ink to bring the component model into the terminal, supporting streaming Markdown rendering, Vim mode, multi-tab, keyboard customization. Sessions use JSONL format with append-only writes, making them crash-safe.

### Terminal-Native vs GUI

This is a deliberate choice. Developers' workflows live in the terminal -- opening a browser means a context switch. Being terminal-native makes it just another command-line tool, embedded into existing workflows alongside `git`, `grep`, etc. Specific benefits: works over SSH, can accept pipes (`echo "fix" | claude`), supports tmux multi-instance parallelism, near-zero memory overhead.

React/Ink's role is to compensate for the terminal's interaction limitations -- with the component model, complex UIs like streaming output and diff views become maintainable.

### Observable Autonomy

The core UX principle of Claude Code: **the Agent acts freely, but lets the user see every step in real time**.

```
read_file src/app.ts
  1 | import express from ...
  ... (1234 chars total)

edit_file src/app.ts
  - const port = 3000
  + const port = process.env.PORT
```

The cost of interrupting is far lower than the cost of undoing. Users can hit Ctrl+C within 3 seconds of the Agent going in the wrong direction, rather than waiting 20 seconds for it to finish and then spending even more time undoing. Each tool has 4 rendering methods (start/complete/denied/error), long-running tools stream stdout in real time rather than waiting until completion to display.

### JSONL Session Storage

Whole-JSON overwrite has two problems: a crash mid-write corrupts the entire file; the longer the conversation, the slower each save.

JSONL appends one line per turn, O(1) writes, and a crash loses at most the last line. The filesystem's append operation is typically atomic. Recovery parses line by line, skipping any incomplete line at the end.

