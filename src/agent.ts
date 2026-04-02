import Anthropic from "@anthropic-ai/sdk";
import OpenAI from "openai";
import chalk from "chalk";
import { toolDefinitions, executeTool, checkPermission, type ToolDef, type PermissionMode } from "./tools.js";
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
import { buildSystemPrompt } from "./prompt.js";
import { getSubAgentConfig, type SubAgentType } from "./subagent.js";
import * as readline from "readline";
import { randomUUID } from "crypto";

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
// Mirrors Claude Code: adaptive for 4.6, enabled for older Claude 4, disabled for the rest.

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

// Max output tokens by model (mirrors Claude Code's context.ts)
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
// Mirrors Claude Code's 4-layer compression: budget → snip → microcompact → auto-compact

const SNIPPABLE_TOOLS = new Set(["read_file", "grep_search", "list_files", "run_shell"]);
const SNIP_PLACEHOLDER = "[Content snipped - re-read if needed]";
const SNIP_THRESHOLD = 0.60;
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
  private lastInputTokenCount = 0;
  private effectiveWindow: number;
  private sessionId: string;
  private sessionStartTime: string;
  private isSubAgent: boolean;

  // Budget control
  private maxCostUsd?: number;
  private maxTurns?: number;
  private currentTurns = 0;

  // Multi-tier compression state
  private lastApiCallTime = 0;

  // Abort support
  private abortController: AbortController | null = null;

  // Permission whitelist: paths confirmed in this session
  private confirmedPaths: Set<string> = new Set();

  // External confirmation callback (avoids creating a second readline on stdin)
  private confirmFn?: (message: string) => Promise<boolean>;

  // Sub-agent output buffer (captures text instead of printing)
  private outputBuffer: string[] | null = null;

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

    // Build system prompt (with plan mode injection if needed)
    let sysPrompt = options.customSystemPrompt || buildSystemPrompt();
    if (this.permissionMode === "plan") {
      sysPrompt += "\n\n# Plan Mode Active\nYou are in PLAN mode. Describe what changes you would make, but do NOT execute any write operations (write_file, edit_file, or destructive shell commands). Only use read-only tools to analyze the codebase.";
    }
    this.systemPrompt = sysPrompt;

    if (this.useOpenAI) {
      this.openaiClient = new OpenAI({
        baseURL: options.apiBase,
        apiKey: options.apiKey,
      });
      this.openaiMessages.push({ role: "system", content: this.systemPrompt });
    } else {
      this.anthropicClient = new Anthropic({
        apiKey: options.apiKey,
        ...(options.anthropicBaseURL ? { baseURL: options.anthropicBaseURL } : {}),
      });
    }
  }

  private resolveThinkingMode(): "adaptive" | "enabled" | "disabled" {
    if (!this.thinking) return "disabled";
    if (!modelSupportsThinking(this.model)) return "disabled";
    if (modelSupportsAdaptiveThinking(this.model)) return "adaptive";
    return "enabled";
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

  getTokenUsage() {
    return { input: this.totalInputTokens, output: this.totalOutputTokens };
  }

  async chat(userMessage: string): Promise<void> {
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
    this.lastInputTokenCount = 0;
    printInfo("Conversation cleared.");
  }

  showCost() {
    const total = this.getCurrentCostUsd();
    const budgetInfo = this.maxCostUsd ? ` / $${this.maxCostUsd} budget` : "";
    const turnInfo = this.maxTurns ? ` | Turns: ${this.currentTurns}/${this.maxTurns}` : "";
    printInfo(
      `Tokens: ${this.totalInputTokens} in / ${this.totalOutputTokens} out\n  Estimated cost: $${total.toFixed(4)}${budgetInfo}${turnInfo}`
    );
  }

  // ─── Budget control ────────────────────────────────────────

  private getCurrentCostUsd(): number {
    const costIn = (this.totalInputTokens / 1_000_000) * 3;
    const costOut = (this.totalOutputTokens / 1_000_000) * 15;
    return costIn + costOut;
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
  // Mirrors Claude Code's 4-layer: budget → snip → microcompact → auto-compact
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
    const utilization = this.lastInputTokenCount / this.effectiveWindow;
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
    const utilization = this.lastInputTokenCount / this.effectiveWindow;
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

  private async executeToolCall(
    name: string,
    input: Record<string, any>
  ): Promise<string> {
    if (name === "agent") return this.executeAgentTool(input);
    if (name === "skill") return this.executeSkillTool(input);
    return executeTool(name, input);
  }

  // ─── Skill fork mode ─────────────────────────────────────

  private async executeSkillTool(input: Record<string, any>): Promise<string> {
    const { executeSkill } = await import("./skills.js");
    const result = executeSkill(input.skill_name, input.args || "");
    if (!result) return `Unknown skill: ${input.skill_name}`;

    if (result.context === "fork") {
      // Fork mode: run in isolated sub-agent
      const tools = result.allowedTools
        ? this.tools.filter(t => result.allowedTools!.includes(t.name))
        : this.tools.filter(t => t.name !== "agent");

      printSubAgentStart("skill-fork", input.skill_name);
      const subAgent = new Agent({
        model: this.model,
        apiBase: this.useOpenAI ? this.openaiClient?.baseURL : undefined,
        customSystemPrompt: result.prompt,
        customTools: tools,
        isSubAgent: true,
        permissionMode: "bypassPermissions",
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
      permissionMode: "bypassPermissions", // Sub-agents don't need confirmation
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

  private async chatAnthropic(userMessage: string): Promise<void> {
    this.anthropicMessages.push({ role: "user", content: userMessage });

    while (true) {
      if (this.abortController?.signal.aborted) break;

      // Run compression pipeline before API call (tiers 1-3 are zero-cost)
      this.runCompressionPipeline();

      if (!this.isSubAgent) startSpinner();
      const response = await this.callAnthropicStream();
      if (!this.isSubAgent) stopSpinner();
      this.lastApiCallTime = Date.now();
      this.totalInputTokens += response.usage.input_tokens;
      this.totalOutputTokens += response.usage.output_tokens;
      this.lastInputTokenCount = response.usage.input_tokens;

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
          printCost(this.totalInputTokens, this.totalOutputTokens);
        }
        break;
      }

      // Budget check after each turn
      this.currentTurns++;
      const budget = this.checkBudget();
      if (budget.exceeded) {
        printInfo(`Budget exceeded: ${budget.reason}`);
        break;
      }

      const toolResults: Anthropic.ToolResultBlockParam[] = [];

      for (const toolUse of toolUses) {
        if (this.abortController?.signal.aborted) break;
        const input = toolUse.input as Record<string, any>;
        printToolCall(toolUse.name, input);

        // Permission check (mode-aware)
        const perm = checkPermission(toolUse.name, input, this.permissionMode);
        if (perm.action === "deny") {
          printInfo(`Denied: ${perm.message}`);
          toolResults.push({
            type: "tool_result",
            tool_use_id: toolUse.id,
            content: `Action denied: ${perm.message}`,
          });
          continue;
        }
        if (perm.action === "confirm" && perm.message && !this.confirmedPaths.has(perm.message)) {
          const confirmed = await this.confirmDangerous(perm.message);
          if (!confirmed) {
            toolResults.push({
              type: "tool_result",
              tool_use_id: toolUse.id,
              content: "User denied this action.",
            });
            continue;
          }
          this.confirmedPaths.add(perm.message);
        }

        const result = await this.executeToolCall(toolUse.name, input);
        printToolResult(toolUse.name, result);
        toolResults.push({
          type: "tool_result",
          tool_use_id: toolUse.id,
          content: result,
        });
      }

      this.anthropicMessages.push({ role: "user", content: toolResults });
      await this.checkAndCompact();
    }
  }

  private async callAnthropicStream(): Promise<Anthropic.Message> {
    return withRetry(async (signal) => {
      const maxOutput = getMaxOutputTokens(this.model);
      const createParams: any = {
        model: this.model,
        max_tokens: this.thinkingMode !== "disabled" ? maxOutput : 16384,
        system: this.systemPrompt,
        tools: this.tools,
        messages: this.anthropicMessages,
      };

      // Extended thinking support (Anthropic only)
      // Mirrors Claude Code: adaptive for 4.6 models, enabled with budget for older
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

      // Stream thinking content if enabled (SDK high-level event)
      if (this.thinkingMode !== "disabled") {
        let inThinking = false;
        stream.on("streamEvent" as any, (event: any) => {
          if (event.type === "content_block_start" && event.content_block?.type === "thinking") {
            inThinking = true;
            stopSpinner();
            this.emitText("\n" + chalk.dim("  [thinking] "));
          } else if (event.type === "content_block_delta" && event.delta?.type === "thinking_delta" && inThinking) {
            this.emitText(chalk.dim(event.delta.thinking));
          } else if (event.type === "content_block_stop" && inThinking) {
            this.emitText("\n");
            inThinking = false;
          }
        });
      }

      const finalMessage = await stream.finalMessage();

      // Filter out thinking blocks from stored history
      // (Claude Code preserves redacted blocks, but for simplicity we strip them)
      finalMessage.content = finalMessage.content.filter(
        (block: any) => block.type !== "thinking"
      );

      return finalMessage;
    }, this.abortController?.signal);
  }

  // ─── OpenAI-compatible backend ───────────────────────────────

  private async chatOpenAI(userMessage: string): Promise<void> {
    this.openaiMessages.push({ role: "user", content: userMessage });

    while (true) {
      if (this.abortController?.signal.aborted) break;

      // Run compression pipeline before API call
      this.runCompressionPipeline();

      if (!this.isSubAgent) startSpinner();
      const response = await this.callOpenAIStream();
      if (!this.isSubAgent) stopSpinner();
      this.lastApiCallTime = Date.now();

      // Track tokens
      if (response.usage) {
        this.totalInputTokens += response.usage.prompt_tokens;
        this.totalOutputTokens += response.usage.completion_tokens;
        this.lastInputTokenCount = response.usage.prompt_tokens;
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
          printCost(this.totalInputTokens, this.totalOutputTokens);
        }
        break;
      }

      // Budget check after each turn
      this.currentTurns++;
      const budget = this.checkBudget();
      if (budget.exceeded) {
        printInfo(`Budget exceeded: ${budget.reason}`);
        break;
      }

      // Execute tool calls
      for (const tc of toolCalls) {
        if (this.abortController?.signal.aborted) break;
        if (tc.type !== "function") continue;
        const fnName = tc.function.name;
        let input: Record<string, any>;
        try {
          input = JSON.parse(tc.function.arguments);
        } catch {
          input = {};
        }

        printToolCall(fnName, input);

        // Permission check (mode-aware)
        const perm = checkPermission(fnName, input, this.permissionMode);
        if (perm.action === "deny") {
          printInfo(`Denied: ${perm.message}`);
          this.openaiMessages.push({
            role: "tool",
            tool_call_id: tc.id,
            content: `Action denied: ${perm.message}`,
          });
          continue;
        }
        if (perm.action === "confirm" && perm.message && !this.confirmedPaths.has(perm.message)) {
          const confirmed = await this.confirmDangerous(perm.message);
          if (!confirmed) {
            this.openaiMessages.push({
              role: "tool",
              tool_call_id: tc.id,
              content: "User denied this action.",
            });
            continue;
          }
          this.confirmedPaths.add(perm.message);
        }

        const result = await this.executeToolCall(fnName, input);
        printToolResult(fnName, result);

        this.openaiMessages.push({
          role: "tool",
          tool_call_id: tc.id,
          content: result,
        });
      }

      await this.checkAndCompact();
    }
  }

  private async callOpenAIStream(): Promise<OpenAI.ChatCompletion> {
    return withRetry(async (signal) => {
      const stream = await this.openaiClient!.chat.completions.create({
        model: this.model,
        max_tokens: 16384,
        tools: toOpenAITools(this.tools),
        messages: this.openaiMessages,
        stream: true,
        stream_options: { include_usage: true },
      }, { signal });

      // Accumulate the streamed response
      let content = "";
      let firstText = true;
      const toolCalls: Map<number, { id: string; name: string; arguments: string }> = new Map();
      let finishReason = "";
      let usage: { prompt_tokens: number; completion_tokens: number } | undefined;

      for await (const chunk of stream) {
        const delta = chunk.choices[0]?.delta;

        // Usage comes in the final chunk (no delta)
        if (chunk.usage) {
          usage = {
            prompt_tokens: chunk.usage.prompt_tokens,
            completion_tokens: chunk.usage.completion_tokens,
          };
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
