import json
import os

import anthropic

from tools import tool_definitions, execute_tool
#step >=3
from prompt import build_system_prompt
#endstep

MODEL = os.environ.get("MINI_MODEL", "claude-sonnet-4-5-20250929")

#step <=2
# A minimal, hard-coded system prompt. Chapter 3 replaces this with a real
# static-core-plus-environment prompt built in prompt.py.
SYSTEM_PROMPT = (
    "You are Mini Claude Code, a small coding assistant that helps with software "
    "tasks. Use the tools to read and change files. Keep answers short."
)
#endstep


# The whole agent is one class holding a growing message list and a loop.
class Agent:
    def __init__(self) -> None:
        kwargs = {}
        if os.environ.get("ANTHROPIC_API_KEY"):
            kwargs["api_key"] = os.environ["ANTHROPIC_API_KEY"]
        # Optional: point at an Anthropic-compatible relay via ANTHROPIC_BASE_URL.
        if os.environ.get("ANTHROPIC_BASE_URL"):
            kwargs["base_url"] = os.environ["ANTHROPIC_BASE_URL"]
        self.client = anthropic.Anthropic(**kwargs)
        self.messages: list = []

    # One user turn. Call the model; if it asks for tools, run them and feed the
    # results back; repeat until it answers with plain text.
    def chat(self, user_text: str) -> None:
        self.messages.append({"role": "user", "content": user_text})

        while True:
            kwargs = dict(model=MODEL, max_tokens=4096, tools=tool_definitions, messages=self.messages)
#step >=3
            kwargs["system"] = build_system_prompt()
#step <=2
            kwargs["system"] = SYSTEM_PROMPT
#endstep

            # Ask the model for its next step. (Chapter 5 turns this into a
            # streaming call.)
            reply = self.client.messages.create(**kwargs)

            # Print the assistant's text.
            for block in reply.content:
                if block.type == "text":
                    print(block.text, end="", flush=True)
            print()

            # Record the assistant's full reply (text + any tool calls).
            self.messages.append({"role": "assistant", "content": reply.content})

            tool_uses = [b for b in reply.content if b.type == "tool_use"]
            # No tool calls means the model is done with this turn.
            if not tool_uses:
                return

            # Run every requested tool; send the outputs back as one user message.
            results = []
            for tu in tool_uses:
                print(f"  → {tu.name}({json.dumps(tu.input)})")
                output = execute_tool(tu.name, tu.input)
                results.append({"type": "tool_result", "tool_use_id": tu.id, "content": output})
            self.messages.append({"role": "user", "content": results})
