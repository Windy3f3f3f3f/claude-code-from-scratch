import Anthropic from "@anthropic-ai/sdk";
import OpenAI from "openai";
import chalk from "chalk";
import { toolDefinitions, executeTool, checkPermission, CONCURRENCY_SAFE_TOOLS, getActiveToolDefinitions, getDeferredToolNames, truncateResult, type ToolDef, type PermissionMode } from "./tools.js";
import {
  printAssistantText,
  printToolCall,
  printToolResult,
  printError,
  printConfirmation,
  printDivider,
  printCost,
  printRetry,
  printInfo,
  printSubAgentStart,
  printSubAgentEnd,
  startSpinner,
  stopSpinner,
} from "./ui.js";
import { saveSession } from "./session.js";
import { buildSystemPrompt, buildStaticSystemPrompt, buildDynamicSystemContext, buildUserContextReminder, loadClaudeMd } from "./prompt.js";
import { getSubAgentConfig, type SubAgentType } from "./subagent.js";
import {
  startMemoryPrefetch, formatMemoriesForInjection,
  type MemoryPrefetch, type RelevantMemory, type SideQueryFn,
} from "./memory.js";
import { McpManager } from "./mcp.js";
import {
  goalDirective, GOAL_EVALUATOR_SYSTEM, GOAL_TRANSCRIPT_FRAMING, goalJudgeUserMessage,
  parseGoalVerdict, GOAL_MAX_ITERATIONS, type GoalVerdict,
  parseLoopInput, isDailyWording, OFFER_CLOUD_THRESHOLD_SECONDS,
  SCHEDULE_WAKEUP_TOOL, clampWakeupDelay, dynamicLoopDirective, LOOP_MAX_ITERATIONS,
  type LoopSpec,
  loadAutoModeRules, buildClassifierSystem, AUTO_MODE_FAST_PATH_TOOLS, DENIAL_LIMITS,
  buildClassifierTranscript, parseBlockVerdict, classifierUserMessage,
} from "./autonomy.js";
import * as readline from "readline";
import { randomUUID } from "crypto";
import { existsSync, readFileSync, mkdirSync, writeFileSync } from "fs";
import { join } from "path";
import { homedir } from "os";

// ─── Retry with exponential backoff ──────────────────────────

function isRetryable(error: any): boolean {
  const status = error?.status || error?.statusCode;
  if ([429, 503, 529].includes(status)) return true;
  if (error?.code === "ECONNRESET" || error?.code === "ETIMEDOUT") return true;
  if (error?.message?.includes("overloaded")) return true;
  return false;
}

async function withRetry<T>(
  fn: (signal?: AbortSignal) => Promise<T>,
  signal?: AbortSignal,
  maxRetries = 3
): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    try {
      return await fn(signal);
    } catch (error: any) {
      if (signal?.aborted) throw error;
      if (attempt >= maxRetries || !isRetryable(error)) throw error;
      const delay = Math.min(1000 * Math.pow(2, attempt), 30000) + Math.random() * 1000;
      const reason = error?.status ? `HTTP ${error.status}` : error?.code || "network error";
      printRetry(attempt + 1, maxRetries, reason);
      await new Promise((r) => setTimeout(r, delay));
    }
  }
}

// ─── Model context windows ──────────────────────────────────

const MODEL_CONTEXT: Record<string, number> = {
  "claude-opus-4-6": 200000,
  "claude-sonnet-4-6": 200000,
  "claude-sonnet-4-20250514": 200000,
  "claude-haiku-4-5-20251001": 200000,
  "claude-opus-4-20250514": 200000,
  "gpt-4o": 128000,
  "gpt-4o-mini": 128000,
};

function getContextWindow(model: string): number {
  return MODEL_CONTEXT[model] || 200000;
}

// ─── Thinking support detection ─────────────────────────────
// Following the general Claude 4.x thinking-mode guidance: adaptive for 4.6, enabled for older Claude 4, disabled for the rest.

function modelSupportsThinking(model: string): boolean {
  const m = model.toLowerCase();
  // Claude 4+ models support thinking (not Claude 3.x)
  if (m.includes("claude-3-") || m.includes("3-5-") || m.includes("3-7-")) return false;
  if (m.includes("claude") && (m.includes("opus") || m.includes("sonnet") || m.includes("haiku"))) return true;
  return false; // non-Claude models (GPT, etc.) — no thinking
}

function modelSupportsAdaptiveThinking(model: string): boolean {
  const m = model.toLowerCase();
  return m.includes("opus-4-6") || m.includes("sonnet-4-6");
}

// Max output tokens by model (following the same caps Claude Code uses publicly)
function getMaxOutputTokens(model: string): number {
  const m = model.toLowerCase();
  if (m.includes("opus-4-6")) return 64000;
  if (m.includes("sonnet-4-6")) return 32000;
  if (m.includes("opus-4") || m.includes("sonnet-4") || m.includes("haiku-4")) return 32000;
  return 16384; // safe default for unknown models
}

// ─── Convert tools to OpenAI format ─────────────────────────

function toOpenAITools(tools: ToolDef[]): OpenAI.ChatCompletionTool[] {
  return tools.map((t) => ({
    type: "function" as const,
    function: {
      name: t.name,
      description: t.description,
      parameters: t.input_schema as Record<string, unknown>,
    },
  }));
}

// ─── Multi-tier compression constants ────────────────────────
// 4-layer compression pipeline inspired by Claude Code's published design: budget → snip → microcompact → auto-compact

const SNIPPABLE_TOOLS = new Set(["read_file", "grep_search", "list_files", "run_shell"]);
const SNIP_PLACEHOLDER = "[Content snipped - re-read if needed]";
const SNIP_THRESHOLD = 0.60;
// Above this utilization we snip even while the cache is hot: preserving the
// cache is not worth risking a context overflow. Below it, a hot cache is left
// untouched (see snip functions). Sits between SNIP_THRESHOLD and autocompact.
const SNIP_HOT_OVERRIDE = 0.75;
const MICROCOMPACT_IDLE_MS = 5 * 60 * 1000; // 5 minutes
const KEEP_RECENT_RESULTS = 3;

// ─── Agent ───────────────────────────────────────────────────

interface AgentOptions {
  permissionMode?: PermissionMode;
  yolo?: boolean;             // Legacy alias for bypassPermissions
  model?: string;
  apiBase?: string;           // OpenAI-compatible base URL
  anthropicBaseURL?: string;  // Anthropic base URL (e.g. proxy)
  apiKey?: string;
  thinking?: boolean;
  maxCostUsd?: number;        // Budget: max USD spend
  maxTurns?: number;          // Budget: max agentic turns
  confirmFn?: (message: string) => Promise<boolean>; // External confirmation callback
  // Sub-agent options
  customSystemPrompt?: string;
  customTools?: ToolDef[];
  isSubAgent?: boolean;
}

export class Agent {
  private anthropicClient?: Anthropic;
  private openaiClient?: OpenAI;
  private useOpenAI: boolean;
  private permissionMode: PermissionMode;
  private thinking: boolean;
  private thinkingMode: "adaptive" | "enabled" | "disabled";
  private model: string;
  private systemPrompt: string;
  private tools: ToolDef[];
  private totalInputTokens = 0;
  private totalOutputTokens = 0;
  private totalCacheReadTokens = 0;      // Prompt-cache hits (billed ~0.1x)
  private totalCacheCreationTokens = 0;  // Prompt-cache writes (billed ~1.25x)
  private lastInputTokenCount = 0;
  private effectiveWindow: number;
  private sessionId: string;
  private sessionStartTime: string;
  private isSubAgent: boolean;

  // MCP integration
  private mcpManager = new McpManager();
  private mcpInitialized = false;

  // Budget control
  private maxCostUsd?: number;
  private maxTurns?: number;
  private currentTurns = 0;

  // /goal — session-scoped Stop-hook condition, pursued across turns
  private activeGoal: {
    condition: string;
    iterations: number;
    startedAt: number;
    lastReason?: string;
  } | null = null;

  private goalStop = false; // set on interrupt to break out of goal pursuit

  // /loop dynamic mode — set when the model calls schedule_wakeup during a tick,
  // read (and cleared) by the loop driver after the turn converges.
  private pendingWakeup: { delaySeconds: number; reason: string; prompt: string } | null = null;
  private loopStop = false; // set on interrupt to break out of a running loop
  // schedule_wakeup is routed to the internal executor only while a dynamic loop
  // is active, so it can't shadow a same-named tool or be reached out of band.
  private scheduleWakeupEnabled = false;

  // Auto Mode — transcript-classifier denial tracking (auto_mode DENIAL_LIMITS).
  private autoConsecutiveDenials = 0;
  private autoTotalDenials = 0;

  // Multi-tier compression state
  private lastApiCallTime = 0;

  // Abort support
  private abortController: AbortController | null = null;

  // Permission whitelist: paths confirmed in this session
  private confirmedPaths: Set<string> = new Set();

  // Plan mode state
  private prePlanMode: PermissionMode | null = null;
  private planFilePath: string | null = null;
  private baseSystemPrompt: string = "";
  // Static/dynamic split for prefix caching: the static half is identical for
  // every session and sits behind a cache_control breakpoint; the dynamic half
  // (env, git, memory, CLAUDE.md) stays uncached. Mirrors Claude Code's
  // splitSysPromptPrefix (see how-claude-code-works ch3.6).
  private staticSystemPrompt: string = "";
  private dynamicSystemContext: string = "";
  // CLAUDE.md + date, injected into the first user message (Claude Code's
  // prependUserContext) rather than the system prompt, so the system stays
  // project-independent and cacheable. Empty for custom system prompts.
  private userContextReminder: string = "";
  private contextCleared: boolean = false; // Set when plan approval clears context

  // External confirmation callback (avoids creating a second readline on stdin)
  private confirmFn?: (message: string) => Promise<boolean>;

  // Plan approval callback: returns { choice, feedback? }
  private planApprovalFn?: (planContent: string) => Promise<{
    choice: "clear-and-execute" | "execute" | "manual-execute" | "keep-planning";
    feedback?: string;
  }>;

  // Sub-agent output buffer (captures text instead of printing)
  private outputBuffer: string[] | null = null;

  // Read-before-edit: track file read timestamps (absolutePath → mtimeMs)
  private readFileState: Map<string, number> = new Map();

  // Memory recall state — semantic prefetch per user turn. The handle lives
  // on the instance so a recall that settles after this turn's last API call
  // is carried over and injected next turn (issue #7).
  private alreadySurfacedMemories: Set<string> = new Set();
  private sessionMemoryBytes = 0;
  private memoryPrefetch: MemoryPrefetch | null = null;

  // Separate message histories for each backend
  private anthropicMessages: Anthropic.MessageParam[] = [];
  private openaiMessages: OpenAI.ChatCompletionMessageParam[] = [];

  constructor(options: AgentOptions = {}) {
    // Permission mode: explicit mode > yolo legacy > default
    this.permissionMode = options.permissionMode
      || (options.yolo ? "bypassPermissions" : "default");
    this.thinking = options.thinking || false;
    this.model = options.model || "claude-opus-4-6";
    this.thinkingMode = this.resolveThinkingMode();
    this.useOpenAI = !!options.apiBase;
    this.isSubAgent = options.isSubAgent || false;
    this.tools = options.customTools || toolDefinitions;
    this.maxCostUsd = options.maxCostUsd;
    this.maxTurns = options.maxTurns;
    this.confirmFn = options.confirmFn;
    this.effectiveWindow = getContextWindow(this.model) - 20000;
    this.sessionId = randomUUID().slice(0, 8);
    this.sessionStartTime = new Date().toISOString();

    // Build system prompt with a static/dynamic split for prefix caching.
    // A custom system prompt overrides both halves (all of it is treated as
    // static). Otherwise the static core is cacheable, env/git/skills form the
    // dynamic tail, and CLAUDE.md + date go into the FIRST user message as a
    // <system-reminder> (Claude Code's prependUserContext) — see chat(). Keeping
    // project-specific content out of the system prompt maximizes cache sharing.
    if (options.customSystemPrompt) {
      this.staticSystemPrompt = options.customSystemPrompt;
      this.dynamicSystemContext = "";
    } else {
      this.staticSystemPrompt = buildStaticSystemPrompt();
      this.dynamicSystemContext = buildDynamicSystemContext();
      this.userContextReminder = buildUserContextReminder();
    }
    this.baseSystemPrompt = this.dynamicSystemContext
      ? this.staticSystemPrompt + "\n\n" + this.dynamicSystemContext
      : this.staticSystemPrompt;
    if (this.permissionMode === "plan") {
      this.planFilePath = this.generatePlanFilePath();
      this.systemPrompt = this.baseSystemPrompt + this.buildPlanModePrompt();
    } else {
      this.systemPrompt = this.baseSystemPrompt;
    }

    // Optional: cap the SDK's own retry layer (default 2). Set
    // MINI_CLAUDE_SDK_MAX_RETRIES=0 to isolate our withRetry() in tests (or to
    // opt out of double-retrying in production).
    const sdkRetries =
      process.env.MINI_CLAUDE_SDK_MAX_RETRIES != null && process.env.MINI_CLAUDE_SDK_MAX_RETRIES !== "" &&
      !Number.isNaN(Number(process.env.MINI_CLAUDE_SDK_MAX_RETRIES))
        ? { maxRetries: Number(process.env.MINI_CLAUDE_SDK_MAX_RETRIES) }
        : {};
    if (this.useOpenAI) {
      this.openaiClient = new OpenAI({
        baseURL: options.apiBase,
        apiKey: options.apiKey,
        ...sdkRetries,
      });
      this.openaiMessages.push({ role: "system", content: this.systemPrompt });
    } else {
      this.anthropicClient = new Anthropic({
        apiKey: options.apiKey,
        ...(options.anthropicBaseURL ? { baseURL: options.anthropicBaseURL } : {}),
        ...sdkRetries,
      });
    }
  }

  // ─── Prefix caching (Anthropic) ─────────────────────────────
  // Build the `system` field as an array of text blocks with a cache_control
  // breakpoint on the static core. Everything up to and including that block
  // (the tool schemas render before `system`, so they are covered too) is
  // cached server-side; the dynamic tail sits after the breakpoint. This is
  // Claude Code's scope-omitted path — the exact bytes it emits when global
  // cache scope is unavailable. See how-claude-code-works ch3.6.
  private buildAnthropicSystem(): Anthropic.TextBlockParam[] {
    const planSuffix = this.permissionMode === "plan" ? this.buildPlanModePrompt() : "";
    const dynamicText = (this.dynamicSystemContext + planSuffix).trim();
    const blocks: Anthropic.TextBlockParam[] = [
      { type: "text", text: this.staticSystemPrompt, cache_control: { type: "ephemeral" } },
    ];
    if (dynamicText) blocks.push({ type: "text", text: dynamicText });
    return blocks;
  }

  // Return a COPY of the message list with a cache_control breakpoint on the
  // last message's final content block, so every prior turn stays in the cached
  // prefix and only the newest messages are processed. Pure: the persistent
  // history is never mutated with this API metadata (Claude Code clones request
  // params at the render layer for the same reason, keeping session save /
  // compact / restore clean). Faithful to CC's assistantMessageToMessageParam,
  // we look only at the very LAST block and skip it when it is a thinking block
  // (unstable content → marking it would hurt cache hits). Only 1 message
  // breakpoint + 1 system breakpoint per request, well under the API cap of 4.
  private withCacheBreakpoints(messages: Anthropic.MessageParam[]): Anthropic.MessageParam[] {
    if (messages.length === 0) return messages;
    const out = messages.slice();
    const idx = out.length - 1;
    const last = out[idx];
    const content = typeof last.content === "string"
      ? [{ type: "text", text: last.content } as any]
      : (last.content as any[]).slice();
    const tail = content[content.length - 1] as any;
    if (tail && tail.type !== "thinking" && tail.type !== "redacted_thinking") {
      content[content.length - 1] = { ...tail, cache_control: { type: "ephemeral" } };
      out[idx] = { ...last, content } as Anthropic.MessageParam;
    }
    return out;
  }

  private resolveThinkingMode(): "adaptive" | "enabled" | "disabled" {
    if (!this.thinking) return "disabled";
    if (!modelSupportsThinking(this.model)) return "disabled";
    if (modelSupportsAdaptiveThinking(this.model)) return "adaptive";
    return "enabled";
  }

  /** Build a sideQuery function for memory recall and the Auto Mode classifier,
   *  works with both backends. temperature:0 for a deterministic decision — the
   *  same input should always yield the same verdict (Claude Code runs the
   *  classifier at temperature 0). */
  private buildSideQuery(): SideQueryFn | null {
    if (this.anthropicClient) {
      const client = this.anthropicClient;
      const model = this.model;
      return async (system, userMessage, signal) => {
        const resp = await client.messages.create({
          model, max_tokens: 256, system, temperature: 0,
          messages: [{ role: "user", content: userMessage }],
        }, { signal });
        return resp.content
          .filter((b): b is Anthropic.TextBlock => b.type === "text")
          .map((b) => b.text).join("");
      };
    }
    if (this.openaiClient) {
      const client = this.openaiClient;
      const model = this.model;
      return async (system, userMessage, _signal) => {
        const resp = await client.chat.completions.create({
          model, max_tokens: 256, temperature: 0,
          messages: [
            { role: "system", content: system },
            { role: "user", content: userMessage },
          ],
        });
        return resp.choices?.[0]?.message?.content || "";
      };
    }
    return null;
  }

  abort() {
    this.abortController?.abort();
  }

  get isProcessing(): boolean {
    return this.abortController !== null;
  }

  setConfirmFn(fn: (message: string) => Promise<boolean>) {
    this.confirmFn = fn;
  }

  setPlanApprovalFn(fn: (planContent: string) => Promise<{
    choice: "clear-and-execute" | "execute" | "manual-execute" | "keep-planning";
    feedback?: string;
  }>) {
    this.planApprovalFn = fn;
  }

  /** Toggle plan mode from the REPL. Returns the new mode description. */
  togglePlanMode(): string {
    if (this.permissionMode === "plan") {
      // Exit plan mode
      this.permissionMode = this.prePlanMode || "default";
      this.prePlanMode = null;
      this.planFilePath = null;
      this.systemPrompt = this.baseSystemPrompt;
      if (this.useOpenAI && this.openaiMessages.length > 0) {
        (this.openaiMessages[0] as any).content = this.systemPrompt;
      }
      printInfo(`Exited plan mode → ${this.permissionMode} mode`);
      return this.permissionMode;
    } else {
      // Enter plan mode
      this.prePlanMode = this.permissionMode;
      this.permissionMode = "plan";
      this.planFilePath = this.generatePlanFilePath();
      this.systemPrompt = this.baseSystemPrompt + this.buildPlanModePrompt();
      if (this.useOpenAI && this.openaiMessages.length > 0) {
        (this.openaiMessages[0] as any).content = this.systemPrompt;
      }
      printInfo(`Entered plan mode. Plan file: ${this.planFilePath}`);
      return "plan";
    }
  }

  getPermissionMode(): string {
    return this.permissionMode;
  }

  getTokenUsage() {
    return { input: this.totalInputTokens, output: this.totalOutputTokens };
  }

  async chat(userMessage: string): Promise<void> {
    // Lazily connect to MCP servers on first chat (main agent only)
    if (!this.mcpInitialized && !this.isSubAgent) {
      this.mcpInitialized = true;
      try {
        await this.mcpManager.loadAndConnect();
        const mcpDefs = this.mcpManager.getToolDefinitions();
        if (mcpDefs.length > 0) {
          this.tools = [...this.tools, ...mcpDefs as ToolDef[]];
        }
      } catch (err: any) {
        console.error(`[mcp] Init failed: ${err.message}`);
      }
    }
    this.abortController = new AbortController();
    try {
      if (this.useOpenAI) {
        await this.chatOpenAI(userMessage);
      } else {
        await this.chatAnthropic(userMessage);
      }
    } finally {
      this.abortController = null;
    }
    if (!this.isSubAgent) {
      printDivider();
      this.autoSave();
    }
  }

  // ─── Sub-agent entry point ────────────────────────────────

  async runOnce(prompt: string): Promise<{ text: string; tokens: { input: number; output: number } }> {
    this.outputBuffer = [];
    const prevInput = this.totalInputTokens;
    const prevOutput = this.totalOutputTokens;
    await this.chat(prompt);
    const text = this.outputBuffer.join("");
    this.outputBuffer = null;
    return {
      text,
      tokens: {
        input: this.totalInputTokens - prevInput,
        output: this.totalOutputTokens - prevOutput,
      },
    };
  }

  // ─── Output helper (captures if sub-agent) ────────────────

  private emitText(text: string): void {
    if (this.outputBuffer) {
      this.outputBuffer.push(text);
    } else {
      printAssistantText(text);
    }
  }

  // ─── REPL commands ──────────────────────────────────────────

  clearHistory() {
    this.anthropicMessages = [];
    this.openaiMessages = [];
    if (this.useOpenAI) {
      this.openaiMessages.push({ role: "system", content: this.systemPrompt });
    }
    this.totalInputTokens = 0;
    this.totalOutputTokens = 0;
    this.totalCacheReadTokens = 0;
    this.totalCacheCreationTokens = 0;
    this.lastInputTokenCount = 0;
    printInfo("Conversation cleared.");
  }

  showCost() {
    const total = this.getCurrentCostUsd();
    const budgetInfo = this.maxCostUsd ? ` / $${this.maxCostUsd} budget` : "";
    const turnInfo = this.maxTurns ? ` | Turns: ${this.currentTurns}/${this.maxTurns}` : "";
    const cached = this.totalCacheReadTokens;
    const billedInput = this.totalInputTokens + this.totalCacheCreationTokens + cached;
    const hitRate = billedInput > 0 ? Math.round((cached / billedInput) * 100) : 0;
    const cacheInfo = (cached || this.totalCacheCreationTokens)
      ? `\n  Cache: ${cached} read / ${this.totalCacheCreationTokens} write (${hitRate}% of input from cache)`
      : "";
    printInfo(
      `Tokens: ${this.totalInputTokens} in / ${this.totalOutputTokens} out${cacheInfo}\n  Estimated cost: $${total.toFixed(4)}${budgetInfo}${turnInfo}`
    );
  }

  // ─── Budget control ────────────────────────────────────────

  private getCurrentCostUsd(): number {
    const M = 1_000_000;
    // Base input $3/Mtok. Cache read is 0.1x, cache write is 1.25x — the fixed
    // multipliers Claude Code uses across every model tier (utils/modelCost.ts).
    const costIn = (this.totalInputTokens / M) * 3;
    const costCacheRead = (this.totalCacheReadTokens / M) * 0.3;
    const costCacheWrite = (this.totalCacheCreationTokens / M) * 3.75;
    const costOut = (this.totalOutputTokens / M) * 15;
    return costIn + costCacheRead + costCacheWrite + costOut;
  }

  private checkBudget(): { exceeded: boolean; reason?: string } {
    if (this.maxCostUsd !== undefined && this.getCurrentCostUsd() >= this.maxCostUsd) {
      return { exceeded: true, reason: `Cost limit reached ($${this.getCurrentCostUsd().toFixed(4)} >= $${this.maxCostUsd})` };
    }
    if (this.maxTurns !== undefined && this.currentTurns >= this.maxTurns) {
      return { exceeded: true, reason: `Turn limit reached (${this.currentTurns} >= ${this.maxTurns})` };
    }
    return { exceeded: false };
  }

  async compact() {
    await this.compactConversation();
  }

  // ─── /goal pursuit ──────────────────────────────────────────
  // A prompt-based Stop hook: after each turn a separate evaluator model judges
  // the condition; not-met feeds its reason into the next turn, met/impossible
  // stop. See autonomy.ts for the (verbatim) evaluator prompt.

  /** Set the active goal and return the first-turn directive to run. */
  setGoal(condition: string): string {
    this.activeGoal = { condition, iterations: 0, startedAt: Date.now() };
    printInfo(`◎ /goal active — Stop hook condition: "${condition}"`);
    return goalDirective(condition);
  }

  /** `/goal` with no argument prints the current goal's status. */
  showGoal(): void {
    if (!this.activeGoal) {
      printInfo("No active goal. Set one with /goal <condition>.");
      return;
    }
    const secs = ((Date.now() - this.activeGoal.startedAt) / 1000).toFixed(1);
    const last = this.activeGoal.lastReason ? `\n  last reason: ${this.activeGoal.lastReason}` : "";
    printInfo(
      `◎ /goal active\n  condition: ${this.activeGoal.condition}\n  iterations: ${this.activeGoal.iterations}\n  elapsed: ${secs}s${last}`
    );
  }

  /** Pursue the active goal: run the directive turn, then loop
   *  evaluate → (not met) feed reason back → next turn, until met, impossible,
   *  budget/iteration cap, or interrupt. */
  async pursueGoal(directive: string): Promise<void> {
    if (!this.activeGoal) return;
    this.goalStop = false;
    try {
      await this.chat(directive);
      // Evaluate the turn that just finished *before* any cap or next-turn
      // decision, so the final turn's output is never left unjudged.
      while (this.activeGoal && !this.goalStop) {
        const verdict = await this.evaluateGoal(this.activeGoal.condition);
        if (verdict.ok) {
          const turns = this.activeGoal.iterations + 1;
          const secs = ((Date.now() - this.activeGoal.startedAt) / 1000).toFixed(1);
          printInfo(`✓ Goal achieved (${turns} turn${turns === 1 ? "" : "s"}, ${secs}s): ${verdict.reason}`);
          break;
        }
        if (verdict.impossible) {
          printInfo(`Hooks: Prompt hook condition judged impossible: ${verdict.reason}`);
          break;
        }

        // Not met: record and decide whether another turn is allowed.
        this.activeGoal.iterations++;
        this.activeGoal.lastReason = verdict.reason;
        printInfo(`Hooks: Prompt hook condition was not met: ${verdict.reason}`);

        const budget = this.checkBudget();
        if (budget.exceeded) { printInfo(`Goal stopped: ${budget.reason}`); break; }
        // Hard ceiling regardless of --max-turns: --max-turns only counts
        // tool-executing turns (checkBudget), so a no-tool goal loop needs an
        // unconditional backstop of its own.
        if (this.activeGoal.iterations >= GOAL_MAX_ITERATIONS) {
          printInfo(`Goal stopped: reached ${GOAL_MAX_ITERATIONS} iterations without meeting the condition.`);
          break;
        }
        if (this.goalStop) break;

        await this.chat(
          `Hooks: Prompt hook condition was not met: ${verdict.reason}\n\nKeep working toward the goal.`
        );
      }
      if (this.goalStop) printInfo("Goal pursuit interrupted.");
    } catch (e: any) {
      if (e?.name !== "AbortError" && !e?.message?.includes("aborted")) throw e;
      // Interrupted (Ctrl+C) mid-turn: stop pursuing the goal.
      printInfo("Goal pursuit interrupted.");
    } finally {
      // Clear on any exit (met / impossible / capped / interrupted) so a stale
      // goal never lingers. Real Claude Code keeps it session-scoped and
      // resumable; we don't implement resume.
      this.activeGoal = null;
    }
  }

  /** One evaluator pass over the just-finished turn's transcript. The transcript
   *  is sent as its own assistant message (framed by a preceding user message
   *  as data-to-judge), so a crafted turn can't smuggle fake user/judge text
   *  into the evaluator's context — real Claude Code likewise sends the turn as
   *  a separate transcript message, not inlined into the judge prompt. */
  private async evaluateGoal(condition: string): Promise<GoalVerdict> {
    const transcript = this.extractLastAssistantText();
    const messages = [
      { role: "user" as const, content: GOAL_TRANSCRIPT_FRAMING },
      { role: "assistant" as const, content: transcript || "(no assistant output)" },
      { role: "user" as const, content: goalJudgeUserMessage(condition) },
    ];
    try {
      const raw = await this.runEvaluatorQuery(GOAL_EVALUATOR_SYSTEM, messages);
      return parseGoalVerdict(raw);
    } catch (e: any) {
      // Evaluator error → treat as not-met (never accidentally clears the goal).
      return { ok: false, reason: `evaluator error: ${e?.message ?? e}` };
    }
  }

  /** Send a role-separated evaluator query on whichever backend is configured
   *  and return the model's text. Like buildSideQuery but takes a full messages
   *  array (buildSideQuery is single-user-message, for memory recall). */
  private async runEvaluatorQuery(
    system: string,
    messages: { role: "user" | "assistant"; content: string }[],
  ): Promise<string> {
    if (this.anthropicClient) {
      const resp = await this.anthropicClient.messages.create({
        model: this.model, max_tokens: 512, system, temperature: 0, messages,
      });
      return resp.content
        .filter((b): b is Anthropic.TextBlock => b.type === "text")
        .map((b) => b.text).join("");
    }
    if (this.openaiClient) {
      const resp = await this.openaiClient.chat.completions.create({
        model: this.model, max_tokens: 512, temperature: 0,
        messages: [{ role: "system", content: system }, ...messages],
      });
      return resp.choices?.[0]?.message?.content || "";
    }
    throw new Error("no evaluator model available");
  }

  /** Single-message classifier query with a caller-chosen max_tokens, so the
   *  two Auto Mode stages can size their budgets differently (stage 1 is a tiny
   *  gate, stage 2 has room to think). temperature:0 for a deterministic
   *  verdict, matching Claude Code's classifier. */
  private async runClassifierQuery(system: string, user: string, maxTokens: number): Promise<string> {
    if (this.anthropicClient) {
      const resp = await this.anthropicClient.messages.create({
        model: this.model, max_tokens: maxTokens, system, temperature: 0,
        messages: [{ role: "user", content: user }],
      }, { signal: this.abortController?.signal });
      return resp.content
        .filter((b): b is Anthropic.TextBlock => b.type === "text")
        .map((b) => b.text).join("");
    }
    if (this.openaiClient) {
      const resp = await this.openaiClient.chat.completions.create({
        model: this.model, max_tokens: maxTokens, temperature: 0,
        messages: [{ role: "system", content: system }, { role: "user", content: user }],
      });
      return resp.choices?.[0]?.message?.content || "";
    }
    throw new Error("no classifier model available");
  }

  /** The text of the most recent assistant turn, for the evaluator to judge.
   *  Transcript-only: real Claude Code feeds the whole transcript but the
   *  action under judgement is the latest turn. */
  private extractLastAssistantText(): string {
    if (this.useOpenAI) {
      for (let i = this.openaiMessages.length - 1; i >= 0; i--) {
        const m: any = this.openaiMessages[i];
        if (m.role === "assistant" && typeof m.content === "string") return m.content;
      }
      return "";
    }
    for (let i = this.anthropicMessages.length - 1; i >= 0; i--) {
      const m: any = this.anthropicMessages[i];
      if (m.role !== "assistant") continue;
      if (typeof m.content === "string") return m.content;
      if (Array.isArray(m.content)) {
        return m.content
          .filter((b: any) => b.type === "text")
          .map((b: any) => b.text)
          .join("");
      }
    }
    return "";
  }

  // ─── /loop — recurring or self-paced prompt ─────────────────
  // Unlike /goal (a stop-hook gate), /loop actively reschedules itself: a fixed
  // interval, or — with no interval — a pace the main model picks via the
  // schedule_wakeup tool. See autonomy.ts for the parser and tool schema.

  /** Entry point for the /loop command. Parses the input, then drives the
   *  matching mode. Returns without looping if the input is malformed. */
  async runLoop(rawInput: string): Promise<void> {
    const spec = parseLoopInput(rawInput);
    if ("error" in spec) {
      printInfo(spec.error);
      return;
    }
    // Offer-cloud decision point (interval ≥60min or daily wording). Real Claude
    // Code asks whether to convert to a persistent cloud schedule that survives
    // the session; this teaching CLI has no cloud, so we only surface it.
    const wantsCloud =
      (spec.mode === "interval" && spec.intervalSeconds! >= OFFER_CLOUD_THRESHOLD_SECONDS) ||
      isDailyWording(rawInput);
    if (wantsCloud) {
      printInfo("(Real Claude Code would offer to convert this to a persistent cloud schedule that keeps running after the session ends. This teaching build has no cloud backend — continuing in-session.)");
    }

    this.loopStop = false;
    try {
      if (spec.mode === "interval") {
        await this.runLoopInterval(spec);
      } else {
        await this.runLoopDynamic(spec);
      }
    } catch (e: any) {
      if (e?.name !== "AbortError" && !e?.message?.includes("aborted")) throw e;
      printInfo("Loop interrupted.");
    }
  }

  /** Interval mode: re-run the prompt every N seconds until interrupted or the
   *  iteration cap. Corresponds to Claude Code's in-session CronCreate path
   *  (session-only, not persisted). We use a plain timer in place of the cron
   *  engine + KAIROS daemon. */
  private async runLoopInterval(spec: LoopSpec): Promise<void> {
    printInfo(`⟳ /loop scheduled every ${spec.intervalLabel} (session-only, not persisted — dies when this process exits). Ctrl+C to stop.`);
    let iterations = 0;
    while (!this.loopStop && !this.abortController?.signal.aborted) {
      iterations++;
      printInfo(`⟳ loop tick ${iterations}`);
      await this.chat(spec.prompt);

      const budget = this.checkBudget();
      if (budget.exceeded) { printInfo(`Loop stopped: ${budget.reason}`); break; }
      // --max-turns also bounds loop ticks: checkBudget's turn counter only
      // increments on tool-executing turns, so a plain-text loop would never
      // hit it — treat --max-turns as a tick limit here too.
      if (this.maxTurns !== undefined && iterations >= this.maxTurns) {
        printInfo(`Loop stopped: tick limit reached (${iterations} >= ${this.maxTurns}).`);
        break;
      }
      if (iterations >= LOOP_MAX_ITERATIONS) {
        printInfo(`Loop stopped: reached ${LOOP_MAX_ITERATIONS} ticks.`);
        break;
      }
      const interrupted = await this.interruptibleSleep(spec.intervalSeconds! * 1000);
      if (interrupted) { printInfo("Loop stopped."); break; }
    }
  }

  /** Dynamic mode: run the tick, then let the main model self-pace via
   *  schedule_wakeup. If it scheduled a wakeup, wait the (clamped) delay and run
   *  again with the prompt it passed back; if it didn't, the loop has converged.
   *  Faithful to "dynamic pacing is decided by the main model, no separate
   *  evaluator." schedule_wakeup is exposed only for the duration of the loop. */
  private async runLoopDynamic(spec: LoopSpec): Promise<void> {
    printInfo("⟳ /loop dynamic (self-paced) — the model schedules its own next run, or ends the loop. Ctrl+C to stop.");
    const hadTool = this.tools.some(t => t.name === "schedule_wakeup");
    if (!hadTool) this.tools = [...this.tools, SCHEDULE_WAKEUP_TOOL as ToolDef];
    this.scheduleWakeupEnabled = true;
    let prompt = spec.prompt;
    let iterations = 0;
    try {
      while (!this.loopStop && !this.abortController?.signal.aborted) {
        iterations++;
        this.pendingWakeup = null;
        await this.chat(dynamicLoopDirective(prompt));

        if (!this.pendingWakeup) {
          printInfo(`⟳ Loop converged after ${iterations} tick${iterations === 1 ? "" : "s"} (model scheduled no wakeup).`);
          break;
        }
        const budget = this.checkBudget();
        if (budget.exceeded) { printInfo(`Loop stopped: ${budget.reason}`); break; }
        if (this.maxTurns !== undefined && iterations >= this.maxTurns) {
          printInfo(`Loop stopped: tick limit reached (${iterations} >= ${this.maxTurns}).`);
          break;
        }
        if (iterations >= LOOP_MAX_ITERATIONS) {
          printInfo(`Loop stopped: reached ${LOOP_MAX_ITERATIONS} ticks.`);
          break;
        }
        const { delaySeconds, reason, prompt: nextPrompt } = this.pendingWakeup;
        printInfo(`⟳ next run in ${delaySeconds}s — ${reason}`);
        prompt = nextPrompt || prompt;
        const interrupted = await this.interruptibleSleep(delaySeconds * 1000);
        if (interrupted) { printInfo("Loop stopped."); break; }
      }
    } finally {
      // Remove schedule_wakeup so it isn't exposed outside the dynamic loop.
      if (!hadTool) this.tools = this.tools.filter(t => t.name !== "schedule_wakeup");
      this.scheduleWakeupEnabled = false;
      this.pendingWakeup = null;
    }
  }

  /** schedule_wakeup executor: record the requested wakeup for the loop driver.
   *  Delay is clamped to [60, 3600]; the driver reads pendingWakeup after the
   *  turn converges. */
  private executeScheduleWakeup(input: Record<string, any>): string {
    const delaySeconds = clampWakeupDelay(Number(input.delaySeconds));
    const reason = typeof input.reason === "string" ? input.reason : "";
    const prompt = typeof input.prompt === "string" ? input.prompt : "";
    this.pendingWakeup = { delaySeconds, reason, prompt };
    return `Wakeup scheduled in ${delaySeconds}s. The loop will resume then; end your turn now.`;
  }

  /** Sleep that resolves early (returning true) if the loop is stopped or the
   *  turn is aborted. Avoids blocking on a long interval past a Ctrl+C. */
  private interruptibleSleep(ms: number): Promise<boolean> {
    return new Promise((resolve) => {
      const start = Date.now();
      const tick = () => {
        if (this.loopStop || this.abortController?.signal.aborted) return resolve(true);
        if (Date.now() - start >= ms) return resolve(false);
        setTimeout(tick, Math.min(200, ms));
      };
      tick();
    });
  }

  /** Stop a running /loop (called from the REPL's interrupt handler). */
  stopLoop(): void {
    this.loopStop = true;
  }

  /** Stop a running /goal pursuit (called from the REPL's interrupt handler).
   *  Takes effect at the next turn boundary — an in-flight turn is aborted
   *  separately via abort(). */
  stopGoal(): void {
    this.goalStop = true;
  }

  // ─── Auto Mode — transcript-classifier permission gate ──────
  // In `auto` mode the classifier replaces the human confirm prompt: deny rules
  // still hard-block, read-only tools fast-path through, everything else is
  // judged by an LLM reading a reasoning-blind transcript projection.

  /** Decide a tool call in Auto Mode. Returns allow/deny like checkPermission,
   *  or "confirm" to hand back to a human once the denial limits trip.
   *
   *  Two-stage, mirroring Claude Code's `both` mode: stage 1 is an aggressive
   *  cheap gate (no user intent, no ALLOW exceptions — block if any rule *could*
   *  apply); if stage 1 allows, we're done in one call. If stage 1 blocks, stage
   *  2 does the careful adjudication that DOES weigh user intent and can clear
   *  the block. Stage 2's verdict is final. */
  private async classifyToolCall(
    toolName: string,
    input: Record<string, any>,
  ): Promise<{ action: "allow" | "deny" | "confirm"; message?: string }> {
    // Hard floor first: deny rules bind even here.
    const base = checkPermission(toolName, input, "default", this.planFilePath || undefined);
    if (base.action === "deny") return base;
    // Fast-path: read-only / side-effect-free tools skip the classifier.
    if (AUTO_MODE_FAST_PATH_TOOLS.has(toolName)) return { action: "allow" };

    if (!this.anthropicClient && !this.openaiClient) {
      // No evaluator available → fail closed. Defer to a human if one is present
      // (interactive), else deny outright (headless: Claude Code aborts here).
      return this.autoFallback(`${toolName} (auto-mode classifier unavailable)`);
    }
    let verdict: { block: boolean; reason: string };
    try {
      const rules = loadAutoModeRules();
      const history = this.useOpenAI ? this.openaiMessages : this.anthropicMessages;
      const transcript = buildClassifierTranscript(history as any, { toolName, input });
      const system = buildClassifierSystem(rules);
      // CLAUDE.md rides in the user message, not the system prompt — it is
      // untrusted repo content.
      const claudeMd = loadClaudeMd();
      // Stage 1 — aggressive cheap gate (small token budget: just <block>…).
      const s1raw = await this.runClassifierQuery(system, classifierUserMessage(rules, transcript, rules.suffix_stage1, claudeMd), 256);
      const s1 = parseBlockVerdict(s1raw);
      if (!s1.block) {
        verdict = s1;                 // stage 1 cleared it → allow (one call)
      } else {
        // Stage 2 — careful adjudication (weighs user intent, can clear). More
        // tokens: stage 2 may emit a <thinking> block before its verdict.
        const s2raw = await this.runClassifierQuery(system, classifierUserMessage(rules, transcript, rules.suffix_stage2, claudeMd), 1024);
        verdict = parseBlockVerdict(s2raw);
      }
    } catch (e: any) {
      // Any setup or classifier error → fail closed (block), matching Claude
      // Code's iron gate. Wrapping the asset load here too keeps a missing/bad
      // rules file from crashing the turn and orphaning the tool_use.
      verdict = { block: true, reason: `classifier error: ${e?.message ?? e}` };
    }

    if (!verdict.block) {
      this.autoConsecutiveDenials = 0;
      return { action: "allow" };
    }

    this.autoConsecutiveDenials++;
    this.autoTotalDenials++;
    if (
      this.autoConsecutiveDenials >= DENIAL_LIMITS.maxConsecutive ||
      this.autoTotalDenials >= DENIAL_LIMITS.maxTotal
    ) {
      // Too many denials — the classifier may be stuck. Hand back to a human if
      // interactive; deny in headless (Claude Code aborts the agent here).
      printInfo(`Auto Mode: denial limit reached — handing back to manual confirmation.`);
      return this.autoFallback(`[Auto Mode blocked] ${verdict.reason}`);
    }
    return { action: "deny", message: `[Auto Mode] ${verdict.reason}` };
  }

  /** Auto Mode fail-safe: defer to a human confirm if one is available, else
   *  deny (headless). Never returns "allow" — the point is to not run an
   *  unjudged action. Auto confirms carry a per-tool digest, not a bare reason,
   *  so a single approval doesn't whitelist a whole class of later actions. */
  private autoFallback(message: string): { action: "deny" | "confirm"; message: string } {
    if (this.confirmFn) return { action: "confirm", message };
    return { action: "deny", message: `${message} (headless — denied)` };
  }

  /** Permission mode a spawned sub-agent inherits. plan and auto must carry
   *  through — a sub-agent otherwise runs bypassPermissions, so in Auto Mode the
   *  main model could launder a blocked action through `agent(prompt="git push
   *  origin main")` and have the sub-agent run it unclassified. Claude Code puts
   *  every sub-agent tool call through canUseTool individually. */
  private childPermissionMode(): PermissionMode {
    if (this.permissionMode === "plan") return "plan";
    if (this.permissionMode === "auto") return "auto";
    return "bypassPermissions";
  }

  // ─── Session restore ───────────────────────────────────────

  restoreSession(data: { anthropicMessages?: any[]; openaiMessages?: any[] }) {
    if (data.anthropicMessages) this.anthropicMessages = data.anthropicMessages;
    if (data.openaiMessages) this.openaiMessages = data.openaiMessages;
    printInfo(`Session restored (${this.getMessageCount()} messages).`);
  }

  private getMessageCount(): number {
    return this.useOpenAI ? this.openaiMessages.length : this.anthropicMessages.length;
  }

  private autoSave() {
    try {
      saveSession(this.sessionId, {
        metadata: {
          id: this.sessionId,
          model: this.model,
          cwd: process.cwd(),
          startTime: this.sessionStartTime,
          messageCount: this.getMessageCount(),
        },
        anthropicMessages: this.useOpenAI ? undefined : this.anthropicMessages,
        openaiMessages: this.useOpenAI ? this.openaiMessages : undefined,
      });
    } catch {}
  }

  // ─── Autocompact ───────────────────────────────────────────

  private async checkAndCompact(): Promise<void> {
    if (this.lastInputTokenCount > this.effectiveWindow * 0.85) {
      printInfo("Context window filling up, compacting conversation...");
      await this.compactConversation();
    }
  }

  private async compactConversation(): Promise<void> {
    if (this.useOpenAI) {
      await this.compactOpenAI();
    } else {
      await this.compactAnthropic();
    }
    printInfo("Conversation compacted.");
  }

  private async compactAnthropic(): Promise<void> {
    // Invariant: caller must ensure the last message is a plain user-text
    // message (not a tool_result). We slice it off below; if it were a
    // tool_result, the preceding assistant's tool_use would be orphaned and
    // the API would reject the summarize call.
    if (this.anthropicMessages.length < 4) return;
    const lastUserMsg = this.anthropicMessages[this.anthropicMessages.length - 1];
    const summaryReq: Anthropic.MessageParam[] = [
      {
        role: "user",
        content:
          "Summarize the conversation so far in a concise paragraph, preserving key decisions, file paths, and context needed to continue the work.",
      },
    ];
    const summaryResp = await this.anthropicClient!.messages.create({
      model: this.model,
      max_tokens: 2048,
      system: "You are a conversation summarizer. Be concise but preserve important details.",
      messages: [
        ...this.anthropicMessages.slice(0, -1),
        ...summaryReq,
      ],
    });
    const summaryText =
      summaryResp.content[0]?.type === "text"
        ? summaryResp.content[0].text
        : "No summary available.";
    this.anthropicMessages = [
      { role: "user", content: `[Previous conversation summary]\n${summaryText}` },
      { role: "assistant", content: "Understood. I have the context from our previous conversation. How can I continue helping?" },
    ];
    if (lastUserMsg.role === "user") this.anthropicMessages.push(lastUserMsg);
    this.lastInputTokenCount = 0;
  }

  private async compactOpenAI(): Promise<void> {
    // Invariant: caller must ensure the last message is a plain user-text
    // message (not a `tool` role result). Same reasoning as compactAnthropic
    // — slicing off a tool result would orphan the preceding assistant's
    // tool_calls.
    if (this.openaiMessages.length < 5) return;
    const systemMsg = this.openaiMessages[0];
    const lastUserMsg = this.openaiMessages[this.openaiMessages.length - 1];
    const summaryResp = await this.openaiClient!.chat.completions.create({
      model: this.model,
      max_tokens: 2048,
      messages: [
        { role: "system", content: "You are a conversation summarizer. Be concise but preserve important details." },
        ...this.openaiMessages.slice(1, -1),
        { role: "user", content: "Summarize the conversation so far in a concise paragraph, preserving key decisions, file paths, and context needed to continue the work." },
      ],
    });
    const summaryText = summaryResp.choices[0]?.message?.content || "No summary available.";
    this.openaiMessages = [
      systemMsg,
      { role: "user", content: `[Previous conversation summary]\n${summaryText}` },
      { role: "assistant", content: "Understood. I have the context from our previous conversation. How can I continue helping?" },
    ];
    if ((lastUserMsg as any).role === "user") this.openaiMessages.push(lastUserMsg);
    this.lastInputTokenCount = 0;
  }

  // ─── Multi-tier compression pipeline ──────────────────────
  // 4-layer compression inspired by Claude Code's published design: budget → snip → microcompact → auto-compact
  // Tiers 1-3 are zero-API-cost, operating on the local message array.

  private runCompressionPipeline(): void {
    if (this.useOpenAI) {
      this.budgetToolResultsOpenAI();
      this.snipStaleResultsOpenAI();
      this.microcompactOpenAI();
    } else {
      this.budgetToolResultsAnthropic();
      this.snipStaleResultsAnthropic();
      this.microcompactAnthropic();
    }
  }

  // Tier 1: Budget tool results — dynamically shrink large results as context fills
  private budgetToolResultsAnthropic(): void {
    const utilization = this.lastInputTokenCount / this.effectiveWindow;
    if (utilization < 0.5) return;
    const budget = utilization > 0.7 ? 15000 : 30000;

    for (const msg of this.anthropicMessages) {
      if (msg.role !== "user" || !Array.isArray(msg.content)) continue;
      for (let i = 0; i < msg.content.length; i++) {
        const block = msg.content[i] as any;
        if (block.type === "tool_result" && typeof block.content === "string" && block.content.length > budget) {
          const keepEach = Math.floor((budget - 80) / 2);
          block.content = block.content.slice(0, keepEach) +
            `\n\n[... budgeted: ${block.content.length - keepEach * 2} chars truncated ...]\n\n` +
            block.content.slice(-keepEach);
        }
      }
    }
  }

  private budgetToolResultsOpenAI(): void {
    const utilization = this.lastInputTokenCount / this.effectiveWindow;
    if (utilization < 0.5) return;
    const budget = utilization > 0.7 ? 15000 : 30000;

    for (const msg of this.openaiMessages) {
      if ((msg as any).role === "tool" && typeof (msg as any).content === "string") {
        const content = (msg as any).content as string;
        if (content.length > budget) {
          const keepEach = Math.floor((budget - 80) / 2);
          (msg as any).content = content.slice(0, keepEach) +
            `\n\n[... budgeted: ${content.length - keepEach * 2} chars truncated ...]\n\n` +
            content.slice(-keepEach);
        }
      }
    }
  }

  // Tier 2: Snip stale results — replace old/duplicate tool results with placeholder
  private snipStaleResultsAnthropic(): void {
    // Cache-aware gate (mirrors Claude Code's cached-microcompact split): while
    // the prompt cache is still hot, rewriting an old tool_result in place would
    // invalidate the entire cached message prefix. Claude Code prunes hot caches
    // via a cache_edits API call unavailable on the public API, so we leave the
    // hot prefix alone — UNTIL utilization is high enough (SNIP_HOT_OVERRIDE)
    // that risking an overflow costs more than one cache rebuild. Below that we
    // wait for the cache to go cold.
    const utilization = this.lastInputTokenCount / this.effectiveWindow;
    const cacheHot = this.lastApiCallTime > 0 && (Date.now() - this.lastApiCallTime) < MICROCOMPACT_IDLE_MS;
    if (cacheHot && utilization < SNIP_HOT_OVERRIDE) return;
    if (utilization < SNIP_THRESHOLD) return;

    // Collect all tool_result blocks with metadata
    const results: { msgIdx: number; blockIdx: number; toolName: string; filePath?: string }[] = [];
    for (let mi = 0; mi < this.anthropicMessages.length; mi++) {
      const msg = this.anthropicMessages[mi];
      if (msg.role !== "user" || !Array.isArray(msg.content)) continue;
      for (let bi = 0; bi < msg.content.length; bi++) {
        const block = msg.content[bi] as any;
        if (block.type === "tool_result" && typeof block.content === "string" && block.content !== SNIP_PLACEHOLDER) {
          // Find the corresponding tool_use to get tool name and input
          const toolUseId = block.tool_use_id;
          const toolInfo = this.findToolUseById(toolUseId);
          if (toolInfo && SNIPPABLE_TOOLS.has(toolInfo.name)) {
            results.push({ msgIdx: mi, blockIdx: bi, toolName: toolInfo.name, filePath: toolInfo.input?.file_path });
          }
        }
      }
    }

    if (results.length <= KEEP_RECENT_RESULTS) return;

    // Strategy: snip duplicates and old results, keep recent N
    const toSnip = new Set<number>();
    const seenFiles = new Map<string, number[]>(); // filePath → indices

    for (let i = 0; i < results.length; i++) {
      const r = results[i];
      if (r.toolName === "read_file" && r.filePath) {
        const existing = seenFiles.get(r.filePath) || [];
        existing.push(i);
        seenFiles.set(r.filePath, existing);
      }
    }

    // Snip earlier reads of same file
    for (const indices of seenFiles.values()) {
      if (indices.length > 1) {
        for (let j = 0; j < indices.length - 1; j++) toSnip.add(indices[j]);
      }
    }

    // Snip oldest results beyond keep-recent threshold
    const snipBefore = results.length - KEEP_RECENT_RESULTS;
    for (let i = 0; i < snipBefore; i++) toSnip.add(i);

    for (const idx of toSnip) {
      const r = results[idx];
      const block = (this.anthropicMessages[r.msgIdx].content as any[])[r.blockIdx];
      block.content = SNIP_PLACEHOLDER;
    }
  }

  private snipStaleResultsOpenAI(): void {
    // Cache-aware gate — see snipStaleResultsAnthropic. OpenAI-compatible
    // providers cache prefixes automatically, so the same "don't rewrite a hot
    // prefix (unless utilization is high)" rule applies.
    const utilization = this.lastInputTokenCount / this.effectiveWindow;
    const cacheHot = this.lastApiCallTime > 0 && (Date.now() - this.lastApiCallTime) < MICROCOMPACT_IDLE_MS;
    if (cacheHot && utilization < SNIP_HOT_OVERRIDE) return;
    if (utilization < SNIP_THRESHOLD) return;

    // Collect tool messages
    const toolMsgs: { idx: number; toolCallId: string }[] = [];
    for (let i = 0; i < this.openaiMessages.length; i++) {
      const msg = this.openaiMessages[i] as any;
      if (msg.role === "tool" && typeof msg.content === "string" && msg.content !== SNIP_PLACEHOLDER) {
        toolMsgs.push({ idx: i, toolCallId: msg.tool_call_id });
      }
    }

    if (toolMsgs.length <= KEEP_RECENT_RESULTS) return;

    // Snip all but the most recent N
    const snipCount = toolMsgs.length - KEEP_RECENT_RESULTS;
    for (let i = 0; i < snipCount; i++) {
      (this.openaiMessages[toolMsgs[i].idx] as any).content = SNIP_PLACEHOLDER;
    }
  }

  // Tier 3: Microcompact — aggressively clear old results when prompt cache is cold
  private microcompactAnthropic(): void {
    if (!this.lastApiCallTime || (Date.now() - this.lastApiCallTime) < MICROCOMPACT_IDLE_MS) return;

    // Collect ALL tool_results across messages, clear all but recent N
    const allResults: { msgIdx: number; blockIdx: number }[] = [];
    for (let mi = 0; mi < this.anthropicMessages.length; mi++) {
      const msg = this.anthropicMessages[mi];
      if (msg.role !== "user" || !Array.isArray(msg.content)) continue;
      for (let bi = 0; bi < msg.content.length; bi++) {
        const block = msg.content[bi] as any;
        if (block.type === "tool_result" && typeof block.content === "string" &&
            block.content !== SNIP_PLACEHOLDER && block.content !== "[Old result cleared]") {
          allResults.push({ msgIdx: mi, blockIdx: bi });
        }
      }
    }

    const clearCount = allResults.length - KEEP_RECENT_RESULTS;
    for (let i = 0; i < clearCount && i < allResults.length; i++) {
      const r = allResults[i];
      (this.anthropicMessages[r.msgIdx].content as any[])[r.blockIdx].content = "[Old result cleared]";
    }
  }

  private microcompactOpenAI(): void {
    if (!this.lastApiCallTime || (Date.now() - this.lastApiCallTime) < MICROCOMPACT_IDLE_MS) return;

    const toolMsgs: number[] = [];
    for (let i = 0; i < this.openaiMessages.length; i++) {
      const msg = this.openaiMessages[i] as any;
      if (msg.role === "tool" && typeof msg.content === "string" &&
          msg.content !== SNIP_PLACEHOLDER && msg.content !== "[Old result cleared]") {
        toolMsgs.push(i);
      }
    }

    const clearCount = toolMsgs.length - KEEP_RECENT_RESULTS;
    for (let i = 0; i < clearCount && i < toolMsgs.length; i++) {
      (this.openaiMessages[toolMsgs[i]] as any).content = "[Old result cleared]";
    }
  }

  // Helper: find a tool_use block by its ID in assistant messages
  private findToolUseById(toolUseId: string): { name: string; input: any } | null {
    for (const msg of this.anthropicMessages) {
      if (msg.role !== "assistant" || !Array.isArray(msg.content)) continue;
      for (const block of msg.content as any[]) {
        if (block.type === "tool_use" && block.id === toolUseId) {
          return { name: block.name, input: block.input };
        }
      }
    }
    return null;
  }

  // ─── Execute tool (handles agent tool internally) ─────────

  // ─── Large result persistence ───────────────────────────────
  // When a tool result exceeds 30 KB, write it to disk and replace the
  // context entry with a short preview + file path.  The model can use
  // read_file to retrieve the full output later — no information is lost.

  private persistLargeResult(toolName: string, result: string): string {
    const THRESHOLD = 30 * 1024; // 30 KB
    if (Buffer.byteLength(result) <= THRESHOLD) return result;

    const dir = join(homedir(), ".mini-claude", "tool-results");
    mkdirSync(dir, { recursive: true });
    // uuid suffix: parallel tools can persist in the same millisecond — a
    // timestamp-only name would let the second write clobber the first.
    const filename = `${Date.now()}-${randomUUID().slice(0, 8)}-${toolName}.txt`;
    const filepath = join(dir, filename);
    writeFileSync(filepath, result);

    const lines = result.split("\n");
    const preview = lines.slice(0, 200).join("\n");
    const sizeKB = (Buffer.byteLength(result) / 1024).toFixed(1);

    // Truncate AFTER persisting: the full result is already safe on disk, so
    // this only guards against pathological previews (e.g. a single
    // multi-hundred-KB line). Order matters — see issue #6.
    return truncateResult(`[Result too large (${sizeKB} KB, ${lines.length} lines). Full output saved to ${filepath}. You can use read_file to see the full result.]\n\nPreview (first 200 lines):\n${preview}`);
  }

  // ─── Memory prefetch lifecycle (shared by both backends) ────

  private async consumeMemoryPrefetchIfReady(messages: any[]): Promise<void> {
    const pf = this.memoryPrefetch;
    if (!pf || !pf.settled || pf.consumed) return;
    pf.consumed = true;
    try {
      const memories = await pf.promise;
      if (memories.length === 0) return;
      const injectionText = formatMemoriesForInjection(memories);
      const last = messages[messages.length - 1];
      if (last && last.role === "user") {
        // Append to the existing user message to maintain alternation
        if (typeof last.content === "string" || last.content == null) {
          last.content = (last.content || "") + "\n\n" + injectionText;
        } else if (Array.isArray(last.content)) {
          (last.content as any[]).push({ type: "text", text: injectionText });
        }
      } else {
        messages.push({ role: "user", content: injectionText });
      }
      for (const m of memories) {
        this.alreadySurfacedMemories.add(m.path);
        this.sessionMemoryBytes += Buffer.byteLength(m.content);
      }
    } catch { /* prefetch errors already logged */ }
  }

  // Release external resources (MCP subprocesses and their timers) so the
  // Node process can exit cleanly — see issue #8.
  async close(): Promise<void> {
    if (this.mcpInitialized) {
      await this.mcpManager.disconnectAll();
    }
  }

  private async startMemoryPrefetchForTurn(userMessage: string, messages: any[]): Promise<void> {
    // Drain any carry-over prefetch from the previous turn — a recall that
    // settled after that turn's last API call would otherwise be dropped
    // (issue #7).
    await this.consumeMemoryPrefetchIfReady(messages);
    if (this.isSubAgent) return;
    const sq = this.buildSideQuery();
    if (sq) {
      this.memoryPrefetch = startMemoryPrefetch(
        userMessage, sq,
        this.alreadySurfacedMemories, this.sessionMemoryBytes,
        this.abortController?.signal,
      );
    }
  }

  private async executeToolCall(
    name: string,
    input: Record<string, any>
  ): Promise<string> {
    if (name === "enter_plan_mode" || name === "exit_plan_mode") return await this.executePlanModeTool(name);
    if (name === "agent") return this.executeAgentTool(input);
    if (name === "skill") return this.executeSkillTool(input);
    if (name === "schedule_wakeup") {
      // Only the internal dynamic-loop driver may route here; outside a dynamic
      // loop the tool isn't exposed, and this guard keeps a stray call (or a
      // same-named external tool) from reaching the executor.
      if (!this.scheduleWakeupEnabled) return "schedule_wakeup is only available during /loop dynamic mode.";
      return this.executeScheduleWakeup(input);
    }
    // Route MCP tool calls to the MCP manager
    if (this.mcpManager.isMcpTool(name)) return this.mcpManager.callTool(name, input);
    return executeTool(name, input, this.readFileState);
  }

  // ─── Skill fork mode ─────────────────────────────────────

  private async executeSkillTool(input: Record<string, any>): Promise<string> {
    const { executeSkill } = await import("./skills.js");
    const result = executeSkill(input.skill_name, input.args || "");
    if (!result) return `Unknown skill: ${input.skill_name}`;

    if (result.context === "fork") {
      // Fork mode: run in isolated sub-agent. Never pass schedule_wakeup down —
      // it's a driver-internal tool scoped to this agent's dynamic loop, not
      // something a forked skill should inherit.
      const tools = (result.allowedTools
        ? this.tools.filter(t => result.allowedTools!.includes(t.name))
        : this.tools.filter(t => t.name !== "agent"))
        .filter(t => t.name !== "schedule_wakeup");

      printSubAgentStart("skill-fork", input.skill_name);
      const subAgent = new Agent({
        model: this.model,
        apiBase: this.useOpenAI ? this.openaiClient?.baseURL : undefined,
        customSystemPrompt: result.prompt,
        customTools: tools,
        isSubAgent: true,
        permissionMode: this.childPermissionMode(),
      });

      try {
        const subResult = await subAgent.runOnce(input.args || "Execute this skill task.");
        this.totalInputTokens += subResult.tokens.input;
        this.totalOutputTokens += subResult.tokens.output;
        printSubAgentEnd("skill-fork", input.skill_name);
        return subResult.text || "(Skill produced no output)";
      } catch (e: any) {
        printSubAgentEnd("skill-fork", input.skill_name);
        return `Skill fork error: ${e.message}`;
      }
    }

    // Inline mode: return prompt for injection into conversation
    return `[Skill "${input.skill_name}" activated]\n\n${result.prompt}`;
  }

  // ─── Plan mode helpers ──────────────────────────────────────

  private generatePlanFilePath(): string {
    const dir = join(homedir(), ".claude", "plans");
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    return join(dir, `plan-${this.sessionId}.md`);
  }

  private buildPlanModePrompt(): string {
    return `

# Plan Mode Active

Plan mode is active. You MUST NOT make any edits (except the plan file below), run non-readonly tools, or make any changes to the system.

## Plan File: ${this.planFilePath}
Write your plan incrementally to this file using write_file or edit_file. This is the ONLY file you are allowed to edit.

## Workflow
1. **Explore**: Read code to understand the task. Use read_file, list_files, grep_search.
2. **Design**: Design your implementation approach. Use the agent tool with type="plan" if the task is complex.
3. **Write Plan**: Write a structured plan to the plan file including:
   - **Context**: Why this change is needed
   - **Steps**: Implementation steps with critical file paths
   - **Verification**: How to test the changes
4. **Exit**: Call exit_plan_mode when your plan is ready for user review.

IMPORTANT: When your plan is complete, you MUST call exit_plan_mode. Do NOT ask the user to approve — exit_plan_mode handles that.`;
  }

  private async executePlanModeTool(name: string): Promise<string> {
    if (name === "enter_plan_mode") {
      if (this.permissionMode === "plan") {
        return "Already in plan mode.";
      }
      this.prePlanMode = this.permissionMode;
      this.permissionMode = "plan";
      this.planFilePath = this.generatePlanFilePath();
      this.systemPrompt = this.baseSystemPrompt + this.buildPlanModePrompt();
      if (this.useOpenAI && this.openaiMessages.length > 0) {
        (this.openaiMessages[0] as any).content = this.systemPrompt;
      }
      printInfo("Entered plan mode (read-only). Plan file: " + this.planFilePath);
      return `Entered plan mode. You are now in read-only mode.\n\nYour plan file: ${this.planFilePath}\nWrite your plan to this file. This is the only file you can edit.\n\nWhen your plan is complete, call exit_plan_mode.`;
    }

    if (name === "exit_plan_mode") {
      if (this.permissionMode !== "plan") {
        return "Not in plan mode.";
      }
      // Read plan file content
      let planContent = "(No plan file found)";
      if (this.planFilePath && existsSync(this.planFilePath)) {
        planContent = readFileSync(this.planFilePath, "utf-8");
      }

      // Interactive approval flow
      if (this.planApprovalFn) {
        const result = await this.planApprovalFn(planContent);

        if (result.choice === "keep-planning") {
          // User rejected — stay in plan mode, return feedback to model
          const feedback = result.feedback || "Please revise the plan.";
          return `User rejected the plan and wants to keep planning.\n\nUser feedback: ${feedback}\n\nPlease revise your plan based on this feedback. When done, call exit_plan_mode again.`;
        }

        // User approved — determine the target mode
        let targetMode: PermissionMode;
        if (result.choice === "clear-and-execute") {
          targetMode = "acceptEdits";
        } else if (result.choice === "execute") {
          targetMode = "acceptEdits";
        } else {
          // manual-execute
          targetMode = this.prePlanMode || "default";
        }

        // Exit plan mode
        this.permissionMode = targetMode;
        this.prePlanMode = null;
        const savedPlanPath = this.planFilePath;
        this.planFilePath = null;
        this.systemPrompt = this.baseSystemPrompt;
        if (this.useOpenAI && this.openaiMessages.length > 0) {
          (this.openaiMessages[0] as any).content = this.systemPrompt;
        }

        // Clear context if requested
        if (result.choice === "clear-and-execute") {
          this.clearHistoryKeepSystem();
          this.contextCleared = true; // Signal the agent loop to inject plan as user message
          printInfo(`Plan approved. Context cleared, executing in ${targetMode} mode.`);
          return `User approved the plan. Context was cleared. Permission mode: ${targetMode}\n\nPlan file: ${savedPlanPath}\n\n## Approved Plan:\n${planContent}\n\nProceed with implementation.`;
        }

        printInfo(`Plan approved. Executing in ${targetMode} mode.`);
        return `User approved the plan. Permission mode: ${targetMode}\n\n## Approved Plan:\n${planContent}\n\nProceed with implementation.`;
      }

      // Fallback: no approval function, just exit directly (e.g. sub-agents)
      this.permissionMode = this.prePlanMode || "default";
      this.prePlanMode = null;
      this.planFilePath = null;
      this.systemPrompt = this.baseSystemPrompt;
      if (this.useOpenAI && this.openaiMessages.length > 0) {
        (this.openaiMessages[0] as any).content = this.systemPrompt;
      }
      printInfo("Exited plan mode. Restored to " + this.permissionMode + " mode.");
      return `Exited plan mode. Permission mode restored to: ${this.permissionMode}\n\n## Your Plan:\n${planContent}`;
    }

    return `Unknown plan mode tool: ${name}`;
  }

  /** Clear history but keep system prompt intact (used for clear-context plan approval) */
  private clearHistoryKeepSystem() {
    this.anthropicMessages = [];
    this.openaiMessages = [];
    if (this.useOpenAI) {
      this.openaiMessages.push({ role: "system", content: this.systemPrompt });
    }
    this.lastInputTokenCount = 0;
  }

  private async executeAgentTool(input: Record<string, any>): Promise<string> {
    const type = (input.type || "general") as SubAgentType;
    const description = input.description || "sub-agent task";
    const prompt = input.prompt || "";

    printSubAgentStart(type, description);

    const config = getSubAgentConfig(type);
    const subAgent = new Agent({
      model: this.model,
      apiKey: this.anthropicClient
        ? undefined  // Anthropic SDK reads from env
        : undefined,
      apiBase: this.useOpenAI ? this.openaiClient?.baseURL : undefined,
      customSystemPrompt: config.systemPrompt,
      customTools: config.tools,
      isSubAgent: true,
      permissionMode: this.childPermissionMode(),
    });

    try {
      const result = await subAgent.runOnce(prompt);
      // Add sub-agent token usage to parent
      this.totalInputTokens += result.tokens.input;
      this.totalOutputTokens += result.tokens.output;
      printSubAgentEnd(type, description);
      return result.text || "(Sub-agent produced no output)";
    } catch (e: any) {
      printSubAgentEnd(type, description);
      return `Sub-agent error: ${e.message}`;
    }
  }

  // ─── Anthropic backend ───────────────────────────────────────

  // Push a user message, prepending the CLAUDE.md/date <system-reminder> when
  // it is the first user message of a (possibly just-cleared) context — Claude
  // Code's prependUserContext, kept out of the cached system prompt. Embedded
  // in the user message rather than a standalone message to preserve
  // user/assistant alternation. Also used by the plan clear-and-execute path,
  // which rebuilds history from empty.
  private pushAnthropicUserMessage(content: string): void {
    if (this.anthropicMessages.length === 0 && this.userContextReminder) {
      this.anthropicMessages.push({
        role: "user",
        content: [
          { type: "text", text: this.userContextReminder },
          { type: "text", text: content },
        ],
      });
    } else {
      this.anthropicMessages.push({ role: "user", content });
    }
  }

  private pushOpenAIUserMessage(content: string): void {
    const isFirstUser = !this.openaiMessages.some((m) => m.role === "user");
    if (isFirstUser && this.userContextReminder) {
      this.openaiMessages.push({ role: "user", content: `${this.userContextReminder}\n\n${content}` });
    } else {
      this.openaiMessages.push({ role: "user", content });
    }
  }

  private async chatAnthropic(userMessage: string): Promise<void> {
    this.pushAnthropicUserMessage(userMessage);
    // Auto-compact at turn boundary only — the last message is now plain
    // user text, so the slice in compactAnthropic won't sever a
    // tool_use ↔ tool_result pair from the previous turn's tool execution.
    await this.checkAndCompact();

    // Memory prefetch: drain carry-over, then start fresh (issue #7)
    await this.startMemoryPrefetchForTurn(userMessage, this.anthropicMessages);

    let firstIteration = true;

    while (true) {
      if (this.abortController?.signal.aborted) break;

      // Run compression pipeline before API call (tiers 1-3 are zero-cost)
      this.runCompressionPipeline();

      // Consume memory prefetch if settled (non-blocking poll, zero-wait).
      // Checked every iteration so the model sees recalled memories ASAP.
      await this.consumeMemoryPrefetchIfReady(this.anthropicMessages);

      if (!this.isSubAgent) startSpinner();

      // ── Streaming tool execution ──────────────────────────────
      // As each tool_use content block completes during streaming, check
      // if it's concurrency-safe and auto-allowed. If so, start execution
      // immediately — the tool runs while the model still generates.
      const earlyExecutions = new Map<string, Promise<string>>();

      const response = await this.callAnthropicStream((block) => {
        const input = block.input as Record<string, any>;
        // In Auto Mode, only fast-path (classifier-exempt) tools may start early
        // — otherwise a concurrency-safe-but-classified tool (e.g. web_fetch)
        // would run before the classifier ever sees it.
        if (this.permissionMode === "auto" && !AUTO_MODE_FAST_PATH_TOOLS.has(block.name)) return;
        if (CONCURRENCY_SAFE_TOOLS.has(block.name)) {
          const perm = checkPermission(block.name, input, this.permissionMode, this.planFilePath || undefined);
          if (perm.action === "allow") {
            earlyExecutions.set(block.id, this.executeToolCall(block.name, input));
          }
        }
      });
      if (!this.isSubAgent) stopSpinner();
      this.lastApiCallTime = Date.now();
      // Anthropic reports cached tokens separately: `input_tokens` counts only
      // the uncached (freshly processed) prefix, while cache_read/cache_creation
      // are billed at 0.1x/1.25x. Track them apart for accurate cost.
      const cacheRead = (response.usage as any).cache_read_input_tokens || 0;
      const cacheCreation = (response.usage as any).cache_creation_input_tokens || 0;
      this.totalInputTokens += response.usage.input_tokens;
      this.totalCacheReadTokens += cacheRead;
      this.totalCacheCreationTokens += cacheCreation;
      this.totalOutputTokens += response.usage.output_tokens;
      // Estimate next-turn context size for the compaction gauge: the full
      // prompt we just sent (input + cache_read + cache_creation) plus the
      // output we just generated, which becomes part of the next request.
      this.lastInputTokenCount =
        response.usage.input_tokens + cacheRead + cacheCreation + response.usage.output_tokens;

      const toolUses: Anthropic.ToolUseBlock[] = [];

      for (const block of response.content) {
        if (block.type === "tool_use") {
          toolUses.push(block);
        }
      }

      this.anthropicMessages.push({
        role: "assistant",
        content: response.content,
      });

      if (toolUses.length === 0) {
        if (!this.isSubAgent) {
          printCost(this.totalInputTokens, this.totalOutputTokens, this.totalCacheReadTokens, this.totalCacheCreationTokens);
        }
        break;
      }

      // Budget check after each turn
      this.currentTurns++;
      const budget = this.checkBudget();
      if (budget.exceeded) {
        printInfo(`Budget exceeded: ${budget.reason}`);
        // Every tool_use needs a paired tool_result or the message history
        // is invalid for the next API call. Pair each pending call with a
        // refusal instead of silently dropping it.
        this.anthropicMessages.push({
          role: "user",
          content: toolUses.map((tu) => ({
            type: "tool_result" as const,
            tool_use_id: tu.id,
            content: `Tool call not executed: ${budget.reason}`,
          })),
        });
        break;
      }

      const toolResults: Anthropic.ToolResultBlockParam[] = [];

      // Process tools: early-started ones (from streaming) just await their
      // result; others go through permission check + execution as before.
      let contextBreak = false;
      for (const toolUse of toolUses) {
        if (contextBreak || this.abortController?.signal.aborted) break;
        const input = toolUse.input as Record<string, any>;
        printToolCall(toolUse.name, input);

        // Was this tool already started during streaming?
        const earlyPromise = earlyExecutions.get(toolUse.id);
        if (earlyPromise) {
          const raw = await earlyPromise;
          const res = this.persistLargeResult(toolUse.name, raw);
          printToolResult(toolUse.name, res);
          toolResults.push({ type: "tool_result", tool_use_id: toolUse.id, content: res });
          continue;
        }

        // Permission check for tools not started early. Auto Mode routes
        // through the transcript classifier; other modes use static rules.
        const perm = this.permissionMode === "auto"
          ? await this.classifyToolCall(toolUse.name, input)
          : checkPermission(toolUse.name, input, this.permissionMode, this.planFilePath || undefined);
        if (perm.action === "deny") {
          printInfo(`Denied: ${perm.message}`);
          toolResults.push({ type: "tool_result", tool_use_id: toolUse.id, content: `Action denied: ${perm.message}` });
          continue;
        }
        if (perm.action === "confirm" && perm.message) {
          // Auto Mode confirms carry a reason, not a path — never cache them, or
          // one approval would whitelist every later action with the same reason.
          const cacheable = this.permissionMode !== "auto";
          if (!cacheable || !this.confirmedPaths.has(perm.message)) {
            const confirmed = await this.confirmDangerous(perm.message);
            if (!confirmed) {
              toolResults.push({ type: "tool_result", tool_use_id: toolUse.id, content: "User denied this action." });
              continue;
            }
            if (cacheable) this.confirmedPaths.add(perm.message);
          }
        }

        const raw = await this.executeToolCall(toolUse.name, input);
        const res = this.persistLargeResult(toolUse.name, raw);
        printToolResult(toolUse.name, res);

        if (this.contextCleared) {
          this.contextCleared = false;
          // History was just cleared — route through the helper so the rebuilt
          // context's first user message carries the CLAUDE.md/date reminder.
          this.pushAnthropicUserMessage(res);
          contextBreak = true;
          break;
        }
        toolResults.push({ type: "tool_result", tool_use_id: toolUse.id, content: res });
      }

      if (!contextBreak && !this.contextCleared && toolResults.length > 0) {
        this.anthropicMessages.push({ role: "user", content: toolResults });
      }
      this.contextCleared = false;

      firstIteration = false;
    }
  }

  /**
   * Stream an Anthropic API call. When a tool_use content block finishes
   * during streaming, `onToolBlockComplete` fires immediately so the caller
   * can start execution before the full response arrives (streaming tool
   * execution — inspired by Claude Code's content_block_stop streaming pattern).
   */
  private async callAnthropicStream(
    onToolBlockComplete?: (block: Anthropic.ToolUseBlock) => void,
  ): Promise<Anthropic.Message> {
    return withRetry(async (signal) => {
      const maxOutput = getMaxOutputTokens(this.model);
      const createParams: any = {
        model: this.model,
        max_tokens: this.thinkingMode !== "disabled" ? maxOutput : 16384,
        system: this.buildAnthropicSystem(),
        tools: getActiveToolDefinitions(this.tools),
        // Rolling message-array cache breakpoint, applied to a copy so the
        // persistent history stays free of cache_control metadata.
        messages: this.withCacheBreakpoints(this.anthropicMessages),
      };

      if (this.thinkingMode === "adaptive") {
        createParams.thinking = { type: "enabled", budget_tokens: maxOutput - 1 };
      } else if (this.thinkingMode === "enabled") {
        createParams.thinking = { type: "enabled", budget_tokens: maxOutput - 1 };
      }

      const stream = this.anthropicClient!.messages.stream(createParams, { signal });

      // Stream text content (SDK high-level event)
      let firstText = true;
      stream.on("text", (text: string) => {
        if (firstText) { stopSpinner(); this.emitText("\n"); firstText = false; }
        this.emitText(text);
      });

      // ── Unified streamEvent handler for thinking + tool tracking ──
      // Track in-flight tool_use blocks by index. When content_block_stop
      // fires for a tool_use, parse accumulated JSON and notify caller
      // so it can start execution while later blocks still stream.
      const toolBlocksByIndex = new Map<number, { id: string; name: string; inputJson: string }>();
      let inThinking = false;

      stream.on("streamEvent" as any, (event: any) => {
        // Thinking passthrough
        if (event.type === "content_block_start" && event.content_block?.type === "thinking") {
          if (this.thinkingMode !== "disabled") {
            inThinking = true;
            stopSpinner();
            this.emitText("\n" + chalk.dim("  [thinking] "));
          }
        } else if (event.type === "content_block_delta" && event.delta?.type === "thinking_delta" && inThinking) {
          this.emitText(chalk.dim(event.delta.thinking));
        }

        // Tool block tracking: accumulate input JSON as it streams
        if (event.type === "content_block_start" && event.content_block?.type === "tool_use") {
          toolBlocksByIndex.set(event.index, {
            id: event.content_block.id,
            name: event.content_block.name,
            inputJson: "",
          });
        } else if (event.type === "content_block_delta" && event.delta?.type === "input_json_delta") {
          const tb = toolBlocksByIndex.get(event.index);
          if (tb) tb.inputJson += event.delta.partial_json;
        }

        // content_block_stop: finalize thinking or fire tool callback
        if (event.type === "content_block_stop") {
          if (inThinking) { this.emitText("\n"); inThinking = false; }
          const tb = toolBlocksByIndex.get(event.index);
          if (tb && onToolBlockComplete) {
            let parsedInput: Record<string, any> = {};
            try { parsedInput = JSON.parse(tb.inputJson || "{}"); } catch {}
            onToolBlockComplete({ type: "tool_use", id: tb.id, name: tb.name, input: parsedInput });
            toolBlocksByIndex.delete(event.index);
          }
        }
      });

      const finalMessage = await stream.finalMessage();

      // Filter out thinking blocks from stored history
      finalMessage.content = finalMessage.content.filter(
        (block: any) => block.type !== "thinking"
      );

      return finalMessage;
    }, this.abortController?.signal);
  }

  // ─── OpenAI-compatible backend ───────────────────────────────

  private async chatOpenAI(userMessage: string): Promise<void> {
    this.pushOpenAIUserMessage(userMessage);
    // Auto-compact at turn boundary only — see chatAnthropic for rationale.
    // The last message is now plain user text, so the slice in compactOpenAI
    // won't orphan a tool_calls / tool message pair.
    await this.checkAndCompact();

    // Memory prefetch: drain carry-over, then start fresh (issue #7)
    await this.startMemoryPrefetchForTurn(userMessage, this.openaiMessages);

    while (true) {
      if (this.abortController?.signal.aborted) break;

      // Run compression pipeline before API call
      this.runCompressionPipeline();

      // Consume memory prefetch if settled (non-blocking poll, zero-wait)
      await this.consumeMemoryPrefetchIfReady(this.openaiMessages);

      if (!this.isSubAgent) startSpinner();
      const response = await this.callOpenAIStream();
      if (!this.isSubAgent) stopSpinner();
      this.lastApiCallTime = Date.now();

      // Track tokens. OpenAI-compatible providers cache prefixes automatically
      // (no cache_control needed); the cached portion is included in
      // prompt_tokens, so split it out to avoid double-counting. Clamp to
      // [0, prompt_tokens] since compatible gateways don't guarantee the field.
      // NOTE: we price it at Anthropic's 0.1x for simplicity; actual cached
      // rates vary by provider (OpenAI ~0.5x, gateways vary), so the
      // OpenAI-path estimate may be off in either direction.
      if (response.usage) {
        const prompt = response.usage.prompt_tokens || 0;
        const rawCached = response.usage.prompt_tokens_details?.cached_tokens || 0;
        const cachedOA = Math.min(Math.max(rawCached, 0), prompt);
        this.totalInputTokens += prompt - cachedOA;
        this.totalCacheReadTokens += cachedOA;
        this.totalOutputTokens += response.usage.completion_tokens;
        // Estimate next-turn context size: this prompt + the output we just
        // generated (which becomes part of the next request).
        this.lastInputTokenCount = prompt + response.usage.completion_tokens;
      }

      const choice = response.choices?.[0];
      if (!choice) break;
      const message = choice.message;

      // Add assistant message to history
      this.openaiMessages.push(message);

      // If no tool calls, we're done
      const toolCalls = message.tool_calls;
      if (!toolCalls || toolCalls.length === 0) {
        if (!this.isSubAgent) {
          printCost(this.totalInputTokens, this.totalOutputTokens, this.totalCacheReadTokens, this.totalCacheCreationTokens);
        }
        break;
      }

      // Budget check after each turn
      this.currentTurns++;
      const budget = this.checkBudget();
      if (budget.exceeded) {
        printInfo(`Budget exceeded: ${budget.reason}`);
        // Same pairing requirement as the Anthropic path: every tool_call
        // needs a role:"tool" response.
        for (const tc of toolCalls) {
          this.openaiMessages.push({
            role: "tool",
            tool_call_id: tc.id,
            content: `Tool call not executed: ${budget.reason}`,
          });
        }
        break;
      }

      // Phase 1: Parse & permission-check all tool calls (serial — user interaction)
      type OAIChecked = { tc: typeof toolCalls[0]; fnName: string; input: Record<string, any>; allowed: boolean; result?: string };
      const oaiChecked: OAIChecked[] = [];
      for (const tc of toolCalls) {
        if (this.abortController?.signal.aborted) break;
        if (tc.type !== "function") continue;
        const fnName = tc.function.name;
        let input: Record<string, any>;
        try { input = JSON.parse(tc.function.arguments); } catch { input = {}; }

        printToolCall(fnName, input);

        const perm = this.permissionMode === "auto"
          ? await this.classifyToolCall(fnName, input)
          : checkPermission(fnName, input, this.permissionMode, this.planFilePath || undefined);
        if (perm.action === "deny") {
          printInfo(`Denied: ${perm.message}`);
          oaiChecked.push({ tc, fnName, input, allowed: false, result: `Action denied: ${perm.message}` });
          continue;
        }
        if (perm.action === "confirm" && perm.message) {
          // Auto Mode confirms carry a reason, not a path — never cache them, or
          // one approval would whitelist every later action with the same reason.
          const cacheable = this.permissionMode !== "auto";
          if (!cacheable || !this.confirmedPaths.has(perm.message)) {
            const confirmed = await this.confirmDangerous(perm.message);
            if (!confirmed) {
              oaiChecked.push({ tc, fnName, input, allowed: false, result: "User denied this action." });
              continue;
            }
            if (cacheable) this.confirmedPaths.add(perm.message);
          }
        }
        oaiChecked.push({ tc, fnName, input, allowed: true });
      }

      // Phase 2: Group & execute (parallel for consecutive safe tools)
      type OAIBatch = { concurrent: boolean; items: OAIChecked[] };
      const oaiBatches: OAIBatch[] = [];
      for (const ct of oaiChecked) {
        const safe = ct.allowed && CONCURRENCY_SAFE_TOOLS.has(ct.fnName);
        if (safe && oaiBatches.length > 0 && oaiBatches[oaiBatches.length - 1].concurrent) {
          oaiBatches[oaiBatches.length - 1].items.push(ct);
        } else {
          oaiBatches.push({ concurrent: safe, items: [ct] });
        }
      }

      let oaiContextBreak = false;
      for (const batch of oaiBatches) {
        if (oaiContextBreak || this.abortController?.signal.aborted) break;

        if (batch.concurrent) {
          const results = await Promise.all(
            batch.items.map(async (ct) => {
              const raw = await this.executeToolCall(ct.fnName, ct.input);
              const res = this.persistLargeResult(ct.fnName, raw);
              printToolResult(ct.fnName, res);
              return { ct, res };
            })
          );
          for (const { ct, res } of results) {
            this.openaiMessages.push({ role: "tool", tool_call_id: ct.tc.id, content: res });
          }
        } else {
          for (const ct of batch.items) {
            if (!ct.allowed) {
              this.openaiMessages.push({ role: "tool", tool_call_id: ct.tc.id, content: ct.result! });
              continue;
            }
            const raw = await this.executeToolCall(ct.fnName, ct.input);
            const res = this.persistLargeResult(ct.fnName, raw);
            printToolResult(ct.fnName, res);

            if (this.contextCleared) {
              this.contextCleared = false;
              // History was just cleared — route through the helper so the
              // rebuilt context's first user message carries the reminder.
              this.pushOpenAIUserMessage(res);
              oaiContextBreak = true;
              break;
            }
            this.openaiMessages.push({ role: "tool", tool_call_id: ct.tc.id, content: res });
          }
        }
      }

      this.contextCleared = false;
    }
  }

  private async callOpenAIStream(): Promise<OpenAI.ChatCompletion> {
    return withRetry(async (signal) => {
      const stream = await this.openaiClient!.chat.completions.create({
        model: this.model,
        max_tokens: 16384,
        tools: toOpenAITools(getActiveToolDefinitions(this.tools)),
        messages: this.openaiMessages,
        stream: true,
        stream_options: { include_usage: true },
      }, { signal });

      // Accumulate the streamed response
      let content = "";
      let firstText = true;
      const toolCalls: Map<number, { id: string; name: string; arguments: string }> = new Map();
      let finishReason = "";
      let usage: OpenAI.CompletionUsage | undefined;

      for await (const chunk of stream) {
        const delta = chunk.choices[0]?.delta;

        // Usage comes in the final chunk (no delta). Keep prompt_tokens_details
        // (its cached_tokens is the auto-cached portion) so cost accounting can
        // split it out — mirrors the Python path.
        if (chunk.usage) {
          usage = chunk.usage;
        }

        if (!delta) continue;

        // Stream text content
        if (delta.content) {
          if (firstText) { stopSpinner(); this.emitText("\n"); firstText = false; }
          this.emitText(delta.content);
          content += delta.content;
        }

        // Accumulate tool calls (arguments arrive in chunks)
        if (delta.tool_calls) {
          for (const tc of delta.tool_calls) {
            const existing = toolCalls.get(tc.index);
            if (existing) {
              if (tc.function?.arguments) existing.arguments += tc.function.arguments;
            } else {
              toolCalls.set(tc.index, {
                id: tc.id || "",
                name: tc.function?.name || "",
                arguments: tc.function?.arguments || "",
              });
            }
          }
        }

        if (chunk.choices[0]?.finish_reason) {
          finishReason = chunk.choices[0].finish_reason;
        }
      }

      // Reconstruct ChatCompletion from streamed chunks
      const assembledToolCalls = toolCalls.size > 0
        ? Array.from(toolCalls.entries())
            .sort(([a], [b]) => a - b)
            .map(([idx, tc]) => ({
              id: tc.id,
              type: "function" as const,
              function: { name: tc.name, arguments: tc.arguments },
            }))
        : undefined;

      return {
        id: "stream",
        object: "chat.completion",
        created: Date.now(),
        model: this.model,
        choices: [
          {
            index: 0,
            message: {
              role: "assistant" as const,
              content: content || null,
              tool_calls: assembledToolCalls,
              refusal: null,
            },
            finish_reason: finishReason || "stop",
            logprobs: null,
          },
        ],
        usage: usage || { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
      } as OpenAI.ChatCompletion;
    }, this.abortController?.signal);
  }

  // ─── Shared ──────────────────────────────────────────────────

  private async confirmDangerous(command: string): Promise<boolean> {
    printConfirmation(command);
    // Use external confirmFn if provided (REPL mode passes one that reuses
    // the existing readline, avoiding the classic Node.js bug where a second
    // readline.createInterface on the same stdin kills the first one on close).
    if (this.confirmFn) {
      return this.confirmFn(command);
    }
    // Fallback for one-shot / non-REPL usage: create a temporary readline
    const rl = readline.createInterface({
      input: process.stdin,
      output: process.stdout,
    });
    return new Promise((resolve) => {
      rl.question("  Allow? (y/n): ", (answer) => {
        rl.close();
        resolve(answer.toLowerCase().startsWith("y"));
      });
    });
  }
}
