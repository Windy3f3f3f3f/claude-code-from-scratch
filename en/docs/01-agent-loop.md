# 1. Agent Loop -- The Core Cycle

## Chapter Goals

Build the heart of a coding agent: a loop that keeps going — "call the model → see if it wants a tool → run it → feed the result back → call the model again" — until the model says the task is done.

The starting point is a dozen-line loop; run it the first time and it can only chat, not read a file; add a small tool round-trip and reading a file starts to work. Once that step is done, looking back at the real Claude Code loop makes it clear what all its extra complexity is solving.

```mermaid
graph TB
    subgraph Agent Loop
        A[User Message] --> B[Call LLM API]
        B --> C{Response contains<br/>tool_use?}
        C -->|Yes| D[Execute Tool]
        D --> E[Push tool result to messages]
        E --> B
        C -->|No| F[Output text<br/>End loop]
    end

    style B fill:#7c5cfc,color:#fff
    style D fill:#e8e0ff
```

> ▶ **Run this chapter**: `node steps/run.mjs 1` (no API key — a local mock model). Add `--py` for the Python version.

## First Version: A Loop That Only Chats

Start with the dumbest version. Push the user's message onto the array, call the model once, print the reply — that's it:

```typescript
async function chatOnce(messages, userMessage) {
  messages.push({ role: "user", content: userMessage });

  const response = await client.messages.create({
    model: "claude-...",
    max_tokens: 4096,
    messages,
  });

  const text = response.content.find(b => b.type === "text")?.text ?? "";
  console.log(text);
  messages.push({ role: "assistant", content: response.content });
}
```

It can chat, sure. Ask "explain quicksort" and it answers well. But the moment it needs to do real work, the problem shows up:

```
> read src/agent.ts and explain the main loop
I don't have a way to read your files directly. If you paste the contents, I can help analyze them...
```

It's not unwilling — it just has no hands. The model can only emit text, and this code only prints text back. It wants to read a file, run a command, but the path is blocked at every step: the request never told it which tools exist, and even if it asked, there's nothing to catch that, actually run it, and pass the result back.

## Giving the Loop Hands: The Tool Round-Trip

Letting the model act takes just two things. One is to include a tool list in the request, telling it "you can call read_file, run_shell, and so on." The other is that when its reply carries "I want to call read_file," we actually run it, feed the result back as the next message, and then call the model again so it can keep going.

Those two things are where the `while` loop comes from. Turn the `chatOnce` above into this:

```typescript
async function chat(messages, userMessage) {
  messages.push({ role: "user", content: userMessage });

  while (true) {
    const response = await client.messages.create({
      model: "claude-...",
      max_tokens: 4096,
      messages,
      tools: toolDefinitions,   // <- just this one line: send the tool list so the model knows what it can call
    });
    messages.push({ role: "assistant", content: response.content });

    // pick out the tools the model wants to call this round
    const toolUses = response.content.filter(b => b.type === "tool_use");
    if (toolUses.length === 0) break;   // none -> it considers the task done, exit

    // run them one by one, collect the results
    const toolResults = [];
    for (const toolUse of toolUses) {
      printToolCall(toolUse.name, toolUse.input);
      const result = await executeTool(toolUse.name, toolUse.input);
      printToolResult(toolUse.name, result);
      toolResults.push({ type: "tool_result", tool_use_id: toolUse.id, content: result });
    }

    // feed the results back as one user message, loop to the top, model continues
    messages.push({ role: "user", content: toolResults });
  }
}
```

Just two additions over the first version: `tools: toolDefinitions` in the request (so the model knows which tools exist), and a `while` around it (run the tools, feed the results back, ask another round). The same request that couldn't read a file a moment ago now works.

**What decides whether the loop keeps turning is the model, from start to finish — not our code.** We wrote no "if it's a read-file request then…" branch — the model itself decides whether to act this step, whether that was enough, whether to go another round. That is the line between an agent and a chatbot.

By now the runnable minimal version has taken shape. The concepts above used a few free functions; the real code gathers them into an `Agent` class, and the mapping is just three points: `messages` becomes `this.messages` on the instance, `client` moves into the `Agent` constructor, and `executeTool` / `toolDefinitions` are imported from `tools.ts` (built next chapter). The block below is the `Agent.chat` from step 1 of the steps track, one-to-one across both languages, and it really runs:

<!-- tabs:start -->
#### **TypeScript**
<!-- @snippet lang=ts file=agent.ts region=loop step=1 -->
```typescript
async chat(userText: string): Promise<void> {
  this.messages.push({ role: "user", content: userText });

  while (true) {
    // Ask the model for its next step. Passing `tools` is the one line that
    // makes it tool-aware. (Chapter 5 turns this into a streaming call.)
    const reply = await this.client.messages.create({
      model: MODEL,
      max_tokens: 4096,
      system: SYSTEM_PROMPT,
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
```
<!-- @endsnippet -->
#### **Python**
<!-- @snippet lang=py file=agent.py region=loop step=1 -->
```python
def chat(self, user_text: str) -> None:
    self.messages.append({"role": "user", "content": user_text})

    while True:
        kwargs = dict(model=MODEL, max_tokens=4096, tools=tool_definitions, messages=self.messages)
        kwargs["system"] = SYSTEM_PROMPT

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
```
<!-- @endsnippet -->
<!-- tabs:end -->

▶ Run it right now (no API key — a local mock model):

<!-- @transcript step=1 lang=ts -->
```
$ node steps/run.mjs 1
▶ step 1 demo (no API key — local mock model)   sandbox: <sandbox>
  you: Read the file greeting.txt and tell me what it says.


  → read_file({"file_path":"greeting.txt"})
greeting.txt says: hello from step one.
```
<!-- @endtranscript -->

The model receives "read greeting.txt" and replies "I'll call read_file"; the loop doesn't stop — it actually reads the file, feeds the content back as a user message, and calls the model again, and only then does it answer. The real `agent.ts` layers more on top — memory prefetch, context compression, streaming early execution — all added chapter by chapter later; we look at those at the end of this chapter.

## How the Message Array Grows

The key to understanding this loop is watching how the message array grows each round:

```
Round 1:
  messages = [
    { role: "user",      content: "help me fix a bug" }
    { role: "assistant", content: [text + tool_use(read_file)] }
    { role: "user",      content: [tool_result("file contents...")] }
  ]

Round 2 (model decides to edit after seeing the file):
  messages = [
    ...first 3,
    { role: "assistant", content: [text + tool_use(edit_file)] }
    { role: "user",      content: [tool_result("edit succeeded")] }
  ]

Round 3 (model considers the task done):
  messages = [
    ...first 5,
    { role: "assistant", content: [text("fixed!")] }  <- no tool_use -> break
  ]
```

A round with tools usually adds two entries: one assistant (the tool the model wants to call), one user (the tool result); the final round, where the model calls no tool, adds just one assistant text entry. The model sees the full history end to end every time — that's why it can "remember" what it did earlier; at this point, memory is nothing more than an ever-growing array. Tool results are carried as `role: "user"` because the Anthropic API requires it, and each result must find its way back to its call via `tool_use_id`.

## Wrapping Up: Letting It Stop

This chapter's minimal version doesn't handle interruption yet — pressing Ctrl+C to stop it gracefully mid-run is something we add in Chapter 4 when the CLI arrives. The real Claude Code threads an `AbortController` through the whole loop: call `abort()` and the signal turns `aborted`, the loop exits at the next checkpoint, and even the in-flight network request is cancelled; the Python side uses a flag plus cancelling the current asyncio task to the same effect.

## What the Real Claude Code Does Beyond This

The loop above has one decision: continue if there's a tool_use, stop if not. The real Claude Code handles far more — taking its loop apart reflects exactly what stands between a toy loop and a production engine.

> The structures below (layers, module names, approximate line counts) come from analysis of public builds; what Anthropic's own docs confirm is only the tool_use / tool_result loop itself. Internal details change across versions — treat the specific names and counts as a trend, not exact fact.

It splits one loop into two layers. The outer `QueryEngine` (~1,155 lines) runs the conversation's whole lifecycle — user input, USD budget, token stats, session recovery; the inner `queryLoop` (~1,728 lines) runs only how one query executes — message compression, API calls, tool execution, error recovery. The split is for separation of concerns: the outer layer needn't worry about "how to recover from a PTL error," and the inner one needn't worry about "how to parse user input."

Its inner loop is an async generator (`async function*`). Choosing a generator over callbacks buys two things: backpressure, so the producer doesn't keep generating until the consumer is done, and thus events never pile up; and a linear control flow, where every branch is expressed with ordinary `continue` / `break` and no state machine is needed.

"Continue the loop" splits into seven cases. The minimal version has just one (continue if there's a tool_use); it has seven:

| # | Name | When | What to do |
|---|------|---------|-------|
| 1 | `next_turn` | model called a tool | run it, push the result, continue |
| 2 | `collapse_drain_retry` | PTL error, a staged collapse exists | commit the collapse to free space, retry |
| 3 | `reactive_compact_retry` | PTL error, collapse space not enough | force a full summarizing compaction, retry |
| 4 | `max_output_tokens_escalate` | output truncated, first time | escalate to a higher token limit (16K→64K), retry |
| 5 | `max_output_tokens_recovery` | output truncated, escalation exhausted | inject a continuation prompt, retry up to 3 times |
| 6 | `stop_hook_blocking` | task done but a Stop Hook blocked it | keep running the loop |
| 7 | `token_budget_continuation` | API-side token budget exhausted | keep generating |

We implement only the first; the other six are recovery strategies for various errors and edge cases.

Recoverable errors, it withholds rather than surfacing. When output is truncated, yielding the error straight to the outer layer would flash a UI error — but the inner loop's later recovery logic can actually handle it. So it "withholds" the error, runs the recovery; on success the user notices nothing, on failure it finally surfaces. Most `max_output_tokens` and `prompt_too_long` errors get quietly absorbed this way.

It starts executing tools before the streaming response finishes. A typical response has a 5-to-30-second streaming window, and Claude Code seizes it with `StreamingToolExecutor`: the moment a tool's argument JSON is complete, it runs, without waiting for the whole response to arrive.

```
Serial (this chapter's minimal version, serial for now):
  [========= API streaming response =========][tool1][tool2][tool3]

Parallel (Claude Code):
  [========= API streaming response =========]
       ^ tool1's JSON complete -> execute immediately
            ^ tool2's JSON complete -> execute immediately
```

These are all engineering for "how to make the same loop both stable and fast." The foundation is the same — the minimal loop above is the very one they all sit on top of.

---

> **Next chapter**: the loop's power is all in the tools. Without tools, the model can still only talk, not act. Next we build the tool system out in full, so the agent can actually edit files, run commands, and search code.
