import Anthropic from "@anthropic-ai/sdk";
import { toolDefinitions, executeTool } from "./tools.js";
//#step >=3
import { buildSystemPrompt } from "./prompt.js";
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
  async chat(userText: string): Promise<void> {
    this.messages.push({ role: "user", content: userText });

    while (true) {
      // Ask the model for its next step. Passing `tools` is the one line that
      // makes it tool-aware. (Chapter 5 turns this into a streaming call.)
      const reply = await this.client.messages.create({
        model: MODEL,
        max_tokens: 4096,
//#step >=3
        system: buildSystemPrompt(),
//#step <=2
        system: SYSTEM_PROMPT,
//#endstep
        tools: toolDefinitions,
        messages: this.messages,
      });

      // Print the assistant's text.
      for (const block of reply.content) {
        if (block.type === "text") process.stdout.write(block.text);
      }
      process.stdout.write("\n");

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
        const output = await executeTool(tu.name, tu.input as Record<string, any>);
        results.push({ type: "tool_result", tool_use_id: tu.id, content: output });
      }
      this.messages.push({ role: "user", content: results });
    }
  }
}
