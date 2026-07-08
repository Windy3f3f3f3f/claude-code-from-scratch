import * as readline from "readline";
import { pathToFileURL } from "url";
import { Agent } from "./agent.js";
//#step >=4
import { saveSession, loadSession } from "./session.js";
//#endstep
//#step >=9
import { resolveSkill } from "./skills.js";
//#endstep

// A tiny REPL: read a line, hand it to the agent, repeat. One-shot mode runs a
// single prompt from argv and exits (handy for scripts and testing). Exported as
// runCli(argv) so it can be driven in-process without spawning a shell.
export async function runCli(argv: string[] = process.argv.slice(2)): Promise<void> {
  if (!process.env.ANTHROPIC_API_KEY) {
    console.error("Set ANTHROPIC_API_KEY (and optionally ANTHROPIC_BASE_URL) first.");
    process.exit(1);
  }

  const agent = new Agent();
//#step >=4
  // --resume: reload the saved conversation before doing anything else.
  const resume = argv.includes("--resume");
  argv = argv.filter((a) => a !== "--resume");
  if (resume) {
    const saved = loadSession();
    if (saved) { agent.loadHistory(saved as any); console.log(`(resumed ${saved.length} messages)`); }
  }
//#endstep
//#step >=10
  // --plan: read-only mode. The agent may read and think, but not write or run shell.
  if (argv.includes("--plan")) { agent.setMode("plan"); argv = argv.filter((a) => a !== "--plan"); console.log("(plan mode: read-only)"); }
//#endstep

  const oneShot = argv.join(" ").trim();
  if (oneShot) {
//#step >=9
    // "/name ..." runs a skill's prompt template; anything else is a plain message.
    const input = resolveSkill(oneShot) ?? oneShot;
//#step <=8
    const input = oneShot;
//#endstep
    await agent.chat(input);
//#step >=4
    saveSession(agent.history());
//#endstep
    return;
  }

  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  console.log("mini-claude — type a message, or 'exit' to quit.\n");
  await new Promise<void>((resolve) => {
    const ask = () => {
      rl.question("you: ", async (line) => {
        const input = line.trim();
        if (input === "exit" || input === "quit") { rl.close(); resolve(); return; }
//#step >=4
        if (input === "/clear") { agent.clearHistory(); saveSession(agent.history()); console.log("(history cleared)"); ask(); return; }
//#endstep
//#step >=9
        if (input) await agent.chat(resolveSkill(input) ?? input);
//#step <=8
        if (input) await agent.chat(input);
//#endstep
//#step >=4
        if (input) saveSession(agent.history());
//#endstep
        ask();
      });
    };
    ask();
  });
}

// Run only when executed directly (not when imported for tests/demos).
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) runCli();
