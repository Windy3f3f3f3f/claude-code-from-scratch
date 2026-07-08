import Anthropic from "@anthropic-ai/sdk";
import { toolDefinitions, executeTool } from "./tools.js";
//#step >=3
import { buildSystemPrompt } from "./prompt.js";
//#endstep
//#step >=6
import { checkPermission } from "./permissions.js";
//#endstep
//#step >=7
import { maybeCompact } from "./context.js";
//#endstep
//#step >=8
import { recallMemories } from "./memory.js";
//#endstep

const MODEL = process.env.MINI_MODEL || "claude-sonnet-4-5-20250929";

//#step <=2
// A minimal, hard-coded system prompt. Chapter 3 replaces this with a real
// static-core-plus-environment prompt built in prompt.ts.
const SYSTEM_PROMPT =
  "You are Mini Claude Code, a small coding assistant that helps with software " +
  "tasks. Use the tools to read and change files. Keep answers short.";
//#endstep

// The whole agent is one class holding a growing message array and a loop.
export class Agent {
  private client: Anthropic;
  private messages: Anthropic.MessageParam[] = [];

  constructor() {
    this.client = new Anthropic({
      apiKey: process.env.ANTHROPIC_API_KEY,
      // Optional: point at an Anthropic-compatible relay via ANTHROPIC_BASE_URL.
      baseURL: process.env.ANTHROPIC_BASE_URL,
    });
  }

  // One user turn. Call the model; if it asks for tools, run them and feed the
  // results back; repeat until it answers with plain text.
//#region loop
  async chat(userText: string): Promise<void> {
    this.messages.push({ role: "user", content: userText });

    while (true) {
//#step >=7
      // Before each model call, compact the history if it has grown too long.
      this.messages = await maybeCompact(this.messages, this.client, MODEL);
//#endstep
//#step >=3
      let system = buildSystemPrompt();
//#step <=2
      let system = SYSTEM_PROMPT;
//#endstep
//#step >=8
      // Recall memories relevant to what the user just asked, into the prompt.
      system += recallMemories(userText);
//#endstep
      // Build the request once. Passing `tools` is the one line that makes the
      // model tool-aware. Chapter 5 turns the call itself into a stream.
      const request = {
        model: MODEL,
        max_tokens: 4096,
        system,
        tools: toolDefinitions,
        messages: this.messages,
      };

//#step >=5
      // Stream the reply so text shows up as it is generated, then collect the
      // finished message (same shape a non-streaming call would return).
      const stream = this.client.messages.stream(request);
      stream.on("text", (t) => process.stdout.write(t));
      const reply = await stream.finalMessage();
      process.stdout.write("\n");
//#step <=4
      const reply = await this.client.messages.create(request);
      for (const block of reply.content) {
        if (block.type === "text") process.stdout.write(block.text);
      }
      process.stdout.write("\n");
//#endstep

      // Record the assistant's full reply (text + any tool calls).
      this.messages.push({ role: "assistant", content: reply.content });

      const toolUses = reply.content.filter(
        (b): b is Anthropic.ToolUseBlock => b.type === "tool_use"
      );
      // No tool calls means the model is done with this turn.
      if (toolUses.length === 0) return;

      // Run every requested tool and send the outputs back as one user message.
      const results: Anthropic.ToolResultBlockParam[] = [];
      for (const tu of toolUses) {
        console.log(`  → ${tu.name}(${JSON.stringify(tu.input)})`);
//#step >=6
        // Check permission before running the tool; a denied call never runs.
        const output = checkPermission(tu.name, tu.input as Record<string, any>) === "deny"
          ? `Denied: ${tu.name} was blocked by the permission system.`
          : await executeTool(tu.name, tu.input as Record<string, any>);
//#step <=5
        const output = await executeTool(tu.name, tu.input as Record<string, any>);
//#endstep
        results.push({ type: "tool_result", tool_use_id: tu.id, content: output });
      }
      this.messages.push({ role: "user", content: results });
    }
  }
//#endregion
//#step >=4
  // Session support: expose the history so the CLI can save it and restore it.
  history(): Anthropic.MessageParam[] { return this.messages; }
  loadHistory(messages: Anthropic.MessageParam[]): void { this.messages = messages; }
  clearHistory(): void { this.messages = []; }
//#endstep
}
