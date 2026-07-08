# Runnable Steps — Design

How this repo turns the tutorial into a **from-scratch build you can run at every
chapter**. This document is the blueprint; it was reviewed by an independent
model (Codex, Gate 0) and incorporates that review.

## 1. Goal & principles

A reader should feel they are *building* a coding agent, one runnable step at a
time — not reading a finished codebase. Concretely:

1. **No-key first run.** The first command in every chapter runs against a local
   mock model — `npm install` is the only setup. Feeling the thing work must not
   require an API key. Real models are an optional `--live` smoke, never the main
   path. (nanoGPT's "feel the magic" quick start.)
2. **Diff-first narrative.** A chapter reads: *run the previous step and watch it
   fail or fall short → here is the small diff this chapter adds → run this step
   and watch the new behavior.* The full snapshot is an entrypoint at the end,
   not the opening. The "I built this" feeling comes from the diff + observed
   change, which single-source slicing alone does **not** produce.
3. **One source, everything generated.** `steps/canonical/` is the only hand-
   written code. Per-chapter snapshots, the code blocks in the docs, and the
   example transcripts are all generated from it. Change canonical → regenerate →
   CI `git diff --exit-code` blocks any drift.
4. **Every step runs, proven by CI with no key.** Each step, in both languages,
   compiles/imports and passes a scripted scenario against the mock — asserting
   machine-observable events (tool calls, side-effect files, control flow), never
   the model's natural language.
5. **Seams, not rewrites.** New capabilities enter at a small set of named
   integration points (§3). A chapter that needs a seam introduces it as that
   chapter's explicit refactor — we do not pre-stub empty hooks, and we do not
   pretend the loop never changes.
6. **Small enough to read; mirrored in two languages.** Each step's core files
   are tens of lines, single-backend (Anthropic only). TS and Python are kept
   behaviorally identical, enforced by a parity check on a normalized event log.

Production `src/` and `python/mini_claude/` stay untouched as the *fuller*
reference; ch13 compares three tiers: your final step → this repo's production
version → real Claude Code.

## 2. Layout

```
steps/
  canonical/{ts,py}/     # ONLY hand-written source. #step (slice) + #region (doc) markers.
  scenarios/*.json       # shared scripted model behavior — used by test, run --demo, @transcript
  build.mjs              # canonical --slice--> dist/<step>/{ts,py}  (self-contained snapshots)
  run.mjs                # run a step: --demo (default, no key) | --live | --diff | --list | --py | -- <prompt>
  mock-anthropic.mjs     # local server speaking the real Anthropic /v1/messages (+SSE) protocol
  mock-anthropic.selftest.mjs  # proves the real TS & Python SDKs work against the mock
  docs-sync.mjs          # inject @snippet / @diff / @transcript into docs/ & en/docs/ ; lint ; normalize
  test.mjs               # every step × {ts,py} × scenario: compile/import + assert + parity
  lint-markers.mjs       # validate #step / #region / @snippet integrity
  DESIGN.md              # this file
  dist/                  # generated, gitignored
```

## 3. Seam matrix (the named integration points)

The agent is written so capabilities attach at these seams. A chapter's diff is
"introduce/extend seam X". This keeps the loop legible and bounds the marker
churn. Seams are added at the chapter that first needs them (not upfront):

| Seam | First chapter | What plugs in later |
|------|---------------|---------------------|
| `callModel(req)` | 1 | ch5 swaps `messages.create` → `messages.stream` |
| `toolRegistry` | 2 | ch9 skill / ch11 agent / ch12 mcp add tools |
| `executeToolCall(name,input)` | 2 | ch6 wraps it with `permissionGate` |
| `buildRequest()` (system+tools+messages) | 3 | ch3 system prompt; ch8 memory injection |
| `slashCommand(input)` | 4 | ch7 `/compact`, ch9 `/skill`, ch10 `/plan`, ch15 `/goal` `/loop` |
| `sessionStore` | 4 | save/resume |
| `permissionGate(call)` | 6 | ch10 plan-mode read-only, ch15 auto classifier |
| `beforeTurn()` / `afterAssistant()` | 7 | ch7 compaction at turn boundary; ch8 memory prefetch |
| `sideQuery(system,messages)` | 15 | one-shot sub-call: goal evaluator, auto classifier |

Codex Gate 0 correction: the earlier claim "loop only changes at ch5/ch6" was
wrong — context (turn-boundary tool_use/tool_result pairing), memory (inject
around the model call), tool routing (mcp/subagent/skill), and plan mode all
touch the core. Naming the seams up front is how we keep those changes small and
predictable instead of ad-hoc rewrites.

## 4. Chapter → step map

13 code steps (ch1-12 + ch15); ch13/14 are doc-only.

| Ch | Step | New (prefer a new file) | No-key demo asserts (observable event) |
|----|------|-------------------------|----------------------------------------|
| 1 | 1 | `agent.ts`(**non-streaming** loop)+`tools.ts`(read_file)+`cli.ts` | reads a file → `read_file` call in event log |
| 2 | 2 | `tools.ts` grows to 6 tools | writes a file → file exists on disk |
| 3 | 3 | +`prompt.ts`; `buildRequest` uses it | `--trace-request` shows the system prompt block |
| 4 | 4 | `cli.ts`: arg parse + `sessionStore` + `/clear` etc | resume a saved session → prior message reloaded |
| 5 | 5 | `callModel`: `create`→`stream` (only change) | `--trace-stream` shows >1 text chunk over time |
| 6 | 6 | +`permissions.ts`; `permissionGate` wraps executeToolCall | `rm -rf` is denied → deny event, no side effect |
| 7 | 7 | +`context.ts`; `beforeTurn` compaction; `/compact` | mock forces high usage → message count drops / summary event |
| 8 | 8 | +`memory.ts`; deterministic top-k recall injected in `buildRequest` | new session → memory file read + injection event (no extra model call) |
| 9 | 9 | +`skills.ts`; `/name` → registry | `/commit` → skill prompt injected event |
| 10 | 10 | +`plan.ts`; `--plan`/`/plan` via permissionGate | plan mode → write tool denied event |
| 11 | 11 | +`subagent.ts`; `agent` tool | `agent(explore)` → sub-agent event + isolated tools |
| 12 | 12 | +`mcp.ts` (stdio JSON-RPC, version-negotiated) | event log shows `initialize` / `tools/list` / `tools/call` |
| 13 | — | doc-only | three-tier comparison |
| 14 | — | doc-only | walks through steps/test.mjs (same harness that tests the book) |
| 15 | 13 | +`autonomy.ts`; `sideQuery`; `/goal` `/loop` `--auto` | goal: evaluator verdict + 2nd-turn reinjection in event log |

Decisions locked by Gate 0:
- **ch1-4 are non-streaming** (`messages.create`). ch5 is the "swap the call shape"
  chapter. (The pilot currently streams from ch1 — Phase A fixes this.) Dual
  backend is *not* in the teaching trunk; it stays a production-only feature.
- **ch8 recall is deterministic** (keyword/index top-k, no model call). `sideQuery`
  is introduced later, at ch15, and reused by the auto classifier.
- **ch12 MCP** teaches stdio only; the mock MCP server negotiates protocol
  version; docs do not hardcode a dated version as "current".

## 5. Markers + linter

- **Slice** `#step`: `//#step >=N | ==N | <=N | <N | >N` (TS), `#step …` (Py),
  closed by `//#endstep` / `#endstep`. Consecutive `#step` before an end = if/elif
  (first matching branch wins). Implemented in `build.mjs`.
- **Doc region** `#region NAME` … `#endregion`: names a span for the docs. The
  region is extracted from the **sliced** file for a given step, so a doc snippet
  always equals code that really exists in that chapter's snapshot.
- **`lint-markers.mjs`** fails the build on: unbalanced markers, unknown region
  referenced by a `@snippet`, empty region, duplicate region name in one file,
  a `@snippet`/`@diff`/`@transcript` whose target step/region doesn't exist.

## 6. Scenarios + mock + event log

- **`steps/scenarios/*.json`** is the single source of scripted model behavior. A
  scenario is an ordered list of assistant turns keyed by which step it targets;
  each turn is either `{text}` or `{tool_use:[{name,input}], then...}`. `test.mjs`,
  `run --demo`, and `@transcript` all read the same scenario — no third copy to
  drift. (Gate 0 P2.)
- **`mock-anthropic.mjs`** is a local HTTP server implementing the real Anthropic
  `POST /v1/messages` — both `create` and SSE `stream`, returning `tool_use`
  blocks, `usage`, and error shapes. The agent code is **unmodified**; only
  `ANTHROPIC_BASE_URL` points at it, so there is no `if (test)` branch in the
  teaching code. On queue exhaustion it returns an error and the run **fails**
  (never a false green). It emits an **event log** (JSONL): every request
  (system, tools, messages), every tool_use it issued, and usage — the machine-
  observable substrate for assertions and transcripts.
- **`mock-anthropic.selftest.mjs`** (built first): the real TS SDK and the real
  Python SDK each hit the mock for create / stream / tool_use / usage / error and
  must succeed. This proves protocol fidelity before any step depends on it.

## 7. test.mjs

For each step × {ts, py}:
1. compile (tsc) / import (py) — must pass, **no skips** (Gate 0: the existing
   parity-skip logic is not reused; a missing Python env fails CI, it does not
   pass vacuously).
2. run the step's scenario against the mock; assert the **normalized event log**:
   requests issued, tool calls + inputs, side-effect files, exit code. Natural-
   language output is only matched by `contains`/regex.
3. **parity**: TS and Python produce the same normalized event log for the same
   scenario.
Deterministic, no API key → runs in CI.

## 8. docs-sync.mjs

Markdown carries HTML-comment placeholders; the script fills between them,
idempotently, and CI runs `git diff --exit-code` to catch drift.

- `@snippet lang=ts file=agent.ts region=loop step=2` → the region, sliced at that
  step.
- `@diff step=N file=agent.ts` → the unified diff of file between step N-1 and N
  (the chapter's change, in the main narrative — Gate 0 P0).
- `@transcript scenario=read-a-file step=1 lang=ts` → the **real** stdout of
  running that step against the mock, captured in a **fixed temp workspace**
  (normalized paths, no real dates, ANSI stripped — Gate 0 P1) so it is stable.
- Hardening: empty snippet fails, duplicate/unknown region fails, unsynced doc
  fails, path/time/ANSI normalization.

## 9. run.mjs

- `node steps/run.mjs <N>` → **default `--demo`**: starts the mock, sets a dummy
  key, isolates a temp cwd/HOME, runs the step's demo scenario. No key needed.
- `--live` → real API via `.env` (proxy stripped); optional smoke.
- `--diff` → what this chapter added vs the previous (also available as `@diff` in
  docs).
- `--list` → steps + one-line capabilities. `--py` → Python. `-- "<prompt>"` →
  one-shot (live) or drive the demo.

## 10. Execution: per-step closed loop (Gate 0 P1)

After the ch1-3 template is set, **each chapter is a full vertical loop** before
moving on (codecrafters "one stage at a time"): canonical slice (both langs) →
mock test green → doc `@snippet`+`@diff`+`@transcript` (zh+en) → `--diff` self-
check → read the chapter through. Not "all code, then all docs".

## 11. Phases & Codex gates

- **Gate 0 (plan)** — done; this doc incorporates it.
- **Phase A — foundations**: seam matrix; `lint-markers.mjs`; `mock-anthropic.mjs`
  + selftest (real TS+Py SDK); `scenarios/`; `test.mjs`; `run.mjs` `--demo`
  default + `--diff`/`--list`; revise pilot ch1-3 to **non-streaming** + add
  `#region` + demo scenarios; ch1-3 mock-test green + representative `--live`
  smoke. → **Gate 1** (foundations architecture, mock fidelity, no test-hooks in
  teaching code, seam matrix).
- **Phase B — doc/code loop on ch1-3**: `docs-sync.mjs`; wire ch1-3 zh+en docs
  (@snippet/@diff/@transcript + ▶run); drift check green; read all four. →
  **Gate 2** (doc-code sync + ch1-3 as the whole-book template: readability &
  usefulness).
- **Phase C/D merged — per-chapter closed loop** for ch4→ch12→ch15, each: code +
  mock test + docs + transcript + diff + read-through, batched commits. →
  **Gate 3** (mid: code-step quality, parity, demos observable) and **Gate 4**
  (full-book doc consistency, from-scratch feel, facts).
- **Phase E — final**: full mock test suite green (both langs); representative
  `--live` smoke; docs-sync drift check; readable-writing blockers=0 all zh;
  read every zh+en chapter end-to-end; → **Gate 5 (final)** → push.

Each gate: `/cross-review` or `ask-codex.sh` (gpt-5.5 xhigh, web), triage P0/P1,
record in progress notes.

## 12. Goal DoD (revised per Gate 0)

1. canonical covers ch1-12 + ch15 in TS+Python; build/run (`--demo` default,
   `--live`, `--diff`, `--list`, `--py`, one-shot) work.
2. `mock-anthropic` + `test.mjs`: every step × both languages green with **no API
   key** (assert event log + parity, no skips). `--live` smoke on a
   representative 3-4 steps recorded (date/model), **non-blocking**.
3. every code chapter's docs/ + en/docs/ code blocks generated from canonical
   (no hand-copied), with `@diff` in the narrative, a ▶run entry, and a captured
   `@transcript`; `git diff --exit-code` drift check green.
4. all zh chapters readable-writing blockers=0; every chapter zh+en read end-to-
   end for readability/usefulness, issues fixed.
5. 5 Codex gates passed, P0/P1 resolved.
6. committed in phases; pushed to GitHub.

## 13. Risks

- **Canonical marker churn** → seam matrix + `lint-markers` + mock-test each step
  immediately; favor new files.
- **Mock false-green / SDK mismatch** → selftest with real SDKs first; queue
  exhaustion fails; no skips.
- **Doc migration volume** → per-chapter closed loop, templated on ch1-3; prose
  (already reframed) untouched, only code blocks swapped for placeholders.
- **Runway** → durable commit per chapter; ch1-3 vertical slice done first is a
  complete, usable deliverable; if incomplete, report done-vs-remaining and push
  what's verified.
- **Live key** → inferera key works now; CI never depends on it.
