# 7. Context Management

## Chapter Goals

By the end of last chapter the agent can read, write, and run commands safely — but one problem still can't be dodged, one that Chapter 1 already planted: the message array grows every turn. Run a few dozen turns and it eventually overflows the model's context window, and once it does, the API errors out and the whole turn breaks. This chapter builds context compression so the agent can keep going.

Compression comes in four tiers, escalating from the lightest ("trim large tool outputs") to the heaviest ("have the model summarize the whole conversation into one paragraph"), reaching for the heavy one only when the light ones aren't enough. At the end it also wires up prefix caching — that static core split out in Chapter 3 is exactly what saves money here.

```mermaid
graph TD
    Tool[Tool execution result] --> Persist{"&gt; 30KB?"}
    Persist -->|Yes| Disk["Persist to disk<br/>Keep preview + path"]
    Persist -->|No| Trunc{"&gt; 50K chars?"}
    Disk --> T1
    Trunc -->|Yes| Cut["Truncate: keep head and tail"]
    Trunc -->|No| Pass[Return directly]
    Cut --> T1
    Pass --> T1

    T1["Tier 1: Budget<br/>Budget truncation"] -->|"50-70%: 30K<br/>70-85%: 15K"| T2["Tier 2: Snip<br/>Remove duplicates"]
    T2 -->|"Duplicate reads of same file<br/>Old search results"| T3["Tier 3: Microcompact<br/>Micro-compression"]
    T3 -->|"Idle &gt;5min<br/>Cache has gone cold"| T4["Tier 4: Auto-compact<br/>Full summarization"]
    T4 -->|"&gt;85% window"| Summary[LLM summary replacement]

    style Persist fill:#d4edda
    style Disk fill:#d4edda
    style Trunc fill:#e8e0ff
    style T1 fill:#e8e0ff
    style T2 fill:#e8e0ff
    style T3 fill:#e8e0ff
    style T4 fill:#7c5cfc,color:#fff
    style Summary fill:#7c5cfc,color:#fff
```

> ▶ **Run this chapter**: `node steps/run.mjs 7` (no API key) — watch it summarize older messages once the conversation grows. Add `--diff` to see what it added over the previous chapter.

## Our Implementation

Chapter 1 noted that the message array grows every turn. Run long enough and it overflows the model's context window. This chapter adds compaction: when the history gets long, one extra model call summarizes the older messages into a paragraph, replacing them and keeping only the recent few. Relative to last chapter, it adds a `context.ts`, and the agent compacts before each model call:

<!-- @diff file=agent.ts step=7 lang=ts -->
```diff
@@ -3,4 +3,5 @@ import { toolDefinitions, executeTool } from "./tools.js";
 import { buildSystemPrompt } from "./prompt.js";
 import { checkPermission } from "./permissions.js";
+import { maybeCompact } from "./context.js";
 
 const MODEL = process.env.MINI_MODEL || "claude-sonnet-4-5-20250929";
@@ -27,4 +28,6 @@ export class Agent {
 
     while (true) {
+      // Before each model call, compact the history if it has grown too long.
+      this.messages = await maybeCompact(this.messages, this.client, MODEL);
       let system = buildSystemPrompt();
       // Build the request once. Passing `tools` is the one line that makes the
```
<!-- @enddiff -->

Compaction itself is just "summarize the older messages once past a threshold":

<!-- tabs:start -->
#### **TypeScript**
<!-- @snippet lang=ts file=context.ts region=compact step=7 -->
```typescript
export async function maybeCompact(
  messages: Anthropic.MessageParam[],
  client: Anthropic,
  model: string,
): Promise<Anthropic.MessageParam[]> {
  if (messages.length <= COMPACT_THRESHOLD) return messages;

  const older = messages.slice(0, messages.length - KEEP_RECENT);
  const recent = messages.slice(messages.length - KEEP_RECENT);

  // One aux model call: summarize the older messages (rendered as plain text so
  // we never split a tool_use / tool_result pair).
  const transcript = older
    .map((m) => `${m.role}: ${typeof m.content === "string" ? m.content : "[tool call / result]"}`)
    .join("\n");
  const reply = await client.messages.create({
    model, max_tokens: 1024,
    system: "Summarize the conversation so far in a few sentences, keeping key facts.",
    messages: [{ role: "user", content: transcript }],
  });
  const summary = reply.content.filter((b) => b.type === "text").map((b: any) => b.text).join("");

  console.log(`  (compacted ${older.length} messages into a summary)`);
  return [{ role: "user", content: `[Summary of earlier conversation]\n${summary}` }, ...recent];
}
```
<!-- @endsnippet -->
#### **Python**
<!-- @snippet lang=py file=context.py region=compact step=7 -->
```python
def maybe_compact(messages, client, model):
    if len(messages) <= COMPACT_THRESHOLD:
        return messages

    older = messages[: len(messages) - KEEP_RECENT]
    recent = messages[len(messages) - KEEP_RECENT :]

    # One aux model call: summarize the older messages (rendered as plain text so
    # we never split a tool_use / tool_result pair).
    transcript = "\n".join(
        f"{m['role']}: {m['content'] if isinstance(m.get('content'), str) else '[tool call / result]'}"
        for m in older
    )
    reply = client.messages.create(
        model=model, max_tokens=1024,
        system="Summarize the conversation so far in a few sentences, keeping key facts.",
        messages=[{"role": "user", "content": transcript}],
    )
    summary = "".join(b.text for b in reply.content if b.type == "text")

    print(f"  (compacted {len(older)} messages into a summary)")
    return [{"role": "user", "content": f"[Summary of earlier conversation]\n{summary}"}, *recent]
```
<!-- @endsnippet -->
<!-- tabs:end -->

Run it: reading a few files grows the history until compaction fires (see the `compacted ... into a summary` line):

<!-- @transcript step=7 lang=ts -->
```
$ node steps/run.mjs 7
▶ step 7 demo (no API key — local mock model)   sandbox: <sandbox>
  you: Read a.txt, then b.txt, then c.txt, then summarize.


  → read_file({"file_path":"a.txt"})

  → read_file({"file_path":"b.txt"})

  → read_file({"file_path":"c.txt"})
  (compacted 5 messages into a summary)
All three read: alpha, beta, gamma.
```
<!-- @endtranscript -->

> That is the whole runnable step for this chapter — everything `node steps/run.mjs` actually executes here is above. Below is how the repo's production mini-claude does the same thing in full: more edge cases and engineering detail. Read it as an **optional deep-dive**; it is not the code the runnable step runs.

Built in layers: execution-time truncation (Tier 0) as the floor catching a single oversized output, with 4 compression tiers on top — Budget, Snip, Microcompact, Auto-compact — from lightest to heaviest; the first three run in order before each API call, and the heaviest, Auto-compact, fires at the turn boundary.

### Tier 0: Execution-Time Truncation (truncateResult)

<!-- tabs:start -->
#### **TypeScript**
```typescript
// tools.ts
const MAX_RESULT_CHARS = 50000;

function truncateResult(result: string): string {
  if (result.length <= MAX_RESULT_CHARS) return result;
  const keepEach = Math.floor((MAX_RESULT_CHARS - 60) / 2);
  return (
    result.slice(0, keepEach) +
    "\n\n[... truncated " + (result.length - keepEach * 2) + " chars ...]\n\n" +
    result.slice(-keepEach)
  );
}
```
#### **Python**
```python
# tools.py
MAX_RESULT_CHARS = 50000

def _truncate_result(result: str) -> str:
    if len(result) <= MAX_RESULT_CHARS:
        return result
    keep_each = (MAX_RESULT_CHARS - 60) // 2
    return (
        result[:keep_each]
        + f"\n\n[... truncated {len(result) - keep_each * 2} chars ...]\n\n"
        + result[-keep_each:]
    )
```
<!-- tabs:end -->

Keeping both head and tail rather than just the head: the beginning of files contains imports, class definitions, and other structural information, while command output error summaries are typically at the end.

Difference from Claude Code: Claude Code persists to disk, and the model can retrieve full content later with the Read tool. We now also implement persistence -- see persistLargeResult below. The two tiers work together, and the order is critical: the tool layer returns the **full** result, the agent layer first persists anything >30KB to disk in full via persistLargeResult (keeping only a preview in context), and truncateResult runs **after** persistence as a safety net -- it only fires in pathological cases (e.g. a preview message dominated by one enormous line). truncateResult must NOT run at the tool layer first: that would put an already-truncated result on disk, losing information before persistence (exactly the bug fixed in issue #6).

### Tier 0.5: Large Result Persistence (persistLargeResult)

When a tool returns a result exceeding 30KB, the full content is written to disk, and only a preview and file path are kept in context. The model can later use `read_file` to retrieve the full output on demand.

```typescript
// agent.ts -- persistLargeResult

private persistLargeResult(toolName: string, result: string): string {
  const THRESHOLD = 30 * 1024; // 30 KB
  if (Buffer.byteLength(result) <= THRESHOLD) return result;

  const dir = join(homedir(), ".mini-claude", "tool-results");
  mkdirSync(dir, { recursive: true });
  const filename = `${Date.now()}-${toolName}.txt`;
  const filepath = join(dir, filename);
  writeFileSync(filepath, result);

  const lines = result.split("\n");
  const preview = lines.slice(0, 200).join("\n");
  const sizeKB = (Buffer.byteLength(result) / 1024).toFixed(1);

  return `[Result too large (${sizeKB} KB, ${lines.length} lines). Full output saved to ${filepath}. You can use read_file to see the full result.]\n\nPreview (first 200 lines):\n${preview}`;
}
```

Key design points for this tier:

- **30KB threshold is lower than truncateResult's 50K limit**: Intercepts large results before truncation occurs, avoiding irreversible information loss. If a result is 80KB, persistLargeResult saves the full content to disk and returns a preview, rather than letting truncateResult permanently discard the middle portion.
- **200-line preview**: Gives the model enough context to decide whether it needs to read the full output. In most cases, the first 200 lines already contain the key information (beginning of file listings, first few matches of search results, main content of command output).
- **Recoverable vs irrecoverable**: This is the fundamental difference from truncateResult. truncateResult is irreversible -- truncated content is gone forever. persistLargeResult saves data to `~/.mini-claude/tool-results/{timestamp}-{toolName}.txt`, and the model can retrieve it at any time with `read_file`.
- **Invocation timing**: Called after each tool execution completes and before results are added to messages in the main loop. This means it takes effect before truncateResult -- the preview text returned after saving is usually well under 50K, so truncation won't be triggered.
- **Alignment with Claude Code**: This design directly corresponds to Claude Code's Level 1 strategy (persist to disk, keep only references in context). The difference is that Claude Code uses a 2KB preview while we use 200 lines -- same concept, simplified implementation.

### Tier 1: Budget -- Dynamic Tool Result Reduction

Dynamically tightens the size of tool results in history based on context pressure:

<!-- tabs:start -->
#### **TypeScript**
```typescript
// agent.ts
private budgetToolResultsAnthropic(): void {
  const utilization = this.lastInputTokenCount / this.effectiveWindow;
  if (utilization < 0.5) return;

  const budget = utilization > 0.7 ? 15000 : 30000;

  for (const msg of this.anthropicMessages) {
    if (msg.role !== "user" || !Array.isArray(msg.content)) continue;
    for (let i = 0; i < msg.content.length; i++) {
      const block = msg.content[i] as any;
      if (block.type === "tool_result" && typeof block.content === "string"
          && block.content.length > budget) {
        const keepEach = Math.floor((budget - 80) / 2);
        block.content = block.content.slice(0, keepEach) +
          `\n\n[... budgeted: ${block.content.length - keepEach * 2} chars truncated ...]\n\n` +
          block.content.slice(-keepEach);
      }
    }
  }
}
```
#### **Python**
```python
# agent.py
def _budget_tool_results_anthropic(self) -> None:
    utilization = self.last_input_token_count / self.effective_window if self.effective_window else 0
    if utilization < 0.5:
        return
    budget = 15000 if utilization > 0.70 else 30000
    for msg in self._anthropic_messages:
        if msg.get("role") != "user" or not isinstance(msg.get("content"), list):
            continue
        for block in msg["content"]:
            if (isinstance(block, dict) and block.get("type") == "tool_result"
                    and isinstance(block.get("content"), str) and len(block["content"]) > budget):
                keep = (budget - 80) // 2
                block["content"] = (
                    block["content"][:keep]
                    + f"\n\n[... budgeted: {len(block['content']) - keep * 2} chars truncated ...]\n\n"
                    + block["content"][-keep:]
                )
```
<!-- tabs:end -->

Tier 0 is a one-time 50K hard limit; Budget recalculates before every API call, with the budget automatically tightening as utilization increases. Using dual thresholds (50%/70%) rather than a single threshold preserves more detail when context space is still ample.

### Tier 2: Snip -- Replace Stale Tool Results

<!-- tabs:start -->
#### **TypeScript**
```typescript
// agent.ts
const SNIPPABLE_TOOLS = new Set(["read_file", "grep_search", "list_files", "run_shell"]);
const SNIP_PLACEHOLDER = "[Content snipped - re-read if needed]";
const KEEP_RECENT_RESULTS = 3;
```
#### **Python**
```python
# agent.py
SNIPPABLE_TOOLS = {"read_file", "grep_search", "list_files", "run_shell"}
SNIP_PLACEHOLDER = "[Content snipped - re-read if needed]"
KEEP_RECENT_RESULTS = 3
```
<!-- tabs:end -->

Snip strategy (triggered when utilization > 60%):
- Same file read multiple times by `read_file` -> keep only the latest, snip older ones
- More than 3 search results of the same type -> snip the oldest
- The 3 most recent `tool_result` entries are always preserved

Key point: **Only the `tool_result` content is cleared; the `tool_use` block is kept intact**. The model can still see "I previously read /src/main.ts" -- it just can't see the content anymore. If needed, it can call `read_file` again. Preserving metadata matters more than preserving data.

### Tier 3: Microcompact -- Aggressive Cleanup When Cache Goes Cold

<!-- tabs:start -->
#### **TypeScript**
```typescript
// agent.ts
const MICROCOMPACT_IDLE_MS = 5 * 60 * 1000;

private microcompactAnthropic(): void {
  if (!this.lastApiCallTime ||
      (Date.now() - this.lastApiCallTime) < MICROCOMPACT_IDLE_MS) return;
  // All old tool_results except the most recent 3 -> "[Old result cleared]"
}
```
#### **Python**
```python
# agent.py
MICROCOMPACT_IDLE_S = 5 * 60

def _microcompact_anthropic(self) -> None:
    if not self.last_api_call_time or (time.time() - self.last_api_call_time) < MICROCOMPACT_IDLE_S:
        return
    # All old tool_results except the most recent 3 -> "[Old result cleared]"
```
<!-- tabs:end -->

The reason for using a time-based trigger: prompt cache has a TTL, and after 5+ minutes of idleness the cache has most likely expired. Continuing to retain old message content has no cost advantage, so aggressive cleanup is preferable.

Snip is selective (only replaces "stale" results); Microcompact is indiscriminate (clears everything except the newest 3) -- more aggressive, but with stricter trigger conditions.

We only implemented the time-based path. Claude Code's cache-edit path relies on the `cache_edits` API mechanism, which is too complex for a teaching implementation.

### Tier 4: Auto-compact -- Full Summary Compression

#### Trigger Condition

<!-- tabs:start -->
#### **TypeScript**
```typescript
// agent.ts
private async checkAndCompact(): Promise<void> {
  if (this.lastInputTokenCount > this.effectiveWindow * 0.85) {
    printInfo("Context window filling up, compacting conversation...");
    await this.compactConversation();
  }
}
```
#### **Python**
```python
# agent.py
async def _check_and_compact(self) -> None:
    if self.last_input_token_count > self.effective_window * 0.85:
        print_info("Context window filling up, compacting conversation...")
        await self._compact_conversation()
```
<!-- tabs:end -->

`effectiveWindow = model context window - 20000`, reserving space for new input/output. For Claude (200K window), the trigger point is at approximately 76.5% total utilization.

> ⚠️ **Caller contract**: `checkAndCompact` must only be called at a turn boundary — after the user message is pushed into the message array and before the API call. The `compactAnthropic` / `compactOpenAI` functions below assume the last message is a plain user-text message: they `slice(0, -1)` it off when building the summarization request and re-append it after the summary lands. If you call them mid-tool-loop, the last message will be a `tool_result` (Anthropic) or a `tool`-role message (OpenAI); slicing it off orphans the preceding `assistant`'s `tool_use` / `tool_calls`, and the API will reject the summarize request.

#### Anthropic Backend Compression

<!-- tabs:start -->
#### **TypeScript**
```typescript
// agent.ts
private async compactAnthropic(): Promise<void> {
  if (this.anthropicMessages.length < 4) return;

  const lastUserMsg = this.anthropicMessages[this.anthropicMessages.length - 1];

  const summaryResp = await this.anthropicClient!.messages.create({
    model: this.model,
    max_tokens: 2048,
    system: "You are a conversation summarizer. Be concise but preserve important details.",
    messages: [
      ...this.anthropicMessages.slice(0, -1),
      {
        role: "user",
        content: "Summarize the conversation so far in a concise paragraph, "
               + "preserving key decisions, file paths, and context needed to continue the work.",
      },
    ],
  });

  const summaryText = summaryResp.content[0]?.type === "text"
    ? summaryResp.content[0].text
    : "No summary available.";

  this.anthropicMessages = [
    {
      role: "user",
      content: `[Previous conversation summary]\n${summaryText}`,
    },
    {
      role: "assistant",
      content: "Understood. I have the context from our previous conversation. "
             + "How can I continue helping?",
    },
  ];

  if (lastUserMsg.role === "user") {
    this.anthropicMessages.push(lastUserMsg);
  }

  this.lastInputTokenCount = 0;
}
```
#### **Python**
```python
# agent.py
async def _compact_anthropic(self) -> None:
    if len(self._anthropic_messages) < 4:
        return

    last_user_msg = self._anthropic_messages[-1]

    summary_resp = await self._anthropic_client.messages.create(
        model=self.model,
        max_tokens=2048,
        system="You are a conversation summarizer. Be concise but preserve important details.",
        messages=[
            *self._anthropic_messages[:-1],
            {"role": "user", "content": "Summarize the conversation so far in a concise paragraph, "
             "preserving key decisions, file paths, and context needed to continue the work."},
        ],
    )
    summary_text = (summary_resp.content[0].text
                    if summary_resp.content and summary_resp.content[0].type == "text"
                    else "No summary available.")

    self._anthropic_messages = [
        {"role": "user", "content": f"[Previous conversation summary]\n{summary_text}"},
        {"role": "assistant", "content": "Understood. I have the context from our previous conversation. How can I continue helping?"},
    ]

    if last_user_msg.get("role") == "user":
        self._anthropic_messages.append(last_user_msg)
    self.last_input_token_count = 0
```
<!-- tabs:end -->

Key differences from Claude Code: Claude Code uses a two-stage "analyze-summarize" prompt for higher quality summaries, restores the 5 most recent files and active skills after compression, and has a circuit breaker to prevent infinite loops. Ours is a simplified version -- single-paragraph summary, no restoration mechanism, no circuit breaker.

#### OpenAI Backend Compression

OpenAI's system prompt lives in the message array (`role: "system"`), so it needs to be preserved separately during compression:

<!-- tabs:start -->
#### **TypeScript**
```typescript
// agent.ts
private async compactOpenAI(): Promise<void> {
  if (this.openaiMessages.length < 5) return;

  const systemMsg = this.openaiMessages[0];
  const lastUserMsg = this.openaiMessages[this.openaiMessages.length - 1];

  const summaryResp = await this.openaiClient!.chat.completions.create({
    model: this.model,
    max_tokens: 2048,
    messages: [
      { role: "system", content: "You are a conversation summarizer. Be concise but preserve important details." },
      ...this.openaiMessages.slice(1, -1),
      { role: "user", content: "Summarize the conversation so far..." },
    ],
  });

  const summaryText = summaryResp.choices[0]?.message?.content || "No summary available.";

  this.openaiMessages = [
    systemMsg,
    { role: "user", content: `[Previous conversation summary]\n${summaryText}` },
    { role: "assistant", content: "Understood. I have the context..." },
  ];

  if ((lastUserMsg as any).role === "user") {
    this.openaiMessages.push(lastUserMsg);
  }

  this.lastInputTokenCount = 0;
}
```
#### **Python**
```python
# agent.py
async def _compact_openai(self) -> None:
    if len(self._openai_messages) < 5:
        return

    system_msg = self._openai_messages[0]
    last_user_msg = self._openai_messages[-1]

    summary_resp = await self._openai_client.chat.completions.create(
        model=self.model,
        max_tokens=2048,
        messages=[
            {"role": "system", "content": "You are a conversation summarizer. Be concise but preserve important details."},
            *self._openai_messages[1:-1],
            {"role": "user", "content": "Summarize the conversation so far..."},
        ],
    )
    summary_text = summary_resp.choices[0].message.content or "No summary available."

    self._openai_messages = [
        system_msg,
        {"role": "user", "content": f"[Previous conversation summary]\n{summary_text}"},
        {"role": "assistant", "content": "Understood. I have the context..."},
    ]

    if last_user_msg.get("role") == "user":
        self._openai_messages.append(last_user_msg)
    self.last_input_token_count = 0
```
<!-- tabs:end -->

The guard condition is `< 5` rather than `< 4`, because the OpenAI message array contains at minimum system + 2 conversation turns + latest user message = 5 entries.

### Manual Compaction

```
> /compact
  ℹ Conversation compacted.
```

Call chain: `cli.ts` -> `agent.compact()` -> `compactConversation()` -> `compactAnthropic()` / `compactOpenAI()`

### Token Statistics and Pipeline Orchestration

Updated after each API call:

<!-- tabs:start -->
#### **TypeScript**
```typescript
const cacheRead = (response.usage as any).cache_read_input_tokens || 0;
const cacheCreation = (response.usage as any).cache_creation_input_tokens || 0;
this.totalInputTokens += response.usage.input_tokens;   // uncached portion only
this.totalCacheReadTokens += cacheRead;
this.totalCacheCreationTokens += cacheCreation;
this.totalOutputTokens += response.usage.output_tokens;
this.lastInputTokenCount =
  response.usage.input_tokens + cacheRead + cacheCreation + response.usage.output_tokens;
```
#### **Python**
```python
cache_read = getattr(response.usage, "cache_read_input_tokens", 0) or 0
cache_creation = getattr(response.usage, "cache_creation_input_tokens", 0) or 0
self.total_input_tokens += response.usage.input_tokens   # uncached portion only
self.total_cache_read_tokens += cache_read
self.total_cache_creation_tokens += cache_creation
self.total_output_tokens += response.usage.output_tokens
self.last_input_token_count = (
    response.usage.input_tokens + cache_read + cache_creation + response.usage.output_tokens
)
```
<!-- tabs:end -->

With caching enabled, `input_tokens` only counts the uncached (missed) portion, so `lastInputTokenCount` (used to decide whether we're approaching the window limit) has to add all three categories of input tokens back in, plus this turn's output -- which becomes part of the prompt on the next turn. `totalInputTokens` accumulates separately from cache read/write; for cost estimation see the "Prefix Caching" section.

The 4 tiers execute sequentially before each API call:

<!-- tabs:start -->
#### **TypeScript**
```typescript
private runCompressionPipeline(): void {
  this.budgetToolResultsAnthropic();   // Tier 1
  this.snipStaleResultsAnthropic();    // Tier 2
  this.microcompactAnthropic();         // Tier 3
}
```
#### **Python**
```python
def _run_compression_pipeline(self) -> None:
    if self.use_openai:
        self._budget_tool_results_openai()
        self._snip_stale_results_openai()
        self._microcompact_openai()
    else:
        self._budget_tool_results_anthropic()
        self._snip_stale_results_anthropic()
        self._microcompact_anthropic()
```
<!-- tabs:end -->

Tiers 1-3 run **before** every API call (zero API cost). Tier 4 runs at the **turn boundary** — after the user message is pushed into the array and before the `while` loop starts. **Do not** place Tier 4 at the end of the tool loop: at that point the last message is `{role: "user", content: [tool_result, ...]}`, and `compactAnthropic`'s `slice(0, -1)` would sever its pairing with the preceding `assistant` message's `tool_use`, causing the Anthropic API to reject the summarize call with *"tool_use ids were found without tool_result blocks immediately after"*. `lastInputTokenCount` is still usable in the new location — it reflects the state of the previous turn's final API call, which is enough to decide whether to trigger. The intra-pipeline order is also intentional: Budget compresses large results first, making Snip's deduplication judgments more accurate, and Microcompact performs indiscriminate cleanup last when the time condition is met.

## Prefix Caching

The tiers above are about "how to shrink context when it gets too big"; this section is about a different thing: given the same prefix, how do we keep the server from recomputing it every turn. Early versions did no caching -- every turn re-sent the full system prompt, tool definitions, and the ever-growing history as brand-new input, billed at full price -- with over five thousand tokens of prefix alone recomputed on every request. Once caching was added, from the second turn onward this part of a multi-turn conversation is essentially free.

Claude Code's full approach is covered in detail in [Chapter 3](https://windy3f3f3f3f.github.io/how-claude-code-works/#/docs/03-context-engineering); here we describe which parts we copied and which we can't.

### Two cache breakpoints

Anthropic's caching never happens on its own -- with no `cache_control` anywhere in the request, nothing is cached and everything is billed at full price. There are two ways to opt in: explicit block-level breakpoints, the way Claude Code does it, or the top-level automatic caching launched in early 2026 (a single top-level `cache_control` field, and the system places and advances the breakpoint automatically). We follow Claude Code's explicit-breakpoint approach and set two:

The first is on the system prompt. `buildAnthropicSystem` splits `system` from a single string into two text blocks -- the static core (the role, rules, and tool descriptions that are identical for every session) is marked `cache_control`, and the dynamic tail (environment, git, skill list) follows without a marker. The tools array doesn't need its own breakpoint: the API's render order is `tools -> system -> messages`, so marking the static system block also caches the tool definitions that come before it.

The second breakpoint rolls onto the last message. Before each request, `withCacheBreakpoints` marks `cache_control` on the last content block of the final message in the array, so that the previous turn and everything earlier all fall within the cached prefix, and only the newly added part of the current turn needs to be reprocessed. It's a pure function that returns a modified copy without touching the original history -- otherwise request metadata like `cache_control` would get written into the session archive and summarization requests. It skips `thinking` blocks because their content is unstable, and marking them would actually lower the hit rate.

<!-- tabs:start -->
#### **TypeScript**
```typescript
private buildAnthropicSystem(): Anthropic.TextBlockParam[] {
  const blocks: Anthropic.TextBlockParam[] = [
    { type: "text", text: this.staticSystemPrompt, cache_control: { type: "ephemeral" } },
  ];
  if (dynamicText) blocks.push({ type: "text", text: dynamicText });
  return blocks;
}
```
#### **Python**
```python
def _build_anthropic_system(self) -> list[dict]:
    blocks = [{"type": "text", "text": self._static_system_prompt,
               "cache_control": {"type": "ephemeral"}}]
    if dynamic_text:
        blocks.append({"type": "text", "text": dynamic_text})
    return blocks
```
<!-- tabs:end -->

CLAUDE.md and the date aren't placed in the system prompt; instead they're wrapped as a `<system-reminder>` and inserted into the first user message (Claude Code's `prependUserContext`). This content varies by project, and leaving it in the system prompt would make the cached static block a separate copy per project, wasting cache.

### Two things we can only approximate

Claude Code has two things that are Anthropic first-party internal capabilities the public API can't offer; we can only approximate them, and we spell that out here:

One is `scope: 'global'` cross-user sharing. Claude Code's static system prompt shares a single cache across all users worldwide. The public API has no such parameter -- omitting it just falls back to the public API's default isolation scope (workspace / organization level, per the current official docs), and this happens to be byte-identical to the fallback path Claude Code takes when it has MCP installed and can't share globally, so it's not really a deviation, just a smaller sharing scope.

The other is `cache_edits` hot-cache in-place deletion. Chapter 3 covered microcompact's two paths, cold and hot: when the cache is cold it modifies messages directly, and when the cache is hot it uses `cache_edits` to have the server delete old results inside the cache without touching local messages. The hot path relies on an internal API -- even the leaked source has this part stripped out. We don't have this path, so we take a step back: when the cache is hot we simply don't modify history. A cache-hit prefix is billed at 0.1x anyway, so re-sending old results is already cheap, and not deleting them costs little.

### Caching and compaction conflict

This step is where the "cache-hot gate" in Tier 2 Snip above comes from. Snip rewrites old tool results in place, but the moment it touches an already-cached prefix, the cache from that message onward is all invalidated. So Snip now first checks whether the cache is hot: while it's still hot and utilization is not high (below 75%), it leaves it alone and waits for the cache to expire on its own; once utilization tops 75%, it would rather break the cache once to free up the window than push all the way to the more expensive auto-compact. In other words, aggressive trimming and prefix caching are inherently at odds -- with caching actually enabled, you don't need to trim as hard.

### How costs are computed

Cache-hit tokens aren't billed at full price: cache read is 0.1x and cache write is 1.25x, matching the multipliers set in Claude Code's `modelCost.ts`. `getCurrentCostUsd` prices these three categories of tokens separately, and `/cost` reports a hit rate alongside. The OpenAI-compatible backend doesn't need to mark `cache_control` -- the provider caches the prefix automatically, and the hit portion is in `prompt_tokens_details.cached_tokens`, which we split out of `prompt_tokens` and count separately. For pricing we uniformly apply Anthropic's 0.1x as an approximation; the actual cached rate varies by provider (officially around 0.5x for OpenAI, and compatible gateways make no guarantee), so the estimate on this path may be off in either direction.

Verified once on a real machine: two turns in a row each sending a single sentence, the first turn had `cache_creation` in the five thousands and `cache_read` at zero (cold start, cache write), and the second turn had `cache_read` filled in, almost equal to what the first turn wrote (a hit). The TS and Python versions gave essentially the same numbers.

## What the Real Claude Code Does Beyond This

Our compression is just four tiers, tried in order before overflow. The real Claude Code does this far more finely: how it assembles context, when to compress, which span to compress, and how not to lose the important parts when it does — every step is deliberate.

### Context Construction

Before each API call, Claude Code assembles three categories of information into the request:

**System prompt** is the most stable part, composed of attribution headers, tool schemas, security rules, etc. It contains a `SYSTEM_PROMPT_DYNAMIC_BOUNDARY` sentinel that splits it into a static half and a dynamic half -- the static half is identical for all users and marked `scope: 'global'` for globally shared caching; the dynamic half (MCP tools, language preferences, etc.) varies by user and is not shared. This allows millions of users worldwide to share the same cached core system prompt, making it one of the primary cost optimization techniques.

**System/user context** is computed once per session and memoized: git status (5 commands executed in parallel), CLAUDE.md files (traversing the directory tree upward from CWD), current date, etc. The injection order is deliberate -- system context is placed after the system prompt, and user context is prepended to the message array, ensuring the most stable content comes first to maximize cache hits.

**Message history** records everything in the conversation and is the primary target of the compression pipeline. Before sending to the API, it goes through `normalizeMessagesForAPI()` to fix formatting issues: attachment reordering, handling thinking blocks, merging split messages, validating `tool_use`/`tool_result` pairing, etc.

### 5-Level Compression Pipeline

The design philosophy is **progressive compression**: use the cheapest methods first, only escalating to heavier weapons when necessary.

**Level 1: Tool Result Budget Trimming** -- Tools declare `maxResultSizeChars` (default 50K chars); when exceeded, results are **persisted to disk**, and only a compact reference with a 2KB preview is kept in context. The choice of persistence over truncation is deliberate: no data is lost, and the model can retrieve the full file at any time using the Read tool.

**Level 2: History Snip** -- A feature-gated capability that trims redundant parts of history. The amount freed is passed to subsequent autocompact threshold calculations, because after snip removes messages, the `usage` on the last assistant message still reflects the pre-snip size -- without correction, this would trigger autocompact prematurely.

**Level 3: Microcompact** -- Cleans up old tool results that are no longer needed, with two paths:
- **Cache has gone cold** (idle for more than N minutes): Directly modifies message content, replacing old tool results with placeholders. Since the cache has expired, modifications won't cause additional invalidation.
- **Cache is still hot**: Uses the API-level `cache_edits` mechanism to delete server-side in place, without modifying local messages at all, avoiding cache prefix invalidation.

**Level 4: Context Collapse** -- Projection-based folding, with the key characteristic of **not modifying original messages**, only creating a folded view. Analogous to a database View: the underlying table doesn't change, but queries see filtered results. When enabled, it suppresses Autocompact to prevent the two from competing.

**Level 5: Autocompact** -- The last resort, forking a sub-Agent to call the API and generate a summary. The trigger threshold is approximately 85.5% context utilization. The compression prompt uses a two-stage "analyze-summarize" approach: first the model reasons in an `<analysis>` block, then generates a standardized `<summary>` (9 sections), and finally strips the reasoning process to keep only the summary -- a classic chain-of-thought draft technique.

### Token Budget and Caching

**Token estimation** never calls additional APIs: it uses the `usage` from the most recent API response as an anchor, and estimates new messages at characters / 4. This reduces error from 30%+ with pure estimation to <5%.

**Prompt caching** is fragile because any byte change in the prefix causes invalidation. Claude Code maintains stability at multiple levels: static/dynamic boundary markers, beta header sticky latching (once sent, it persists regardless of feature flag changes), cache breakpoints at two spots -- the static system block and the last message (the tools array renders before system and gets cached along with its breakpoint), and rupture detection (automatic attribution when `cache_read_input_tokens` drops >5%).

**Circuit breaker**: There was once a session that failed autocompact 3,272 consecutive times, wasting massive API calls. Now it stops retrying after 3 consecutive failures.

## Comparison

| Dimension | Claude Code | mini-claude |
|-----------|------------|-------------|
| **Compression tiers** | 5-level pipeline | 4 tiers (budget + snip + microcompact + summary) |
| **Token counting** | Anchor + rough estimation, no extra API calls | Direct use of API return values, cache read/write priced separately |
| **Budget trigger** | Based on remaining budget | 50%/70% dual threshold |
| **Snip strategy** | Selective trimming + cache awareness | Same-file dedup + keep most recent 3 + cache-hot gate |
| **Microcompact** | Time path + cache edit path | Only 5-minute idle trigger |
| **Prefix caching** | 2 explicit breakpoints (tools covered by system) + scope:global + rupture detection | 2 breakpoints (system + last message), default scope (workspace-level) |
| **Auto-compact** | Two-stage summary + post-compression recovery + circuit breaker | Single-paragraph summary, no recovery |
| **Overflow storage** | Disk persistence, retrievable on demand | Disk persistence (>30KB), retrievable on demand |
---

> **Next chapter**: Let the Agent remember information across sessions -- the memory system.
