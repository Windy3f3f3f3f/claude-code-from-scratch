#!/usr/bin/env node

import * as readline from "readline";
import { Agent } from "./agent.js";
import { printWelcome, printUserPrompt, printError, printInfo } from "./ui.js";
import { loadSession, getLatestSessionId } from "./session.js";
import { listMemories, recallMemories } from "./memory.js";
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
  --thinking          Enable extended thinking (Anthropic only)
  --model, -m         Model to use (default: claude-opus-4-6, or MINI_CLAUDE_MODEL env)
  --api-base URL      Use OpenAI-compatible API endpoint (key via env var)
  --resume            Resume the last session
  --max-cost USD      Stop when estimated cost exceeds this amount
  --max-turns N       Stop after N agentic turns
  --help, -h          Show this help

REPL commands:
  /clear              Clear conversation history
  /cost               Show token usage and cost
  /compact            Manually compact conversation
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

  // Ctrl+C handling
  let sigintCount = 0;
  process.on("SIGINT", () => {
    if (agent.isProcessing) {
      agent.abort();
      console.log("\n  (interrupted)");
      sigintCount = 0;
      printUserPrompt();
    } else {
      sigintCount++;
      if (sigintCount >= 2) {
        console.log("\nBye!\n");
        process.exit(0);
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
        process.exit(0);
      }

      // REPL commands
      if (input === "/clear") {
        agent.clearHistory();
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
    }
  } else {
    // Interactive REPL mode
    await runRepl(agent);
  }
}

main();
