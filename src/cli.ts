#!/usr/bin/env node

import * as readline from "readline";
import { Agent } from "./agent.js";
import { printWelcome, printUserPrompt, printError, printInfo, printPlanForApproval, printPlanApprovalOptions } from "./ui.js";
import { loadSession, getLatestSessionId } from "./session.js";
import { listMemories } from "./memory.js";
import { discoverSkills, resolveSkillPrompt, getSkillByName, executeSkill } from "./skills.js";
import type { PermissionMode } from "./tools.js";

interface ParsedArgs {
  permissionMode: PermissionMode;
  model: string;
  apiBase?: string;
  prompt?: string;
  resume?: boolean;
  thinking?: boolean;
  maxCost?: number;
  maxTurns?: number;
}

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
    } else if (args[i] === "--auto") {
      permissionMode = "auto";
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
      console.log(`
Usage: mini-claude [options] [prompt]

Options:
  --yolo, -y          Skip all confirmation prompts (bypassPermissions mode)
  --plan              Plan mode: read-only, describe changes without executing
  --accept-edits      Auto-approve file edits, still confirm dangerous shell
  --dont-ask          Auto-deny anything needing confirmation (for CI)
  --auto              Auto Mode: an LLM classifier judges each action instead of asking
  --thinking          Enable extended thinking (Anthropic only)
  --model, -m         Model to use (default: claude-opus-4-6, or MINI_CLAUDE_MODEL env)
  --api-base URL      Use OpenAI-compatible API endpoint (key via env var)
  --resume            Resume the last session
  --max-cost USD      Stop when estimated cost exceeds this amount
  --max-turns N       Stop after N agentic turns
  --help, -h          Show this help

REPL commands:
  /clear              Clear conversation history
  /plan               Toggle plan mode (read-only ↔ normal)
  /cost               Show token usage and cost
  /compact            Manually compact conversation
  /goal <condition>   Pursue a goal across turns until an evaluator judges it met
  /goal               Show the active goal's status
  /loop [interval] <prompt>  Re-run a prompt on an interval (5m/2h) or self-paced
  /memory             List saved memories
  /skills             List available skills
  /<skill-name>       Invoke a skill (e.g. /commit "fix types")

Examples:
  mini-claude "fix the bug in src/app.ts"
  mini-claude --yolo "run all tests and fix failures"
  mini-claude --plan "how would you refactor this?"
  mini-claude --accept-edits "add error handling to api.ts"
  mini-claude --max-cost 0.50 --max-turns 20 "implement feature X"
  OPENAI_API_KEY=sk-xxx mini-claude --api-base https://aihubmix.com/v1 --model gpt-4o "hello"
  mini-claude --resume
  mini-claude  # starts interactive REPL
`);
      process.exit(0);
    } else {
      positional.push(args[i]);
    }
  }

  return {
    permissionMode,
    model,
    apiBase,
    resume,
    thinking,
    maxCost,
    maxTurns,
    prompt: positional.length > 0 ? positional.join(" ") : undefined,
  };
}

async function runRepl(agent: Agent) {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  // Provide confirmFn that reuses this readline instance, avoiding the
  // classic Node.js bug where a second readline on the same stdin kills
  // the first one when closed.
  agent.setConfirmFn((_message: string) => {
    return new Promise((resolve) => {
      rl.question("  Allow? (y/n): ", (answer) => {
        resolve(answer.toLowerCase().startsWith("y"));
      });
    });
  });

  // Plan approval callback: interactive multi-option selection
  agent.setPlanApprovalFn((planContent: string) => {
    return new Promise((resolve) => {
      printPlanForApproval(planContent);
      printPlanApprovalOptions();

      const askChoice = () => {
        rl.question("  Enter choice (1-4): ", (answer) => {
          const choice = answer.trim();
          if (choice === "1") {
            resolve({ choice: "clear-and-execute" });
          } else if (choice === "2") {
            resolve({ choice: "execute" });
          } else if (choice === "3") {
            resolve({ choice: "manual-execute" });
          } else if (choice === "4") {
            rl.question("  Feedback (what to change): ", (feedback) => {
              resolve({ choice: "keep-planning", feedback: feedback.trim() || undefined });
            });
          } else {
            console.log("  Invalid choice. Enter 1, 2, 3, or 4.");
            askChoice();
          }
        });
      };
      askChoice();
    });
  });

  // Ctrl+C handling
  let sigintCount = 0;
  process.on("SIGINT", () => {
    // Always signal a running /loop or /goal to stop — during its inter-tick
    // wait or between-turn evaluation the agent isn't "processing", so the abort
    // path below wouldn't catch it.
    agent.stopLoop();
    agent.stopGoal();
    if (agent.isProcessing) {
      agent.abort();
      console.log("\n  (interrupted)");
      sigintCount = 0;
      printUserPrompt();
    } else {
      sigintCount++;
      if (sigintCount >= 2) {
        console.log("\nBye!\n");
        // Disconnect MCP first or lingering subprocesses/timers keep the
        // process alive (issue #8)
        agent.close().finally(() => process.exit(0));
        return;
      }
      console.log("\n  Press Ctrl+C again to exit.");
      printUserPrompt();
    }
  });

  printWelcome();

  const askQuestion = (): void => {
    printUserPrompt();
    rl.once("line", async (line) => {
      const input = line.trim();
      sigintCount = 0;

      if (!input) {
        askQuestion();
        return;
      }
      if (input === "exit" || input === "quit") {
        console.log("\nBye!\n");
        rl.close();
        await agent.close();
        process.exit(0);
      }

      // REPL commands
      if (input === "/clear") {
        agent.clearHistory();
        askQuestion();
        return;
      }
      if (input === "/plan") {
        const newMode = agent.togglePlanMode();
        askQuestion();
        return;
      }
      if (input === "/cost") {
        agent.showCost();
        askQuestion();
        return;
      }
      if (input === "/compact") {
        try {
          await agent.compact();
        } catch (e: any) {
          printError(e.message);
        }
        askQuestion();
        return;
      }
      if (input === "/goal" || input.startsWith("/goal ")) {
        const condition = input.slice("/goal".length).trim();
        if (!condition) {
          agent.showGoal();
          askQuestion();
          return;
        }
        const directive = agent.setGoal(condition);
        try {
          await agent.pursueGoal(directive);
        } catch (e: any) {
          if (e.name !== "AbortError" && !e.message?.includes("aborted")) printError(e.message);
        }
        askQuestion();
        return;
      }
      if (input === "/loop" || input.startsWith("/loop ")) {
        const rest = input.slice("/loop".length).trim();
        try {
          await agent.runLoop(rest);
        } catch (e: any) {
          if (e.name !== "AbortError" && !e.message?.includes("aborted")) printError(e.message);
        }
        askQuestion();
        return;
      }
      if (input === "/memory") {
        const memories = listMemories();
        if (memories.length === 0) {
          printInfo("No memories saved yet.");
        } else {
          printInfo(`${memories.length} memories:`);
          for (const m of memories) {
            console.log(`    [${m.type}] ${m.name} — ${m.description}`);
          }
        }
        askQuestion();
        return;
      }
      if (input === "/skills") {
        const skills = discoverSkills();
        if (skills.length === 0) {
          printInfo("No skills found. Add skills to .claude/skills/<name>/SKILL.md");
        } else {
          printInfo(`${skills.length} skills:`);
          for (const s of skills) {
            const tag = s.userInvocable ? `/${s.name}` : s.name;
            console.log(`    ${tag} (${s.source}) — ${s.description}`);
          }
        }
        askQuestion();
        return;
      }

      // Skill invocation: /<skill-name> [args]
      if (input.startsWith("/")) {
        const spaceIdx = input.indexOf(" ");
        const cmdName = spaceIdx > 0 ? input.slice(1, spaceIdx) : input.slice(1);
        const cmdArgs = spaceIdx > 0 ? input.slice(spaceIdx + 1) : "";
        const skill = getSkillByName(cmdName);
        if (skill && skill.userInvocable) {
          printInfo(`Invoking skill: ${skill.name}`);
          try {
            if (skill.context === "fork") {
              // Fork mode: use skill tool which creates a sub-agent
              const forkResult = executeSkill(skill.name, cmdArgs);
              if (forkResult) {
                await agent.chat(`Use the skill tool to invoke "${skill.name}" with args: ${cmdArgs || "(none)"}`);
              }
            } else {
              // Inline mode: inject resolved prompt
              const resolved = resolveSkillPrompt(skill, cmdArgs);
              await agent.chat(resolved);
            }
          } catch (e: any) {
            if (e.name !== "AbortError" && !e.message?.includes("aborted")) {
              printError(e.message);
            }
          }
          askQuestion();
          return;
        }
        // Unknown command — treat as regular input
      }

      try {
        await agent.chat(input);
      } catch (e: any) {
        if (e.name === "AbortError" || e.message?.includes("aborted")) {
          // Already handled by SIGINT handler
        } else {
          printError(e.message);
        }
      }

      askQuestion();
    });
  };

  askQuestion();
}

async function main() {
  const { permissionMode, model, apiBase, prompt, resume, thinking, maxCost, maxTurns } = parseArgs();

  // Resolve API config from env vars (API keys only via env, not CLI)
  let resolvedApiBase = apiBase;
  let resolvedApiKey: string | undefined;
  let resolvedUseOpenAI = !!apiBase;

  // Check OPENAI env vars first (if OPENAI_BASE_URL is set, use OpenAI format)
  if (process.env.OPENAI_API_KEY && process.env.OPENAI_BASE_URL) {
    resolvedApiKey = process.env.OPENAI_API_KEY;
    resolvedApiBase = resolvedApiBase || process.env.OPENAI_BASE_URL;
    resolvedUseOpenAI = true;
  } else if (process.env.ANTHROPIC_API_KEY) {
    resolvedApiKey = process.env.ANTHROPIC_API_KEY;
    resolvedApiBase = resolvedApiBase || process.env.ANTHROPIC_BASE_URL;
    resolvedUseOpenAI = false;
  } else if (process.env.OPENAI_API_KEY) {
    resolvedApiKey = process.env.OPENAI_API_KEY;
    resolvedApiBase = resolvedApiBase || process.env.OPENAI_BASE_URL;
    resolvedUseOpenAI = true;
  }

  // --api-base without env key: check if any key is available
  if (!resolvedApiKey && apiBase) {
    resolvedApiKey = process.env.OPENAI_API_KEY || process.env.ANTHROPIC_API_KEY;
    resolvedUseOpenAI = true;
  }

  if (!resolvedApiKey) {
    printError(
      `API key is required.\n` +
        `  Set ANTHROPIC_API_KEY (+ optional ANTHROPIC_BASE_URL) for Anthropic format,\n` +
        `  or OPENAI_API_KEY + OPENAI_BASE_URL for OpenAI-compatible format.`
    );
    process.exit(1);
  }

  const agent = new Agent({
    permissionMode, model, thinking, maxCostUsd: maxCost, maxTurns,
    apiBase: resolvedUseOpenAI ? resolvedApiBase : undefined,
    anthropicBaseURL: !resolvedUseOpenAI ? resolvedApiBase : undefined,
    apiKey: resolvedApiKey,
  });

  // Resume session if requested
  if (resume) {
    const sessionId = getLatestSessionId();
    if (sessionId) {
      const session = loadSession(sessionId);
      if (session) {
        agent.restoreSession({
          anthropicMessages: session.anthropicMessages,
          openaiMessages: session.openaiMessages,
        });
      } else {
        printInfo("No session found to resume.");
      }
    } else {
      printInfo("No previous sessions found.");
    }
  }

  if (prompt) {
    // One-shot mode
    try {
      await agent.chat(prompt);
    } catch (e: any) {
      printError(e.message);
      process.exit(1);
    } finally {
      // Without this, MCP subprocesses/timers keep the one-shot process
      // alive after the answer is printed (issue #8)
      await agent.close();
    }
  } else {
    // Interactive REPL mode
    await runRepl(agent);
  }
}

main();
