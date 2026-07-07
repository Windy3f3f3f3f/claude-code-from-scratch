"""Agent core loop — dual backend (Anthropic + OpenAI compatible), streaming,
4-layer compression, plan mode, sub-agents, budget control.
Agent architecture inspired by Claude Code's published design."""

from __future__ import annotations

import asyncio
import json
import os
import time
import uuid
from pathlib import Path
from typing import Any, Callable, Awaitable

import anthropic
import openai

from .tools import (
    tool_definitions,
    execute_tool,
    check_permission,
    CONCURRENCY_SAFE_TOOLS,
    get_active_tool_definitions,
    ToolDef,
    PermissionMode,
    _truncate_result,
)
from .memory import (
    start_memory_prefetch,
    format_memories_for_injection,
    MemoryPrefetch,
)
from .autonomy import (
    goal_directive,
    GOAL_EVALUATOR_SYSTEM,
    GOAL_TRANSCRIPT_FRAMING,
    goal_judge_user_message,
    parse_goal_verdict,
    GOAL_MAX_ITERATIONS,
    parse_loop_input,
    is_daily_wording,
    OFFER_CLOUD_THRESHOLD_SECONDS,
    SCHEDULE_WAKEUP_TOOL,
    clamp_wakeup_delay,
    dynamic_loop_directive,
    LOOP_MAX_ITERATIONS,
    load_auto_mode_rules,
    build_classifier_system,
    AUTO_MODE_FAST_PATH_TOOLS,
    DENIAL_LIMITS,
    build_classifier_transcript,
    parse_block_verdict,
    classifier_user_message,
)
from .ui import (
    print_assistant_text,
    print_tool_call,
    print_tool_result,
    print_error,
    print_confirmation,
    print_divider,
    print_cost,
    print_retry,
    print_info,
    print_sub_agent_start,
    print_sub_agent_end,
    start_spinner,
    stop_spinner,
)
from .session import save_session
from .prompt import build_system_prompt, build_static_system_prompt, build_dynamic_system_context, build_user_context_reminder, load_claude_md
from .subagent import get_sub_agent_config
from .mcp_client import McpManager

# ─── Retry with exponential backoff ──────────────────────────


def _is_retryable(error: Exception) -> bool:
    status = getattr(error, "status_code", None) or getattr(error, "status", None)
    if status in (429, 503, 529):
        return True
    msg = str(error)
    if "overloaded" in msg or "ECONNRESET" in msg or "ETIMEDOUT" in msg:
        return True
    return False


async def _with_retry(fn, max_retries: int = 3):
    for attempt in range(max_retries + 1):
        try:
            return await fn()
        except Exception as error:
            if attempt >= max_retries or not _is_retryable(error):
                raise
            delay = min(1000 * (2 ** attempt), 30000) / 1000 + (hash(str(time.time())) % 1000) / 1000
            status = getattr(error, "status_code", None) or getattr(error, "status", None)
            reason = f"HTTP {status}" if status else (getattr(error, "code", None) or "network error")
            print_retry(attempt + 1, max_retries, reason)
            await asyncio.sleep(delay)


# ─── Model context windows ──────────────────────────────────

MODEL_CONTEXT = {
    "claude-opus-4-6": 200000,
    "claude-sonnet-4-6": 200000,
    "claude-sonnet-4-20250514": 200000,
    "claude-haiku-4-5-20251001": 200000,
    "claude-opus-4-20250514": 200000,
    "gpt-4o": 128000,
    "gpt-4o-mini": 128000,
}


def _get_context_window(model: str) -> int:
    return MODEL_CONTEXT.get(model, 200000)


# ─── Thinking support detection ─────────────────────────────


def _model_supports_thinking(model: str) -> bool:
    m = model.lower()
    if "claude-3-" in m or "3-5-" in m or "3-7-" in m:
        return False
    if "claude" in m and any(x in m for x in ("opus", "sonnet", "haiku")):
        return True
    return False


def _model_supports_adaptive_thinking(model: str) -> bool:
    m = model.lower()
    return "opus-4-6" in m or "sonnet-4-6" in m


def _get_max_output_tokens(model: str) -> int:
    m = model.lower()
    if "opus-4-6" in m:
        return 64000
    if "sonnet-4-6" in m:
        return 32000
    if any(x in m for x in ("opus-4", "sonnet-4", "haiku-4")):
        return 32000
    return 16384


# ─── Convert tools to OpenAI format ─────────────────────────


def _to_openai_tools(tools: list[ToolDef]) -> list[dict]:
    return [
        {
            "type": "function",
            "function": {
                "name": t["name"],
                "description": t["description"],
                "parameters": t["input_schema"],
            },
        }
        for t in tools
    ]


# ─── Multi-tier compression constants ────────────────────────

SNIPPABLE_TOOLS = {"read_file", "grep_search", "list_files", "run_shell"}
SNIP_PLACEHOLDER = "[Content snipped - re-read if needed]"
SNIP_THRESHOLD = 0.60
# Above this utilization we snip even while the cache is hot: preserving the
# cache is not worth risking a context overflow. Below it, a hot cache is left
# untouched (see snip functions). Sits between SNIP_THRESHOLD and autocompact.
SNIP_HOT_OVERRIDE = 0.75
MICROCOMPACT_IDLE_S = 5 * 60  # 5 minutes
KEEP_RECENT_RESULTS = 3


# ─── Agent ───────────────────────────────────────────────────


class Agent:
    def __init__(
        self,
        *,
        permission_mode: str = "default",
        model: str = "claude-opus-4-6",
        api_base: str | None = None,
        anthropic_base_url: str | None = None,
        api_key: str | None = None,
        thinking: bool = False,
        max_cost_usd: float | None = None,
        max_turns: int | None = None,
        confirm_fn: Callable[[str], Awaitable[bool]] | None = None,
        custom_system_prompt: str | None = None,
        custom_tools: list[ToolDef] | None = None,
        is_sub_agent: bool = False,
    ):
        self.permission_mode = permission_mode
        self.thinking = thinking
        self.model = model
        self.use_openai = bool(api_base)
        self.is_sub_agent = is_sub_agent
        self.tools = custom_tools or tool_definitions
        self.max_cost_usd = max_cost_usd
        self.max_turns = max_turns
        self.confirm_fn = confirm_fn
        self.effective_window = _get_context_window(model) - 20000
        self.session_id = uuid.uuid4().hex[:8]
        self.session_start_time = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())

        self.total_input_tokens = 0
        self.total_output_tokens = 0
        self.total_cache_read_tokens = 0       # Prompt-cache hits (billed ~0.1x)
        self.total_cache_creation_tokens = 0   # Prompt-cache writes (billed ~1.25x)
        self.last_input_token_count = 0
        self.current_turns = 0
        self.last_api_call_time = 0.0

        # /goal — session-scoped Stop-hook condition, pursued across turns
        self.active_goal: dict | None = None
        self.goal_stop = False  # set on interrupt to break out of goal pursuit

        # /loop dynamic mode — set when the model calls schedule_wakeup during a
        # tick, read (and cleared) by the loop driver after the turn converges.
        self.pending_wakeup: dict | None = None
        self.loop_stop = False  # set on interrupt to break out of a running loop
        # schedule_wakeup is routed to the internal executor only while a dynamic
        # loop is active, so it can't shadow a same-named tool or be reached out
        # of band.
        self.schedule_wakeup_enabled = False

        # Auto Mode — transcript-classifier denial tracking (DENIAL_LIMITS).
        self.auto_consecutive_denials = 0
        self.auto_total_denials = 0

        # Abort support
        self._aborted = False
        self._current_task: asyncio.Task | None = None

        # Permission whitelist
        self._confirmed_paths: set[str] = set()

        # Plan mode state
        self._pre_plan_mode: str | None = None
        self._plan_file_path: str | None = None
        self._plan_approval_fn: Callable[[str], Awaitable[dict]] | None = None
        self._context_cleared: bool = False  # Set when plan approval clears context

        # Thinking mode
        self._thinking_mode = self._resolve_thinking_mode()

        # Output buffer (sub-agents capture output)
        self._output_buffer: list[str] | None = None

        # Read-before-edit: track file read timestamps (absolutePath → mtime)
        self._read_file_state: dict[str, float] = {}

        # MCP integration
        self._mcp_manager = McpManager()
        self._mcp_initialized = False

        # Memory recall state — semantic prefetch per user turn. The handle
        # lives on the instance so a recall that settles after this turn's
        # last API call is carried over and injected next turn (issue #7).
        self._already_surfaced_memories: set[str] = set()
        self._session_memory_bytes = 0
        self._memory_prefetch: MemoryPrefetch | None = None

        # Separate message histories
        self._anthropic_messages: list[dict] = []
        self._openai_messages: list[dict] = []

        # Build system prompt with a static/dynamic split for prefix caching.
        # A custom system prompt overrides both halves (all of it is treated as
        # static). Otherwise the static core is cacheable, env/git/skills form
        # the dynamic tail, and CLAUDE.md + date go into the FIRST user message
        # as a <system-reminder> (Claude Code's prependUserContext) — see chat.
        # Keeping project-specific content out of the system maximizes sharing.
        self._user_context_reminder = ""
        if custom_system_prompt:
            self._static_system_prompt = custom_system_prompt
            self._dynamic_system_context = ""
        else:
            self._static_system_prompt = build_static_system_prompt()
            self._dynamic_system_context = build_dynamic_system_context()
            self._user_context_reminder = build_user_context_reminder()
        self._base_system_prompt = (
            self._static_system_prompt + "\n\n" + self._dynamic_system_context
            if self._dynamic_system_context else self._static_system_prompt
        )
        if self.permission_mode == "plan":
            self._plan_file_path = self._generate_plan_file_path()
            self._system_prompt = self._base_system_prompt + self._build_plan_mode_prompt()
        else:
            self._system_prompt = self._base_system_prompt

        # Initialize clients
        if self.use_openai:
            self._openai_client = openai.AsyncOpenAI(base_url=api_base, api_key=api_key)
            self._anthropic_client = None
            self._openai_messages.append({"role": "system", "content": self._system_prompt})
        else:
            kwargs: dict[str, Any] = {}
            if api_key:
                kwargs["api_key"] = api_key
            if anthropic_base_url:
                kwargs["base_url"] = anthropic_base_url
            self._anthropic_client = anthropic.AsyncAnthropic(**kwargs)
            self._openai_client = None

    # ─── Prefix caching (Anthropic) ─────────────────────────────
    def _build_anthropic_system(self) -> list[dict]:
        """Build the `system` field as text blocks with a cache_control
        breakpoint on the static core. Everything up to and including that block
        (the tool schemas render before `system`, so they are covered too) is
        cached server-side; the dynamic tail sits after the breakpoint. This is
        Claude Code's scope-omitted path. See how-claude-code-works ch3.6."""
        plan_suffix = self._build_plan_mode_prompt() if self.permission_mode == "plan" else ""
        dynamic_text = (self._dynamic_system_context + plan_suffix).strip()
        blocks: list[dict] = [
            {"type": "text", "text": self._static_system_prompt, "cache_control": {"type": "ephemeral"}}
        ]
        if dynamic_text:
            blocks.append({"type": "text", "text": dynamic_text})
        return blocks

    def _with_cache_breakpoints(self, messages: list[dict]) -> list[dict]:
        """Return a COPY of the message list with a cache_control breakpoint on
        the last message's final content block, so every prior turn stays in the
        cached prefix and only the newest messages are processed. Pure: the
        persistent history is never mutated with this API metadata (Claude Code
        clones request params at the render layer for the same reason, keeping
        session save / compact / restore clean). Faithful to CC's
        assistantMessageToMessageParam, we look only at the very LAST block and
        skip it when it is a thinking block (unstable content → hurts cache
        hits). Only 1 message breakpoint + 1 system breakpoint per request."""
        if not messages:
            return messages
        out = list(messages)
        last = out[-1]
        raw = last.get("content")
        content = [{"type": "text", "text": raw}] if isinstance(raw, str) else list(raw)
        tail = content[-1] if content else None
        if isinstance(tail, dict) and tail.get("type") not in ("thinking", "redacted_thinking"):
            content[-1] = {**tail, "cache_control": {"type": "ephemeral"}}
            out[-1] = {**last, "content": content}
        return out

    def _resolve_thinking_mode(self) -> str:
        if not self.thinking:
            return "disabled"
        if not _model_supports_thinking(self.model):
            return "disabled"
        if _model_supports_adaptive_thinking(self.model):
            return "adaptive"
        return "enabled"

    @property
    def is_processing(self) -> bool:
        return self._current_task is not None and not self._current_task.done()

    def _build_side_query(self):
        """Build a sideQuery callable for memory recall and the Auto Mode
        classifier, works with both backends. temperature=0 for a deterministic
        decision — the same input should always yield the same verdict (Claude
        Code runs the classifier at temperature 0)."""
        if self._anthropic_client:
            client = self._anthropic_client
            model = self.model
            async def _sq(system: str, user_message: str) -> str:
                resp = await client.messages.create(
                    model=model, max_tokens=256, system=system, temperature=0,
                    messages=[{"role": "user", "content": user_message}],
                )
                return "".join(b.text for b in resp.content if b.type == "text")
            return _sq
        if self._openai_client:
            client = self._openai_client
            model = self.model
            async def _sq_oai(system: str, user_message: str) -> str:
                resp = await client.chat.completions.create(
                    model=model, max_tokens=256, temperature=0,
                    messages=[
                        {"role": "system", "content": system},
                        {"role": "user", "content": user_message},
                    ],
                )
                return resp.choices[0].message.content or "" if resp.choices else ""
            return _sq_oai
        return None

    def abort(self) -> None:
        self._aborted = True
        if self._current_task and not self._current_task.done():
            self._current_task.cancel()

    def set_confirm_fn(self, fn: Callable[[str], Awaitable[bool]]) -> None:
        self.confirm_fn = fn

    def set_plan_approval_fn(self, fn: Callable[[str], Awaitable[dict]]) -> None:
        self._plan_approval_fn = fn

    # ─── Plan mode toggle ────────────────────────────────────

    def toggle_plan_mode(self) -> str:
        if self.permission_mode == "plan":
            self.permission_mode = self._pre_plan_mode or "default"
            self._pre_plan_mode = None
            self._plan_file_path = None
            self._system_prompt = self._base_system_prompt
            if self.use_openai and self._openai_messages:
                self._openai_messages[0]["content"] = self._system_prompt
            print_info(f"Exited plan mode → {self.permission_mode} mode")
            return self.permission_mode
        else:
            self._pre_plan_mode = self.permission_mode
            self.permission_mode = "plan"
            self._plan_file_path = self._generate_plan_file_path()
            self._system_prompt = self._base_system_prompt + self._build_plan_mode_prompt()
            if self.use_openai and self._openai_messages:
                self._openai_messages[0]["content"] = self._system_prompt
            print_info(f"Entered plan mode. Plan file: {self._plan_file_path}")
            return "plan"

    def get_token_usage(self) -> dict:
        return {"input": self.total_input_tokens, "output": self.total_output_tokens}

    # ─── Main entry point ────────────────────────────────────

    async def chat(self, user_message: str) -> None:
        # Lazily connect to MCP servers on first chat (main agent only)
        if not self._mcp_initialized and not self.is_sub_agent:
            self._mcp_initialized = True
            try:
                await self._mcp_manager.load_and_connect()
                mcp_defs = self._mcp_manager.get_tool_definitions()
                if mcp_defs:
                    self.tools = self.tools + mcp_defs
            except Exception as e:
                print(f"[mcp] Init failed: {e}", flush=True)

        self._aborted = False
        coro = self._chat_openai(user_message) if self.use_openai else self._chat_anthropic(user_message)
        self._current_task = asyncio.current_task()
        try:
            await coro
        except asyncio.CancelledError:
            self._aborted = True
        finally:
            self._current_task = None
        if not self.is_sub_agent:
            print_divider()
            self._auto_save()

    # ─── Sub-agent entry point ────────────────────────────────

    async def run_once(self, prompt: str) -> dict:
        self._output_buffer = []
        prev_in = self.total_input_tokens
        prev_out = self.total_output_tokens
        await self.chat(prompt)
        text = "".join(self._output_buffer)
        self._output_buffer = None
        return {
            "text": text,
            "tokens": {
                "input": self.total_input_tokens - prev_in,
                "output": self.total_output_tokens - prev_out,
            },
        }

    # ─── Output helper ────────────────────────────────────────

    def _emit_text(self, text: str) -> None:
        if self._output_buffer is not None:
            self._output_buffer.append(text)
        else:
            print_assistant_text(text)

    # ─── REPL commands ────────────────────────────────────────

    def clear_history(self) -> None:
        self._anthropic_messages = []
        self._openai_messages = []
        if self.use_openai:
            self._openai_messages.append({"role": "system", "content": self._system_prompt})
        self.total_input_tokens = 0
        self.total_output_tokens = 0
        self.total_cache_read_tokens = 0
        self.total_cache_creation_tokens = 0
        self.last_input_token_count = 0
        print_info("Conversation cleared.")

    def show_cost(self) -> None:
        total = self._get_current_cost_usd()
        budget_info = f" / ${self.max_cost_usd} budget" if self.max_cost_usd else ""
        turn_info = f" | Turns: {self.current_turns}/{self.max_turns}" if self.max_turns else ""
        cached = self.total_cache_read_tokens
        billed_input = self.total_input_tokens + self.total_cache_creation_tokens + cached
        hit_rate = round((cached / billed_input) * 100) if billed_input > 0 else 0
        cache_info = (
            f"\n  Cache: {cached} read / {self.total_cache_creation_tokens} write ({hit_rate}% of input from cache)"
            if (cached or self.total_cache_creation_tokens) else ""
        )
        print_info(f"Tokens: {self.total_input_tokens} in / {self.total_output_tokens} out{cache_info}\n  Estimated cost: ${total:.4f}{budget_info}{turn_info}")

    def _get_current_cost_usd(self) -> float:
        # Base input $3/Mtok. Cache read is 0.1x, cache write is 1.25x — the
        # fixed multipliers Claude Code uses across every model tier.
        M = 1_000_000
        return (
            (self.total_input_tokens / M) * 3
            + (self.total_cache_read_tokens / M) * 0.3
            + (self.total_cache_creation_tokens / M) * 3.75
            + (self.total_output_tokens / M) * 15
        )

    def _check_budget(self) -> dict:
        if self.max_cost_usd is not None and self._get_current_cost_usd() >= self.max_cost_usd:
            return {"exceeded": True, "reason": f"Cost limit reached (${self._get_current_cost_usd():.4f} >= ${self.max_cost_usd})"}
        if self.max_turns is not None and self.current_turns >= self.max_turns:
            return {"exceeded": True, "reason": f"Turn limit reached ({self.current_turns} >= {self.max_turns})"}
        return {"exceeded": False}

    async def compact(self) -> None:
        await self._compact_conversation()

    # ─── /goal pursuit ────────────────────────────────────────
    # A prompt-based Stop hook: after each turn a separate evaluator model judges
    # the condition; not-met feeds its reason into the next turn, met/impossible
    # stop. See autonomy.py for the (verbatim) evaluator prompt.

    def set_goal(self, condition: str) -> str:
        """Set the active goal and return the first-turn directive to run."""
        self.active_goal = {"condition": condition, "iterations": 0, "started_at": time.time(), "last_reason": None}
        print_info(f'◎ /goal active — Stop hook condition: "{condition}"')
        return goal_directive(condition)

    def show_goal(self) -> None:
        """`/goal` with no argument prints the current goal's status."""
        if not self.active_goal:
            print_info("No active goal. Set one with /goal <condition>.")
            return
        secs = time.time() - self.active_goal["started_at"]
        last = f"\n  last reason: {self.active_goal['last_reason']}" if self.active_goal["last_reason"] else ""
        print_info(
            f"◎ /goal active\n  condition: {self.active_goal['condition']}\n"
            f"  iterations: {self.active_goal['iterations']}\n  elapsed: {secs:.1f}s{last}"
        )

    async def pursue_goal(self, directive: str) -> None:
        """Pursue the active goal: run the directive turn, then loop
        evaluate → (not met) feed reason back → next turn, until met, impossible,
        budget/iteration cap, or interrupt."""
        if not self.active_goal:
            return
        self.goal_stop = False
        try:
            await self.chat(directive)
            # Evaluate the turn that just finished *before* any cap or next-turn
            # decision, so the final turn's output is never left unjudged.
            while self.active_goal and not self.goal_stop and not self._aborted:
                verdict = await self._evaluate_goal(self.active_goal["condition"])
                if verdict["ok"]:
                    turns = self.active_goal["iterations"] + 1
                    secs = time.time() - self.active_goal["started_at"]
                    plural = "" if turns == 1 else "s"
                    print_info(f"✓ Goal achieved ({turns} turn{plural}, {secs:.1f}s): {verdict['reason']}")
                    break
                if verdict.get("impossible"):
                    print_info(f"Hooks: Prompt hook condition judged impossible: {verdict['reason']}")
                    break

                # Not met: record and decide whether another turn is allowed.
                self.active_goal["iterations"] += 1
                self.active_goal["last_reason"] = verdict["reason"]
                print_info(f"Hooks: Prompt hook condition was not met: {verdict['reason']}")

                budget = self._check_budget()
                if budget["exceeded"]:
                    print_info(f"Goal stopped: {budget['reason']}")
                    break
                # Hard ceiling regardless of --max-turns: --max-turns only counts
                # tool-executing turns (_check_budget), so a no-tool goal loop
                # needs an unconditional backstop of its own.
                if self.active_goal["iterations"] >= GOAL_MAX_ITERATIONS:
                    print_info(f"Goal stopped: reached {GOAL_MAX_ITERATIONS} iterations without meeting the condition.")
                    break
                if self.goal_stop or self._aborted:
                    break

                await self.chat(
                    f"Hooks: Prompt hook condition was not met: {verdict['reason']}\n\nKeep working toward the goal."
                )
            if self.goal_stop or self._aborted:
                print_info("Goal pursuit interrupted.")
        finally:
            # Clear on any exit (met / impossible / capped / interrupted) so a
            # stale goal never lingers. Real Claude Code keeps it session-scoped
            # and resumable; we don't implement resume.
            self.active_goal = None

    async def _evaluate_goal(self, condition: str) -> dict:
        """One evaluator pass over the just-finished turn's transcript. The
        transcript is sent as its own assistant message (framed by a preceding
        user message as data-to-judge), so a crafted turn can't smuggle fake
        user/judge text into the evaluator's context — real Claude Code likewise
        sends the turn as a separate transcript message, not inlined."""
        transcript = self._extract_last_assistant_text()
        messages = [
            {"role": "user", "content": GOAL_TRANSCRIPT_FRAMING},
            {"role": "assistant", "content": transcript or "(no assistant output)"},
            {"role": "user", "content": goal_judge_user_message(condition)},
        ]
        try:
            raw = await self._run_evaluator_query(GOAL_EVALUATOR_SYSTEM, messages)
            return parse_goal_verdict(raw)
        except Exception as e:
            # Evaluator error → treat as not-met (never accidentally clears goal).
            return {"ok": False, "reason": f"evaluator error: {e}", "impossible": False}

    async def _run_evaluator_query(self, system: str, messages: list) -> str:
        """Send a role-separated evaluator query on whichever backend is
        configured and return the model's text. Like _build_side_query but takes
        a full messages array (that one is single-user-message, for memory
        recall)."""
        if self._anthropic_client:
            resp = await self._anthropic_client.messages.create(
                model=self.model, max_tokens=512, system=system, temperature=0, messages=messages,
            )
            return "".join(b.text for b in resp.content if b.type == "text")
        if self._openai_client:
            resp = await self._openai_client.chat.completions.create(
                model=self.model, max_tokens=512, temperature=0,
                messages=[{"role": "system", "content": system}, *messages],
            )
            return resp.choices[0].message.content or "" if resp.choices else ""
        raise RuntimeError("no evaluator model available")

    def _extract_last_assistant_text(self) -> str:
        """The text of the most recent assistant turn, for the evaluator to
        judge. Transcript-only: the action under judgement is the latest turn."""
        if self.use_openai:
            for m in reversed(self._openai_messages):
                if m.get("role") == "assistant" and isinstance(m.get("content"), str):
                    return m["content"]
            return ""
        for m in reversed(self._anthropic_messages):
            if m.get("role") != "assistant":
                continue
            content = m.get("content")
            if isinstance(content, str):
                return content
            if isinstance(content, list):
                return "".join(
                    b.get("text", "") for b in content
                    if isinstance(b, dict) and b.get("type") == "text"
                )
        return ""

    # ─── /loop — recurring or self-paced prompt ───────────────
    # Unlike /goal (a stop-hook gate), /loop actively reschedules itself: a fixed
    # interval, or — with no interval — a pace the main model picks via the
    # schedule_wakeup tool. See autonomy.py for the parser and tool schema.

    async def run_loop(self, raw_input: str) -> None:
        """Entry point for the /loop command. Parses the input, then drives the
        matching mode. Returns without looping if the input is malformed."""
        spec = parse_loop_input(raw_input)
        if "error" in spec:
            print_info(spec["error"])
            return
        # Offer-cloud decision point (interval >=60min or daily wording). Real
        # Claude Code asks whether to convert to a persistent cloud schedule that
        # survives the session; this teaching CLI has no cloud, so we only
        # surface it.
        wants_cloud = (
            (spec["mode"] == "interval" and spec["interval_seconds"] >= OFFER_CLOUD_THRESHOLD_SECONDS)
            or is_daily_wording(raw_input)
        )
        if wants_cloud:
            print_info(
                "(Real Claude Code would offer to convert this to a persistent cloud schedule "
                "that keeps running after the session ends. This teaching build has no cloud "
                "backend — continuing in-session.)"
            )

        self.loop_stop = False
        try:
            if spec["mode"] == "interval":
                await self._run_loop_interval(spec)
            else:
                await self._run_loop_dynamic(spec)
        except asyncio.CancelledError:
            print_info("Loop interrupted.")

    async def _run_loop_interval(self, spec: dict) -> None:
        """Interval mode: re-run the prompt every N seconds until interrupted or
        the iteration cap. Corresponds to Claude Code's in-session CronCreate
        path (session-only, not persisted). We use a plain timer in place of the
        cron engine + KAIROS daemon."""
        print_info(
            f"⟳ /loop scheduled every {spec['interval_label']} (session-only, not persisted — "
            "dies when this process exits). Ctrl+C to stop."
        )
        iterations = 0
        while not self.loop_stop and not self._aborted:
            iterations += 1
            print_info(f"⟳ loop tick {iterations}")
            await self.chat(spec["prompt"])

            budget = self._check_budget()
            if budget["exceeded"]:
                print_info(f"Loop stopped: {budget['reason']}")
                break
            # --max-turns also bounds loop ticks: _check_budget's turn counter
            # only increments on tool-executing turns, so a plain-text loop would
            # never hit it — treat --max-turns as a tick limit here too.
            if self.max_turns is not None and iterations >= self.max_turns:
                print_info(f"Loop stopped: tick limit reached ({iterations} >= {self.max_turns}).")
                break
            if iterations >= LOOP_MAX_ITERATIONS:
                print_info(f"Loop stopped: reached {LOOP_MAX_ITERATIONS} ticks.")
                break
            interrupted = await self._interruptible_sleep(spec["interval_seconds"])
            if interrupted:
                print_info("Loop stopped.")
                break

    async def _run_loop_dynamic(self, spec: dict) -> None:
        """Dynamic mode: run the tick, then let the main model self-pace via
        schedule_wakeup. If it scheduled a wakeup, wait the (clamped) delay and
        run again with the prompt it passed back; if it didn't, the loop has
        converged. Faithful to "dynamic pacing is decided by the main model, no
        separate evaluator." schedule_wakeup is exposed only for the loop."""
        print_info(
            "⟳ /loop dynamic (self-paced) — the model schedules its own next run, or ends the "
            "loop. Ctrl+C to stop."
        )
        had_tool = any(t["name"] == "schedule_wakeup" for t in self.tools)
        if not had_tool:
            self.tools = self.tools + [SCHEDULE_WAKEUP_TOOL]
        self.schedule_wakeup_enabled = True
        prompt = spec["prompt"]
        iterations = 0
        try:
            while not self.loop_stop and not self._aborted:
                iterations += 1
                self.pending_wakeup = None
                await self.chat(dynamic_loop_directive(prompt))

                if not self.pending_wakeup:
                    plural = "" if iterations == 1 else "s"
                    print_info(f"⟳ Loop converged after {iterations} tick{plural} (model scheduled no wakeup).")
                    break
                budget = self._check_budget()
                if budget["exceeded"]:
                    print_info(f"Loop stopped: {budget['reason']}")
                    break
                if self.max_turns is not None and iterations >= self.max_turns:
                    print_info(f"Loop stopped: tick limit reached ({iterations} >= {self.max_turns}).")
                    break
                if iterations >= LOOP_MAX_ITERATIONS:
                    print_info(f"Loop stopped: reached {LOOP_MAX_ITERATIONS} ticks.")
                    break
                delay = self.pending_wakeup["delay_seconds"]
                print_info(f"⟳ next run in {delay}s — {self.pending_wakeup['reason']}")
                prompt = self.pending_wakeup["prompt"] or prompt
                interrupted = await self._interruptible_sleep(delay)
                if interrupted:
                    print_info("Loop stopped.")
                    break
        finally:
            # Remove schedule_wakeup so it isn't exposed outside the dynamic loop.
            if not had_tool:
                self.tools = [t for t in self.tools if t["name"] != "schedule_wakeup"]
            self.schedule_wakeup_enabled = False
            self.pending_wakeup = None

    def _execute_schedule_wakeup(self, inp: dict) -> str:
        """schedule_wakeup executor: record the requested wakeup for the loop
        driver. Delay is clamped to [60, 3600]; the driver reads pending_wakeup
        after the turn converges."""
        delay = clamp_wakeup_delay(inp.get("delaySeconds"))
        reason = inp.get("reason") if isinstance(inp.get("reason"), str) else ""
        prompt = inp.get("prompt") if isinstance(inp.get("prompt"), str) else ""
        self.pending_wakeup = {"delay_seconds": delay, "reason": reason, "prompt": prompt}
        return f"Wakeup scheduled in {delay}s. The loop will resume then; end your turn now."

    async def _interruptible_sleep(self, seconds: float) -> bool:
        """Sleep that resolves early (returning True) if the loop is stopped or
        the turn is aborted. Avoids blocking on a long interval past a Ctrl+C."""
        import time as _time
        start = _time.time()
        while _time.time() - start < seconds:
            if self.loop_stop or self._aborted:
                return True
            await asyncio.sleep(min(0.2, seconds))
        return False

    def stop_loop(self) -> None:
        """Stop a running /loop (called from the REPL's interrupt handler)."""
        self.loop_stop = True

    def stop_goal(self) -> None:
        """Stop a running /goal pursuit (called from the REPL's interrupt
        handler). Takes effect at the next turn boundary — an in-flight turn is
        aborted separately via abort()."""
        self.goal_stop = True

    # ─── Auto Mode — transcript-classifier permission gate ────
    # In `auto` mode the classifier replaces the human confirm prompt: deny rules
    # still hard-block, read-only tools fast-path through, everything else is
    # judged by an LLM reading a reasoning-blind transcript projection.

    async def _classify_tool_call(self, tool_name: str, inp: dict) -> dict:
        """Decide a tool call in Auto Mode. Returns allow/deny like
        check_permission, or "confirm" to hand back to a human once the denial
        limits trip."""
        # Hard floor first: deny rules bind even here.
        base = check_permission(tool_name, inp, "default", self._plan_file_path)
        if base["action"] == "deny":
            return base
        # Fast-path: read-only / side-effect-free tools skip the classifier.
        if tool_name in AUTO_MODE_FAST_PATH_TOOLS:
            return {"action": "allow"}

        sq = self._build_side_query()
        if not sq:
            # No evaluator available → fail closed. Defer to a human if present
            # (interactive), else deny outright (headless: CC aborts here).
            return self._auto_fallback(f"{tool_name} (auto-mode classifier unavailable)")
        try:
            rules = load_auto_mode_rules()
            history = self._openai_messages if self.use_openai else self._anthropic_messages
            transcript = build_classifier_transcript(history, {"tool_name": tool_name, "input": inp})
            system = build_classifier_system(rules)
            # CLAUDE.md rides in the user message, not the system prompt — it is
            # untrusted repo content.
            user = classifier_user_message(rules, transcript, load_claude_md())
            raw = await sq(system, user)
            verdict = parse_block_verdict(raw)
        except Exception as e:
            # Any setup or classifier error → fail closed (block), matching CC's
            # iron gate. Wrapping the asset load here keeps a missing/bad rules
            # file from crashing the turn and orphaning the tool_use.
            verdict = {"block": True, "reason": f"classifier error: {e}"}

        if not verdict["block"]:
            self.auto_consecutive_denials = 0
            return {"action": "allow"}

        self.auto_consecutive_denials += 1
        self.auto_total_denials += 1
        if (
            self.auto_consecutive_denials >= DENIAL_LIMITS["max_consecutive"]
            or self.auto_total_denials >= DENIAL_LIMITS["max_total"]
        ):
            # Too many denials — the classifier may be stuck. Hand back to a human
            # if interactive; deny in headless (CC aborts the agent here).
            print_info("Auto Mode: denial limit reached — handing back to manual confirmation.")
            return self._auto_fallback(f"[Auto Mode blocked] {verdict['reason']}")
        return {"action": "deny", "message": f"[Auto Mode] {verdict['reason']}"}

    def _auto_fallback(self, message: str) -> dict:
        """Auto Mode fail-safe: defer to a human confirm if one is available,
        else deny (headless). Never returns "allow" — the point is to not run an
        unjudged action."""
        if self.confirm_fn:
            return {"action": "confirm", "message": message}
        return {"action": "deny", "message": f"{message} (headless — denied)"}

    def _child_permission_mode(self) -> str:
        """Permission mode a spawned sub-agent inherits. plan and auto must carry
        through — a sub-agent otherwise runs bypassPermissions, so in Auto Mode
        the main model could launder a blocked action through
        agent(prompt="git push origin main") and have the sub-agent run it
        unclassified. Claude Code puts every sub-agent tool call through
        canUseTool individually."""
        if self.permission_mode == "plan":
            return "plan"
        if self.permission_mode == "auto":
            return "auto"
        return "bypassPermissions"

    # ─── Session ──────────────────────────────────────────────

    def restore_session(self, data: dict) -> None:
        if data.get("anthropicMessages"):
            self._anthropic_messages = data["anthropicMessages"]
        if data.get("openaiMessages"):
            self._openai_messages = data["openaiMessages"]
        print_info(f"Session restored ({self._get_message_count()} messages).")

    def _get_message_count(self) -> int:
        return len(self._openai_messages) if self.use_openai else len(self._anthropic_messages)

    def _auto_save(self) -> None:
        try:
            save_session(self.session_id, {
                "metadata": {
                    "id": self.session_id,
                    "model": self.model,
                    "cwd": str(Path.cwd()),
                    "startTime": self.session_start_time,
                    "messageCount": self._get_message_count(),
                },
                "anthropicMessages": self._anthropic_messages if not self.use_openai else None,
                "openaiMessages": self._openai_messages if self.use_openai else None,
            })
        except Exception:
            pass

    # ─── Autocompact ──────────────────────────────────────────

    async def _check_and_compact(self) -> None:
        if self.last_input_token_count > self.effective_window * 0.85:
            print_info("Context window filling up, compacting conversation...")
            await self._compact_conversation()

    async def _compact_conversation(self) -> None:
        if self.use_openai:
            await self._compact_openai()
        else:
            await self._compact_anthropic()
        print_info("Conversation compacted.")

    async def _compact_anthropic(self) -> None:
        # Invariant: caller must ensure the last message is a plain user-text
        # message (not a tool_result). We slice it off below; if it were a
        # tool_result, the preceding assistant's tool_use would be orphaned
        # and the API would reject the summarize call.
        if len(self._anthropic_messages) < 4:
            return
        last_user_msg = self._anthropic_messages[-1]
        summary_resp = await self._anthropic_client.messages.create(
            model=self.model,
            max_tokens=2048,
            system="You are a conversation summarizer. Be concise but preserve important details.",
            messages=[
                *self._anthropic_messages[:-1],
                {"role": "user", "content": "Summarize the conversation so far in a concise paragraph, preserving key decisions, file paths, and context needed to continue the work."},
            ],
        )
        summary_text = summary_resp.content[0].text if summary_resp.content and summary_resp.content[0].type == "text" else "No summary available."
        self._anthropic_messages = [
            {"role": "user", "content": f"[Previous conversation summary]\n{summary_text}"},
            {"role": "assistant", "content": "Understood. I have the context from our previous conversation. How can I continue helping?"},
        ]
        if last_user_msg.get("role") == "user":
            self._anthropic_messages.append(last_user_msg)
        self.last_input_token_count = 0

    async def _compact_openai(self) -> None:
        # Invariant: caller must ensure the last message is a plain user-text
        # message (not a `tool` role result). Same reasoning as
        # _compact_anthropic — slicing off a tool result would orphan the
        # preceding assistant's tool_calls.
        if len(self._openai_messages) < 5:
            return
        system_msg = self._openai_messages[0]
        last_user_msg = self._openai_messages[-1]
        summary_resp = await self._openai_client.chat.completions.create(
            model=self.model,
            messages=[
                {"role": "system", "content": "You are a conversation summarizer. Be concise but preserve important details."},
                *self._openai_messages[1:-1],
                {"role": "user", "content": "Summarize the conversation so far in a concise paragraph, preserving key decisions, file paths, and context needed to continue the work."},
            ],
        )
        summary_text = summary_resp.choices[0].message.content or "No summary available."
        self._openai_messages = [
            system_msg,
            {"role": "user", "content": f"[Previous conversation summary]\n{summary_text}"},
            {"role": "assistant", "content": "Understood. I have the context from our previous conversation. How can I continue helping?"},
        ]
        if last_user_msg.get("role") == "user":
            self._openai_messages.append(last_user_msg)
        self.last_input_token_count = 0

    # ─── Multi-tier compression pipeline ──────────────────────

    def _run_compression_pipeline(self) -> None:
        if self.use_openai:
            self._budget_tool_results_openai()
            self._snip_stale_results_openai()
            self._microcompact_openai()
        else:
            self._budget_tool_results_anthropic()
            self._snip_stale_results_anthropic()
            self._microcompact_anthropic()

    # Tier 1: Budget tool results
    def _budget_tool_results_anthropic(self) -> None:
        utilization = self.last_input_token_count / self.effective_window if self.effective_window else 0
        if utilization < 0.5:
            return
        budget = 15000 if utilization > 0.7 else 30000
        for msg in self._anthropic_messages:
            if msg.get("role") != "user" or not isinstance(msg.get("content"), list):
                continue
            for block in msg["content"]:
                if isinstance(block, dict) and block.get("type") == "tool_result" and isinstance(block.get("content"), str) and len(block["content"]) > budget:
                    keep = (budget - 80) // 2
                    block["content"] = block["content"][:keep] + f"\n\n[... budgeted: {len(block['content']) - keep * 2} chars truncated ...]\n\n" + block["content"][-keep:]

    def _budget_tool_results_openai(self) -> None:
        utilization = self.last_input_token_count / self.effective_window if self.effective_window else 0
        if utilization < 0.5:
            return
        budget = 15000 if utilization > 0.7 else 30000
        for msg in self._openai_messages:
            if msg.get("role") == "tool" and isinstance(msg.get("content"), str) and len(msg["content"]) > budget:
                keep = (budget - 80) // 2
                msg["content"] = msg["content"][:keep] + f"\n\n[... budgeted: {len(msg['content']) - keep * 2} chars truncated ...]\n\n" + msg["content"][-keep:]

    # Tier 2: Snip stale results
    def _snip_stale_results_anthropic(self) -> None:
        # Cache-aware gate (mirrors Claude Code's cached-microcompact split):
        # while the prompt cache is still hot, rewriting an old tool_result in
        # place would invalidate the entire cached message prefix. Claude Code
        # prunes hot caches via a cache_edits API call unavailable on the public
        # API, so we leave the hot prefix alone — UNTIL utilization is high
        # enough (SNIP_HOT_OVERRIDE) that risking an overflow costs more than one
        # cache rebuild. Below that we wait for the cache to go cold.
        utilization = self.last_input_token_count / self.effective_window if self.effective_window else 0
        cache_hot = self.last_api_call_time > 0 and (time.time() - self.last_api_call_time) < MICROCOMPACT_IDLE_S
        if cache_hot and utilization < SNIP_HOT_OVERRIDE:
            return
        if utilization < SNIP_THRESHOLD:
            return

        results = []
        for mi, msg in enumerate(self._anthropic_messages):
            if msg.get("role") != "user" or not isinstance(msg.get("content"), list):
                continue
            for bi, block in enumerate(msg["content"]):
                if isinstance(block, dict) and block.get("type") == "tool_result" and isinstance(block.get("content"), str) and block["content"] != SNIP_PLACEHOLDER:
                    tool_use_id = block.get("tool_use_id")
                    tool_info = self._find_tool_use_by_id(tool_use_id)
                    if tool_info and tool_info["name"] in SNIPPABLE_TOOLS:
                        results.append({"mi": mi, "bi": bi, "name": tool_info["name"], "file_path": tool_info.get("input", {}).get("file_path")})

        if len(results) <= KEEP_RECENT_RESULTS:
            return

        to_snip = set()
        seen_files: dict[str, list[int]] = {}
        for i, r in enumerate(results):
            if r["name"] == "read_file" and r.get("file_path"):
                seen_files.setdefault(r["file_path"], []).append(i)

        for indices in seen_files.values():
            if len(indices) > 1:
                for j in indices[:-1]:
                    to_snip.add(j)

        snip_before = len(results) - KEEP_RECENT_RESULTS
        for i in range(snip_before):
            to_snip.add(i)

        for idx in to_snip:
            r = results[idx]
            self._anthropic_messages[r["mi"]]["content"][r["bi"]]["content"] = SNIP_PLACEHOLDER

    def _snip_stale_results_openai(self) -> None:
        # Cache-aware gate — see _snip_stale_results_anthropic. OpenAI-compatible
        # providers cache prefixes automatically, so the same "don't rewrite a
        # hot prefix (unless utilization is high)" rule applies.
        utilization = self.last_input_token_count / self.effective_window if self.effective_window else 0
        cache_hot = self.last_api_call_time > 0 and (time.time() - self.last_api_call_time) < MICROCOMPACT_IDLE_S
        if cache_hot and utilization < SNIP_HOT_OVERRIDE:
            return
        if utilization < SNIP_THRESHOLD:
            return
        tool_msgs = []
        for i, msg in enumerate(self._openai_messages):
            if msg.get("role") == "tool" and isinstance(msg.get("content"), str) and msg["content"] != SNIP_PLACEHOLDER:
                tool_msgs.append(i)
        if len(tool_msgs) <= KEEP_RECENT_RESULTS:
            return
        snip_count = len(tool_msgs) - KEEP_RECENT_RESULTS
        for i in range(snip_count):
            self._openai_messages[tool_msgs[i]]["content"] = SNIP_PLACEHOLDER

    # Tier 3: Microcompact
    def _microcompact_anthropic(self) -> None:
        if not self.last_api_call_time or (time.time() - self.last_api_call_time) < MICROCOMPACT_IDLE_S:
            return
        all_results = []
        for mi, msg in enumerate(self._anthropic_messages):
            if msg.get("role") != "user" or not isinstance(msg.get("content"), list):
                continue
            for bi, block in enumerate(msg["content"]):
                if isinstance(block, dict) and block.get("type") == "tool_result" and isinstance(block.get("content"), str) and block["content"] not in (SNIP_PLACEHOLDER, "[Old result cleared]"):
                    all_results.append((mi, bi))
        clear_count = len(all_results) - KEEP_RECENT_RESULTS
        for i in range(max(0, clear_count)):
            mi, bi = all_results[i]
            self._anthropic_messages[mi]["content"][bi]["content"] = "[Old result cleared]"

    def _microcompact_openai(self) -> None:
        if not self.last_api_call_time or (time.time() - self.last_api_call_time) < MICROCOMPACT_IDLE_S:
            return
        tool_msgs = []
        for i, msg in enumerate(self._openai_messages):
            if msg.get("role") == "tool" and isinstance(msg.get("content"), str) and msg["content"] not in (SNIP_PLACEHOLDER, "[Old result cleared]"):
                tool_msgs.append(i)
        clear_count = len(tool_msgs) - KEEP_RECENT_RESULTS
        for i in range(max(0, clear_count)):
            self._openai_messages[tool_msgs[i]]["content"] = "[Old result cleared]"

    def _find_tool_use_by_id(self, tool_use_id: str) -> dict | None:
        for msg in self._anthropic_messages:
            if msg.get("role") != "assistant" or not isinstance(msg.get("content"), list):
                continue
            for block in msg["content"]:
                if isinstance(block, dict) and block.get("type") == "tool_use" and block.get("id") == tool_use_id:
                    return {"name": block["name"], "input": block.get("input", {})}
        return None

    # ─── Large result persistence ─────────────────────────────────
    # When a tool result exceeds 30 KB, write it to disk and replace the
    # context entry with a short preview + file path.  The model can use
    # read_file to retrieve the full output later — no information is lost.

    def _persist_large_result(self, tool_name: str, result: str) -> str:
        THRESHOLD = 30 * 1024  # 30 KB
        if len(result.encode()) <= THRESHOLD:
            return result
        d = Path.home() / ".mini-claude" / "tool-results"
        d.mkdir(parents=True, exist_ok=True)
        # uuid suffix: parallel tools can persist in the same millisecond —
        # a timestamp-only name would let the second write clobber the first.
        filename = f"{int(time.time() * 1000)}-{uuid.uuid4().hex[:8]}-{tool_name}.txt"
        filepath = d / filename
        filepath.write_text(result, encoding="utf-8")

        lines = result.split("\n")
        preview = "\n".join(lines[:200])
        size_kb = len(result.encode()) / 1024

        # Truncate AFTER persisting: the full result is already safe on disk,
        # so this only guards against pathological previews (e.g. a single
        # multi-hundred-KB line). Order matters — see issue #6.
        return _truncate_result(
            f"[Result too large ({size_kb:.1f} KB, {len(lines)} lines). "
            f"Full output saved to {filepath}. "
            f"You can use read_file to see the full result.]\n\n"
            f"Preview (first 200 lines):\n{preview}"
        )

    # ─── Execute tool (handles agent/skill/plan mode internally) ─────

    async def _execute_tool_call(self, name: str, inp: dict) -> str:
        if name in ("enter_plan_mode", "exit_plan_mode"):
            return await self._execute_plan_mode_tool(name)
        if name == "agent":
            return await self._execute_agent_tool(inp)
        if name == "skill":
            return await self._execute_skill_tool(inp)
        if name == "schedule_wakeup":
            # Only the internal dynamic-loop driver may route here; outside a
            # dynamic loop the tool isn't exposed, and this guard keeps a stray
            # call (or a same-named external tool) from reaching the executor.
            if not self.schedule_wakeup_enabled:
                return "schedule_wakeup is only available during /loop dynamic mode."
            return self._execute_schedule_wakeup(inp)
        # Route MCP tool calls to the MCP manager
        if self._mcp_manager.is_mcp_tool(name):
            return await self._mcp_manager.call_tool(name, inp)
        return await execute_tool(name, inp, self._read_file_state)

    # ─── Skill fork mode ─────────────────────────────────────

    async def _execute_skill_tool(self, inp: dict) -> str:
        from .skills import execute_skill
        result = execute_skill(inp.get("skill_name", ""), inp.get("args", ""))
        if not result:
            return f"Unknown skill: {inp.get('skill_name', '')}"

        if result["context"] == "fork":
            # Never pass schedule_wakeup down — it's a driver-internal tool scoped
            # to this agent's dynamic loop, not something a forked skill inherits.
            tools = [
                t for t in (
                    [t for t in self.tools if t["name"] in result["allowed_tools"]]
                    if result.get("allowed_tools")
                    else [t for t in self.tools if t["name"] != "agent"]
                )
                if t["name"] != "schedule_wakeup"
            ]
            print_sub_agent_start("skill-fork", inp.get("skill_name", ""))
            sub_agent = Agent(
                model=self.model,
                api_base=str(self._openai_client.base_url) if self.use_openai and self._openai_client else None,
                custom_system_prompt=result["prompt"],
                custom_tools=tools,
                is_sub_agent=True,
                permission_mode=self._child_permission_mode(),
            )
            try:
                sub_result = await sub_agent.run_once(inp.get("args") or "Execute this skill task.")
                self.total_input_tokens += sub_result["tokens"]["input"]
                self.total_output_tokens += sub_result["tokens"]["output"]
                print_sub_agent_end("skill-fork", inp.get("skill_name", ""))
                return sub_result["text"] or "(Skill produced no output)"
            except Exception as e:
                print_sub_agent_end("skill-fork", inp.get("skill_name", ""))
                return f"Skill fork error: {e}"

        return f'[Skill "{inp.get("skill_name", "")}" activated]\n\n{result["prompt"]}'

    # ─── Plan mode helpers ──────────────────────────────────────

    def _generate_plan_file_path(self) -> str:
        d = Path.home() / ".claude" / "plans"
        d.mkdir(parents=True, exist_ok=True)
        return str(d / f"plan-{self.session_id}.md")

    def _build_plan_mode_prompt(self) -> str:
        return f"""

# Plan Mode Active

Plan mode is active. You MUST NOT make any edits (except the plan file below), run non-readonly tools, or make any changes to the system.

## Plan File: {self._plan_file_path}
Write your plan incrementally to this file using write_file or edit_file. This is the ONLY file you are allowed to edit.

## Workflow
1. **Explore**: Read code to understand the task. Use read_file, list_files, grep_search.
2. **Design**: Design your implementation approach. Use the agent tool with type="plan" if the task is complex.
3. **Write Plan**: Write a structured plan to the plan file including:
   - **Context**: Why this change is needed
   - **Steps**: Implementation steps with critical file paths
   - **Verification**: How to test the changes
4. **Exit**: Call exit_plan_mode when your plan is ready for user review.

IMPORTANT: When your plan is complete, you MUST call exit_plan_mode. Do NOT ask the user to approve — exit_plan_mode handles that."""

    async def _execute_plan_mode_tool(self, name: str) -> str:
        if name == "enter_plan_mode":
            if self.permission_mode == "plan":
                return "Already in plan mode."
            self._pre_plan_mode = self.permission_mode
            self.permission_mode = "plan"
            self._plan_file_path = self._generate_plan_file_path()
            self._system_prompt = self._base_system_prompt + self._build_plan_mode_prompt()
            if self.use_openai and self._openai_messages:
                self._openai_messages[0]["content"] = self._system_prompt
            print_info("Entered plan mode (read-only). Plan file: " + self._plan_file_path)
            return f"Entered plan mode. You are now in read-only mode.\n\nYour plan file: {self._plan_file_path}\nWrite your plan to this file. This is the only file you can edit.\n\nWhen your plan is complete, call exit_plan_mode."

        if name == "exit_plan_mode":
            if self.permission_mode != "plan":
                return "Not in plan mode."
            plan_content = "(No plan file found)"
            if self._plan_file_path and Path(self._plan_file_path).exists():
                plan_content = Path(self._plan_file_path).read_text()

            # Interactive approval flow
            if self._plan_approval_fn:
                result = await self._plan_approval_fn(plan_content)
                choice = result.get("choice", "manual-execute")

                if choice == "keep-planning":
                    feedback = result.get("feedback") or "Please revise the plan."
                    return (
                        f"User rejected the plan and wants to keep planning.\n\n"
                        f"User feedback: {feedback}\n\n"
                        f"Please revise your plan based on this feedback. When done, call exit_plan_mode again."
                    )

                # User approved — determine target mode
                if choice == "clear-and-execute":
                    target_mode = "acceptEdits"
                elif choice == "execute":
                    target_mode = "acceptEdits"
                else:  # manual-execute
                    target_mode = self._pre_plan_mode or "default"

                # Exit plan mode
                self.permission_mode = target_mode
                self._pre_plan_mode = None
                saved_plan_path = self._plan_file_path
                self._plan_file_path = None
                self._system_prompt = self._base_system_prompt
                if self.use_openai and self._openai_messages:
                    self._openai_messages[0]["content"] = self._system_prompt

                if choice == "clear-and-execute":
                    self._clear_history_keep_system()
                    self._context_cleared = True
                    print_info(f"Plan approved. Context cleared, executing in {target_mode} mode.")
                    return (
                        f"User approved the plan. Context was cleared. Permission mode: {target_mode}\n\n"
                        f"Plan file: {saved_plan_path}\n\n"
                        f"## Approved Plan:\n{plan_content}\n\n"
                        f"Proceed with implementation."
                    )

                print_info(f"Plan approved. Executing in {target_mode} mode.")
                return (
                    f"User approved the plan. Permission mode: {target_mode}\n\n"
                    f"## Approved Plan:\n{plan_content}\n\n"
                    f"Proceed with implementation."
                )

            # Fallback: no approval function (e.g. sub-agents)
            self.permission_mode = self._pre_plan_mode or "default"
            self._pre_plan_mode = None
            self._plan_file_path = None
            self._system_prompt = self._base_system_prompt
            if self.use_openai and self._openai_messages:
                self._openai_messages[0]["content"] = self._system_prompt
            print_info("Exited plan mode. Restored to " + self.permission_mode + " mode.")
            return f"Exited plan mode. Permission mode restored to: {self.permission_mode}\n\n## Your Plan:\n{plan_content}"

        return f"Unknown plan mode tool: {name}"

    def _clear_history_keep_system(self) -> None:
        """Clear history but keep system prompt (used for clear-context plan approval)."""
        self._anthropic_messages = []
        self._openai_messages = []
        if self.use_openai:
            self._openai_messages.append({"role": "system", "content": self._system_prompt})
        self.last_input_token_count = 0

    async def _execute_agent_tool(self, inp: dict) -> str:
        agent_type = inp.get("type", "general")
        description = inp.get("description", "sub-agent task")
        prompt = inp.get("prompt", "")

        print_sub_agent_start(agent_type, description)

        config = get_sub_agent_config(agent_type)
        sub_agent = Agent(
            model=self.model,
            api_base=str(self._openai_client.base_url) if self.use_openai and self._openai_client else None,
            custom_system_prompt=config["system_prompt"],
            custom_tools=config["tools"],
            is_sub_agent=True,
            permission_mode=self._child_permission_mode(),
        )

        try:
            result = await sub_agent.run_once(prompt)
            self.total_input_tokens += result["tokens"]["input"]
            self.total_output_tokens += result["tokens"]["output"]
            print_sub_agent_end(agent_type, description)
            return result["text"] or "(Sub-agent produced no output)"
        except Exception as e:
            print_sub_agent_end(agent_type, description)
            return f"Sub-agent error: {e}"

    # ─── Anthropic backend ───────────────────────────────────────

    async def close(self) -> None:
        """Release external resources (MCP subprocesses) for a clean exit —
        see issue #8."""
        if self._mcp_initialized:
            await self._mcp_manager.disconnect_all()

    def _consume_memory_prefetch_if_ready(self, messages: list) -> None:
        """Inject recalled memories if the prefetch settled (non-blocking).
        Appends to the last user message to keep user/assistant alternation."""
        pf = self._memory_prefetch
        if not (pf and pf.settled and not pf.consumed):
            return
        pf.consumed = True
        try:
            memories = pf.task.result()
            if not memories:
                return
            injection_text = format_memories_for_injection(memories)
            last = messages[-1] if messages else None
            if last and last.get("role") == "user":
                content = last.get("content", "")
                if isinstance(content, str) or content is None:
                    last["content"] = (content or "") + "\n\n" + injection_text
                elif isinstance(content, list):
                    content.append({"type": "text", "text": injection_text})
            else:
                messages.append({"role": "user", "content": injection_text})
            for m in memories:
                self._already_surfaced_memories.add(m.path)
                self._session_memory_bytes += len(m.content.encode())
        except Exception:
            pass  # prefetch errors already logged

    def _start_memory_prefetch_for_turn(self, user_message: str, messages: list) -> None:
        """Drain any carry-over prefetch from the previous turn (a recall
        that settled after the last API call would otherwise be dropped —
        issue #7), then start a fresh prefetch for this query."""
        self._consume_memory_prefetch_if_ready(messages)
        if self.is_sub_agent:
            return
        if self._memory_prefetch and not self._memory_prefetch.settled:
            self._memory_prefetch.task.cancel()
        sq = self._build_side_query()
        if sq:
            self._memory_prefetch = start_memory_prefetch(
                user_message, sq,
                self._already_surfaced_memories, self._session_memory_bytes,
            )

    def _push_anthropic_user_message(self, content: str) -> None:
        """Push a user message, prepending the CLAUDE.md/date <system-reminder>
        when it is the first user message of a (possibly just-cleared) context —
        Claude Code's prependUserContext, kept out of the cached system prompt.
        Embedded in the user message rather than a standalone message to preserve
        user/assistant alternation. Also used by the plan clear-and-execute path,
        which rebuilds history from empty."""
        if not self._anthropic_messages and self._user_context_reminder:
            self._anthropic_messages.append({
                "role": "user",
                "content": [
                    {"type": "text", "text": self._user_context_reminder},
                    {"type": "text", "text": content},
                ],
            })
        else:
            self._anthropic_messages.append({"role": "user", "content": content})

    def _push_openai_user_message(self, content: str) -> None:
        is_first_user = not any(m.get("role") == "user" for m in self._openai_messages)
        if is_first_user and self._user_context_reminder:
            self._openai_messages.append({"role": "user", "content": f"{self._user_context_reminder}\n\n{content}"})
        else:
            self._openai_messages.append({"role": "user", "content": content})

    async def _chat_anthropic(self, user_message: str) -> None:
        self._push_anthropic_user_message(user_message)
        # Auto-compact at turn boundary only — the last message is now plain
        # user text, so the slice in _compact_anthropic won't sever a
        # tool_use ↔ tool_result pair from the previous turn's tool execution.
        await self._check_and_compact()

        # Memory prefetch: drain carry-over, then start fresh (issue #7)
        self._start_memory_prefetch_for_turn(user_message, self._anthropic_messages)

        while True:
            if self._aborted:
                break

            self._run_compression_pipeline()

            # Consume memory prefetch if settled (non-blocking poll, zero-wait)
            self._consume_memory_prefetch_if_ready(self._anthropic_messages)

            if not self.is_sub_agent:
                start_spinner()

            # ── Streaming tool execution ──────────────────────────────
            # As each tool_use content block completes during streaming, check
            # if it's concurrency-safe and auto-allowed. If so, start execution
            # immediately — the tool runs while the model still generates.
            early_executions: dict[str, asyncio.Task] = {}

            def _on_tool_block(block: dict):
                # In Auto Mode, only fast-path (classifier-exempt) tools may start
                # early — otherwise a concurrency-safe-but-classified tool (e.g.
                # web_fetch) would run before the classifier ever sees it.
                if self.permission_mode == "auto" and block["name"] not in AUTO_MODE_FAST_PATH_TOOLS:
                    return
                if block["name"] in CONCURRENCY_SAFE_TOOLS:
                    perm = check_permission(block["name"], block["input"], self.permission_mode, self._plan_file_path)
                    if perm["action"] == "allow":
                        task = asyncio.create_task(self._execute_tool_call(block["name"], block["input"]))
                        early_executions[block["id"]] = task

            response = await self._call_anthropic_stream(on_tool_block_complete=_on_tool_block)

            if not self.is_sub_agent:
                stop_spinner()

            self.last_api_call_time = time.time()
            # Anthropic reports cached tokens separately: `input_tokens` counts
            # only the uncached prefix, while cache_read/cache_creation are
            # billed at 0.1x/1.25x. Track them apart for cost.
            cache_read = getattr(response.usage, "cache_read_input_tokens", 0) or 0
            cache_creation = getattr(response.usage, "cache_creation_input_tokens", 0) or 0
            self.total_input_tokens += response.usage.input_tokens
            self.total_cache_read_tokens += cache_read
            self.total_cache_creation_tokens += cache_creation
            self.total_output_tokens += response.usage.output_tokens
            # Estimate next-turn context size for the compaction gauge: the full
            # prompt we just sent (input + cache_read + cache_creation) plus the
            # output we just generated, which becomes part of the next request.
            self.last_input_token_count = (
                response.usage.input_tokens + cache_read + cache_creation + response.usage.output_tokens
            )

            tool_uses = [b for b in response.content if b.type == "tool_use"]

            self._anthropic_messages.append({
                "role": "assistant",
                "content": [self._block_to_dict(b) for b in response.content],
            })

            if not tool_uses:
                if not self.is_sub_agent:
                    print_cost(self.total_input_tokens, self.total_output_tokens, self.total_cache_read_tokens, self.total_cache_creation_tokens)
                break

            self.current_turns += 1
            budget = self._check_budget()
            if budget["exceeded"]:
                print_info(f"Budget exceeded: {budget['reason']}")
                # Every tool_use needs a paired tool_result or the message
                # history is invalid for the next API call. Pair each pending
                # call with a refusal instead of silently dropping it.
                for task in early_executions.values():
                    task.cancel()
                self._anthropic_messages.append({"role": "user", "content": [
                    {"type": "tool_result", "tool_use_id": tu.id,
                     "content": f"Tool call not executed: {budget['reason']}"}
                    for tu in tool_uses
                ]})
                break

            # Process tools: early-started ones (from streaming) just await
            # their result; others go through permission check + execution.
            tool_results: list[dict] = []
            context_break = False
            for tu in tool_uses:
                if context_break or self._aborted:
                    break
                inp = dict(tu.input) if hasattr(tu.input, 'items') else tu.input
                print_tool_call(tu.name, inp)

                # Was this tool already started during streaming?
                early_task = early_executions.get(tu.id)
                if early_task:
                    raw = await early_task
                    res = self._persist_large_result(tu.name, raw)
                    print_tool_result(tu.name, res)
                    tool_results.append({"type": "tool_result", "tool_use_id": tu.id, "content": res})
                    continue

                # Permission check for tools not started early. Auto Mode routes
                # through the transcript classifier; other modes use static rules.
                if self.permission_mode == "auto":
                    perm = await self._classify_tool_call(tu.name, inp)
                else:
                    perm = check_permission(tu.name, inp, self.permission_mode, self._plan_file_path)
                if perm["action"] == "deny":
                    print_info(f"Denied: {perm.get('message', '')}")
                    tool_results.append({"type": "tool_result", "tool_use_id": tu.id, "content": f"Action denied: {perm.get('message', '')}"})
                    continue
                if perm["action"] == "confirm" and perm.get("message"):
                    # Auto Mode confirms carry a reason, not a path — never cache
                    # them, or one approval would whitelist every later action
                    # with the same reason.
                    cacheable = self.permission_mode != "auto"
                    if not cacheable or perm["message"] not in self._confirmed_paths:
                        confirmed = await self._confirm_dangerous(perm["message"])
                        if not confirmed:
                            tool_results.append({"type": "tool_result", "tool_use_id": tu.id, "content": "User denied this action."})
                            continue
                        if cacheable:
                            self._confirmed_paths.add(perm["message"])

                raw = await self._execute_tool_call(tu.name, inp)
                res = self._persist_large_result(tu.name, raw)
                print_tool_result(tu.name, res)

                if self._context_cleared:
                    self._context_cleared = False
                    # History was just cleared — route through the helper so the
                    # rebuilt context's first user message carries the reminder.
                    self._push_anthropic_user_message(res)
                    context_break = True
                    break
                tool_results.append({"type": "tool_result", "tool_use_id": tu.id, "content": res})

            if not context_break and tool_results:
                self._anthropic_messages.append({"role": "user", "content": tool_results})
            self._context_cleared = False

    @staticmethod
    def _block_to_dict(block) -> dict:
        """Convert an Anthropic content block to a plain dict for storage."""
        if block.type == "text":
            return {"type": "text", "text": block.text}
        if block.type == "tool_use":
            return {"type": "tool_use", "id": block.id, "name": block.name, "input": dict(block.input) if hasattr(block.input, 'items') else block.input}
        # Fallback
        return {"type": block.type}

    async def _call_anthropic_stream(self, on_tool_block_complete=None):
        """Stream an Anthropic API call. When a tool_use content block finishes
        during streaming, on_tool_block_complete fires immediately so the caller
        can start execution before the full response arrives (streaming tool
        execution -- inspired by Claude Code's content_block_stop streaming pattern)."""
        async def _do():
            max_output = _get_max_output_tokens(self.model)
            create_params: dict[str, Any] = {
                "model": self.model,
                "max_tokens": max_output if self._thinking_mode != "disabled" else 16384,
                "system": self._build_anthropic_system(),
                "tools": get_active_tool_definitions(self.tools),
                # Rolling message-array cache breakpoint, applied to a copy so
                # the persistent history stays free of cache_control metadata.
                "messages": self._with_cache_breakpoints(self._anthropic_messages),
            }

            if self._thinking_mode in ("adaptive", "enabled"):
                create_params["thinking"] = {"type": "enabled", "budget_tokens": max_output - 1}

            first_text = True
            # Track in-flight tool_use blocks by index for streaming execution
            tool_blocks_by_index: dict[int, dict] = {}

            async with self._anthropic_client.messages.stream(**create_params) as stream:
                async for event in stream:
                    if not hasattr(event, 'type'):
                        continue

                    if event.type == "content_block_start":
                        cb = getattr(event, 'content_block', None)
                        if cb and getattr(cb, 'type', None) == "tool_use":
                            tool_blocks_by_index[event.index] = {
                                "id": cb.id, "name": cb.name, "input_json": "",
                            }

                    elif event.type == "content_block_delta":
                        delta = event.delta
                        if hasattr(delta, 'text'):
                            if first_text:
                                stop_spinner()
                                self._emit_text("\n")
                                first_text = False
                            self._emit_text(delta.text)
                        elif hasattr(delta, 'thinking'):
                            if first_text:
                                stop_spinner()
                                self._emit_text("\n  [thinking] ")
                                first_text = False
                            self._emit_text(delta.thinking)
                        elif hasattr(delta, 'partial_json'):
                            tb = tool_blocks_by_index.get(event.index)
                            if tb:
                                tb["input_json"] += delta.partial_json

                    elif event.type == "content_block_stop":
                        tb = tool_blocks_by_index.pop(event.index, None)
                        if tb and on_tool_block_complete:
                            import json as _json
                            try:
                                parsed = _json.loads(tb["input_json"] or "{}")
                            except Exception:
                                parsed = {}
                            on_tool_block_complete({
                                "type": "tool_use", "id": tb["id"],
                                "name": tb["name"], "input": parsed,
                            })

                final_message = await stream.get_final_message()

            # Filter out thinking blocks
            final_message.content = [b for b in final_message.content if b.type != "thinking"]
            return final_message

        return await _with_retry(_do)

    # ─── OpenAI-compatible backend ───────────────────────────────

    async def _chat_openai(self, user_message: str) -> None:
        self._push_openai_user_message(user_message)
        # Auto-compact at turn boundary only — see _chat_anthropic for rationale.
        # The last message is now plain user text, so the slice in
        # _compact_openai won't orphan a tool_calls / tool message pair.
        await self._check_and_compact()

        # Memory prefetch: drain carry-over, then start fresh (issue #7)
        self._start_memory_prefetch_for_turn(user_message, self._openai_messages)

        while True:
            if self._aborted:
                break

            self._run_compression_pipeline()

            # Consume memory prefetch if settled (non-blocking poll, zero-wait)
            self._consume_memory_prefetch_if_ready(self._openai_messages)

            if not self.is_sub_agent:
                start_spinner()

            response = await self._call_openai_stream()

            if not self.is_sub_agent:
                stop_spinner()

            self.last_api_call_time = time.time()

            if response.get("usage"):
                # OpenAI-compatible providers cache prefixes automatically; the
                # cached portion is included in prompt_tokens, so split it out to
                # avoid double-counting. Clamp to [0, prompt_tokens] since
                # compatible gateways don't guarantee the field. NOTE: priced at
                # Anthropic's 0.1x for simplicity; actual cached rates vary by
                # provider (OpenAI ~0.5x, gateways vary), so the estimate may be
                # off in either direction.
                prompt = response["usage"]["prompt_tokens"] or 0
                cached_oa = min(max(response["usage"].get("cached_tokens", 0) or 0, 0), prompt)
                completion = response["usage"]["completion_tokens"]
                self.total_input_tokens += prompt - cached_oa
                self.total_cache_read_tokens += cached_oa
                self.total_output_tokens += completion
                # Estimate next-turn context size: this prompt + the output we
                # just generated (which becomes part of the next request).
                self.last_input_token_count = prompt + completion

            choice = response.get("choices", [{}])[0] if response.get("choices") else {}
            message = choice.get("message", {})

            self._openai_messages.append(message)

            tool_calls = message.get("tool_calls")
            if not tool_calls:
                if not self.is_sub_agent:
                    print_cost(self.total_input_tokens, self.total_output_tokens, self.total_cache_read_tokens, self.total_cache_creation_tokens)
                break

            self.current_turns += 1
            budget = self._check_budget()
            if budget["exceeded"]:
                print_info(f"Budget exceeded: {budget['reason']}")
                # Same pairing requirement as the Anthropic path: every
                # tool_call needs a role="tool" response.
                for tc in tool_calls:
                    if tc.get("id"):
                        self._openai_messages.append({
                            "role": "tool",
                            "tool_call_id": tc["id"],
                            "content": f"Tool call not executed: {budget['reason']}",
                        })
                break

            # Phase 1: Parse & permission-check (serial)
            oai_checked: list[dict] = []
            for tc in tool_calls:
                if self._aborted:
                    break
                if tc.get("type") != "function":
                    continue
                fn_name = tc["function"]["name"]
                try:
                    inp = json.loads(tc["function"]["arguments"])
                except Exception:
                    inp = {}

                print_tool_call(fn_name, inp)

                if self.permission_mode == "auto":
                    perm = await self._classify_tool_call(fn_name, inp)
                else:
                    perm = check_permission(fn_name, inp, self.permission_mode, self._plan_file_path)
                if perm["action"] == "deny":
                    print_info(f"Denied: {perm.get('message', '')}")
                    oai_checked.append({"tc": tc, "fn": fn_name, "inp": inp, "allowed": False, "result": f"Action denied: {perm.get('message', '')}"})
                    continue
                if perm["action"] == "confirm" and perm.get("message"):
                    # Auto Mode confirms carry a reason, not a path — never cache
                    # them, or one approval would whitelist every later action
                    # with the same reason.
                    cacheable = self.permission_mode != "auto"
                    if not cacheable or perm["message"] not in self._confirmed_paths:
                        confirmed = await self._confirm_dangerous(perm["message"])
                        if not confirmed:
                            oai_checked.append({"tc": tc, "fn": fn_name, "inp": inp, "allowed": False, "result": "User denied this action."})
                            continue
                        if cacheable:
                            self._confirmed_paths.add(perm["message"])
                oai_checked.append({"tc": tc, "fn": fn_name, "inp": inp, "allowed": True})

            # Phase 2: Group & execute (parallel for consecutive safe tools)
            oai_batches: list[dict] = []
            for ct in oai_checked:
                safe = ct["allowed"] and ct["fn"] in CONCURRENCY_SAFE_TOOLS
                if safe and oai_batches and oai_batches[-1]["concurrent"]:
                    oai_batches[-1]["items"].append(ct)
                else:
                    oai_batches.append({"concurrent": safe, "items": [ct]})

            oai_context_break = False
            for batch in oai_batches:
                if oai_context_break or self._aborted:
                    break

                if batch["concurrent"]:
                    async def _run_oai_safe(ct_item: dict) -> tuple[dict, str]:
                        raw = await self._execute_tool_call(ct_item["fn"], ct_item["inp"])
                        res = self._persist_large_result(ct_item["fn"], raw)
                        print_tool_result(ct_item["fn"], res)
                        return ct_item, res

                    results = await asyncio.gather(*[_run_oai_safe(ct) for ct in batch["items"]])
                    for ct_item, res in results:
                        self._openai_messages.append({"role": "tool", "tool_call_id": ct_item["tc"]["id"], "content": res})
                else:
                    for ct in batch["items"]:
                        if not ct["allowed"]:
                            self._openai_messages.append({"role": "tool", "tool_call_id": ct["tc"]["id"], "content": ct["result"]})
                            continue
                        raw = await self._execute_tool_call(ct["fn"], ct["inp"])
                        res = self._persist_large_result(ct["fn"], raw)
                        print_tool_result(ct["fn"], res)

                        if self._context_cleared:
                            self._context_cleared = False
                            # History was just cleared — route through the helper
                            # so the first user message carries the reminder.
                            self._push_openai_user_message(res)
                            oai_context_break = True
                            break
                        self._openai_messages.append({"role": "tool", "tool_call_id": ct["tc"]["id"], "content": res})

            self._context_cleared = False

    async def _call_openai_stream(self) -> dict:
        async def _do():
            stream = await self._openai_client.chat.completions.create(
                model=self.model,
                max_tokens=16384,
                tools=_to_openai_tools(get_active_tool_definitions(self.tools)),
                messages=self._openai_messages,
                stream=True,
                stream_options={"include_usage": True},
            )

            content = ""
            first_text = True
            tool_calls: dict[int, dict] = {}
            finish_reason = ""
            usage = None

            async for chunk in stream:
                if chunk.usage:
                    details = getattr(chunk.usage, "prompt_tokens_details", None)
                    usage = {
                        "prompt_tokens": chunk.usage.prompt_tokens,
                        "completion_tokens": chunk.usage.completion_tokens,
                        "cached_tokens": getattr(details, "cached_tokens", 0) or 0,
                    }

                if not chunk.choices:
                    continue
                delta = chunk.choices[0].delta

                if delta and delta.content:
                    if first_text:
                        stop_spinner()
                        self._emit_text("\n")
                        first_text = False
                    self._emit_text(delta.content)
                    content += delta.content

                if delta and delta.tool_calls:
                    for tc in delta.tool_calls:
                        existing = tool_calls.get(tc.index)
                        if existing:
                            if tc.function and tc.function.arguments:
                                existing["arguments"] += tc.function.arguments
                        else:
                            tool_calls[tc.index] = {
                                "id": tc.id or "",
                                "name": (tc.function.name if tc.function else "") or "",
                                "arguments": (tc.function.arguments if tc.function else "") or "",
                            }

                if chunk.choices[0].finish_reason:
                    finish_reason = chunk.choices[0].finish_reason

            assembled = None
            if tool_calls:
                assembled = [
                    {"id": tc["id"], "type": "function", "function": {"name": tc["name"], "arguments": tc["arguments"]}}
                    for _, tc in sorted(tool_calls.items())
                ]

            return {
                "choices": [{
                    "message": {
                        "role": "assistant",
                        "content": content or None,
                        "tool_calls": assembled,
                    },
                    "finish_reason": finish_reason or "stop",
                }],
                "usage": usage or {"prompt_tokens": 0, "completion_tokens": 0},
            }

        return await _with_retry(_do)

    # ─── Shared ──────────────────────────────────────────────────

    async def _confirm_dangerous(self, command: str) -> bool:
        print_confirmation(command)
        if self.confirm_fn:
            return await self.confirm_fn(command)
        # Fallback: blocking input
        try:
            answer = input("  Allow? (y/n): ")
            return answer.lower().startswith("y")
        except EOFError:
            return False
