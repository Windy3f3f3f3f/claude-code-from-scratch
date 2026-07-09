// Deterministic mock LLM backend for integration tests — DUAL endpoint. It
// implements just enough of BOTH wire formats for the real mini-claude CLI to
// run end-to-end with no network:
//   - OpenAI-compatible  POST /chat/completions   (OPENAI_BASE_URL points here)
//   - Anthropic Messages POST /v1/messages        (ANTHROPIC_BASE_URL points here)
// The SAME scripted queues drive both, so one scenario script tests both
// backends. Requests are categorized and served from independent queues, so the
// classifier / goal-evaluator / memory side-queries (which interleave with main
// turns) each draw from their own list and stay in sync:
//
//   - stream:true  -> a MAIN agent turn -> `main` queue (SSE, per backend format)
//   - stream:false -> a side query (non-streaming JSON):
//       system contains "evaluating a hook condition"     -> `evaluator`
//       system contains "security monitor for autonomous" -> `classifier`
//       otherwise (e.g. memory recall)                     -> neutral empty.
//
// Script file (path in env MOCK_LLM_SCRIPT) shape:
//   { "main": [ {content?, tool_calls?:[{name,arguments,splitArgsAt?}]} , ... ],
//     "classifier": [ "<block>no</block>", ... ],
//     "evaluator":  [ "{\"ok\":true,\"reason\":\"x\"}", ... ],
//     "status": [ 429, 200, ... ]  // optional: HTTP status per main request (retry tests) }
// Each category advances its own cursor; running past the end yields a safe
// default AND flags exhausted:true (the harness fails on it, so an empty
// fallback can't create a false-green). Every served item is logged to
// MOCK_LLM_LOG (if set), tagged with the backend, for assertions.
import http from "node:http";
import { readFileSync, appendFileSync } from "node:fs";

const scriptPath = process.env.MOCK_LLM_SCRIPT;
const logPath = process.env.MOCK_LLM_LOG;
const script = scriptPath ? JSON.parse(readFileSync(scriptPath, "utf8")) : {};
const cursors = { main: 0, classifier: 0, evaluator: 0, memory: 0 };
let mainRequests = 0; // counts every main request (incl. retried) for the status queue

function logServed(backend, category, req, served, exhausted = false, extra = {}) {
  if (!logPath) return;
  try {
    appendFileSync(logPath, JSON.stringify({ backend, category, served, exhausted, lastUser: lastUserText(req), toolResults: extractToolResults(req), ...extra }) + "\n");
  } catch { /* ignore */ }
}

// The tool results the CLI fed back from the PREVIOUS turn, so a test can assert
// the real tool output reached the model (not just that a scripted final content
// mentioned the value). OpenAI: role:"tool" messages. Anthropic: user messages
// with tool_result content blocks.
function extractToolResults(body) {
  const out = [];
  for (const m of body.messages || []) {
    if (m.role === "tool") out.push(contentToText(m.content));
    else if (m.role === "user" && Array.isArray(m.content)) {
      for (const b of m.content) if (b && b.type === "tool_result") out.push(contentToText(b.content));
    }
  }
  return out;
}

// Flatten a message content that may be a string or an array of blocks
// (OpenAI: string; Anthropic: array of {type,text|content|...}).
function contentToText(c) {
  if (typeof c === "string") return c;
  if (Array.isArray(c)) return c.map((b) => (typeof b === "string" ? b : b.text ?? b.content ?? JSON.stringify(b))).join(" ");
  return c == null ? "" : JSON.stringify(c);
}
function lastUserText(body) {
  const msgs = body.messages || [];
  for (let i = msgs.length - 1; i >= 0; i--) {
    if (msgs[i].role === "user") return contentToText(msgs[i].content);
  }
  return "";
}
// System text: OpenAI puts it in system-role messages; Anthropic in top-level `system`.
function systemText(body) {
  const fromMsgs = (body.messages || []).filter((m) => m.role === "system").map((m) => contentToText(m.content)).join("\n");
  let fromTop = "";
  if (typeof body.system === "string") fromTop = body.system;
  else if (Array.isArray(body.system)) fromTop = body.system.map((b) => b.text ?? "").join("\n");
  return `${fromTop}\n${fromMsgs}`;
}
function categorize(body) {
  if (body.stream) return "main";
  const sys = systemText(body);
  if (/evaluating a hook condition/i.test(sys)) return "evaluator";
  if (/security monitor for autonomous/i.test(sys)) return "classifier";
  return "memory";
}
// Returns { value, exhausted }.
function nextFrom(category) {
  const list = script[category] || [];
  const i = cursors[category]++;
  if (i < list.length) return { value: list[i], exhausted: false };
  return { value: undefined, exhausted: true };
}
// Optional per-main-request HTTP status (retry tests). `statusAlways` forces
// every main request to a status (for exhaustion/hard-error tests, since the SDK
// retries internally and would otherwise chew through a finite `status` queue).
// Otherwise `status[i]` per main request, defaulting to 200.
function mainStatus() {
  if (script.statusAlways != null) return script.statusAlways;
  const list = script.status || [];
  const i = mainRequests; // 0-based over all main requests
  return i < list.length ? list[i] : 200;
}

const created = 1720000000; // fixed (Date.now unavailable / determinism)
let idCounter = 0;
const nextId = (p = "chatcmpl-mock") => `${p}-${idCounter++}`;

// ─────────────────────────── OpenAI wire ───────────────────────────
function openaiCompletionJSON(model, content) {
  return {
    id: nextId(), object: "chat.completion", created, model,
    choices: [{ index: 0, message: { role: "assistant", content: content ?? "" }, finish_reason: "stop" }],
    usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
  };
}
const oaiChunk = (obj) => `data: ${JSON.stringify(obj)}\n\n`;
function argSlices(argStr, cuts) {
  const bounds = [0, ...(Array.isArray(cuts) ? cuts : []).filter((n) => n > 0 && n < argStr.length), argStr.length];
  const slices = [];
  for (let k = 0; k < bounds.length - 1; k++) slices.push(argStr.slice(bounds[k], bounds[k + 1]));
  return slices;
}
function openaiStreamMain(res, model, spec) {
  res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache", Connection: "keep-alive" });
  const id = nextId();
  const base = (choices) => ({ id, object: "chat.completion.chunk", created, model, choices });
  const content = spec?.content ?? "";
  const toolCalls = spec?.tool_calls ?? [];
  res.write(oaiChunk(base([{ index: 0, delta: content ? { role: "assistant", content } : { role: "assistant" }, finish_reason: null }])));
  toolCalls.forEach((tc, index) => {
    const argStr = JSON.stringify(tc.arguments ?? {});
    argSlices(argStr, tc.splitArgsAt).forEach((slice, si) => {
      res.write(oaiChunk(base([{ index: 0, delta: { tool_calls: [si === 0
        ? { index, id: tc.id || `call_mock_${index}`, type: "function", function: { name: tc.name, arguments: slice } }
        : { index, function: { arguments: slice } }] }, finish_reason: null }])));
    });
  });
  res.write(oaiChunk(base([{ index: 0, delta: {}, finish_reason: toolCalls.length ? "tool_calls" : "stop" }])));
  res.write(oaiChunk({ id, object: "chat.completion.chunk", created, model, choices: [], usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 } }));
  res.write("data: [DONE]\n\n");
  res.end();
}

// ─────────────────────────── Anthropic wire ───────────────────────────
function anthropicMsgFromSpec(model, spec) {
  const content = [];
  if (spec?.content) content.push({ type: "text", text: spec.content });
  (spec?.tool_calls ?? []).forEach((tc, j) => {
    content.push({ type: "tool_use", id: tc.id || `toolu_mock_${j}`, name: tc.name, input: tc.arguments ?? {} });
  });
  const stop_reason = (spec?.tool_calls?.length) ? "tool_use" : "end_turn";
  return { id: nextId("msg_mock"), type: "message", role: "assistant", model, content, stop_reason, stop_sequence: null, usage: { input_tokens: 10, output_tokens: 5 } };
}
const antSse = (res, event, data) => res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
function anthropicStreamMain(res, model, spec) {
  res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache", Connection: "keep-alive" });
  const msg = anthropicMsgFromSpec(model, spec);
  antSse(res, "message_start", { type: "message_start", message: { ...msg, content: [], stop_reason: null, usage: { ...msg.usage, output_tokens: 0 } } });
  msg.content.forEach((block, i) => {
    if (block.type === "text") {
      antSse(res, "content_block_start", { type: "content_block_start", index: i, content_block: { type: "text", text: "" } });
      const chunks = block.text.match(/.{1,24}(\s|$)|.+$/g) || [block.text];
      for (const c of chunks) antSse(res, "content_block_delta", { type: "content_block_delta", index: i, delta: { type: "text_delta", text: c } });
      antSse(res, "content_block_stop", { type: "content_block_stop", index: i });
    } else {
      antSse(res, "content_block_start", { type: "content_block_start", index: i, content_block: { type: "tool_use", id: block.id, name: block.name, input: {} } });
      // stream the input JSON, optionally split across chunks (splitArgsAt on the source spec)
      const src = (spec.tool_calls || []).find((t) => (t.id || "").length >= 0 && t.name === block.name) || {};
      const argStr = JSON.stringify(block.input);
      argSlices(argStr, src.splitArgsAt).forEach((slice) =>
        antSse(res, "content_block_delta", { type: "content_block_delta", index: i, delta: { type: "input_json_delta", partial_json: slice } }));
      antSse(res, "content_block_stop", { type: "content_block_stop", index: i });
    }
  });
  antSse(res, "message_delta", { type: "message_delta", delta: { stop_reason: msg.stop_reason, stop_sequence: null }, usage: { output_tokens: msg.usage.output_tokens } });
  antSse(res, "message_stop", { type: "message_stop" });
  res.end();
}
function anthropicSideJSON(res, model, content) {
  res.writeHead(200, { "Content-Type": "application/json" });
  res.end(JSON.stringify({
    id: nextId("msg_mock"), type: "message", role: "assistant", model,
    content: [{ type: "text", text: content ?? "" }],
    stop_reason: "end_turn", stop_sequence: null, usage: { input_tokens: 10, output_tokens: 5 },
  }));
}

// ─────────────────────────── server ───────────────────────────
const server = http.createServer((req, res) => {
  const isAnthropic = req.url.includes("/v1/messages");
  const isOpenAI = req.url.includes("/chat/completions");
  if (req.method !== "POST" || (!isAnthropic && !isOpenAI)) { res.writeHead(404).end("not found"); return; }
  let raw = "";
  req.on("data", (c) => { raw += c; });
  req.on("end", () => {
    let body = {};
    try { body = JSON.parse(raw); } catch { /* keep {} */ }
    const model = body.model || "mock-model";
    const backend = isAnthropic ? "anthropic" : "openai";
    const category = categorize(body);

    if (category === "main") {
      const status = mainStatus();
      mainRequests++;
      if (status !== 200) {
        // Error status (retry / hard-error tests): don't consume the main queue; log it.
        logServed(backend, "main", body, { httpStatus: status }, false, { httpStatus: status });
        const etype = status === 429 ? "rate_limit_error" : status >= 500 ? "api_error" : "invalid_request_error";
        // Anthropic shape: {type:"error",error:{...}}; OpenAI shape: {error:{...}}.
        const errBody = isAnthropic
          ? { type: "error", error: { type: etype, message: `mock injected ${status}` } }
          : { error: { type: etype, message: `mock injected ${status}`, code: null } };
        res.writeHead(status, { "Content-Type": "application/json" });
        res.end(JSON.stringify(errBody));
        return;
      }
      const { value, exhausted } = nextFrom("main");
      const spec = value ?? { content: "__MOCK_EXHAUSTED_main__" };
      logServed(backend, "main", body, spec, exhausted);
      if (isAnthropic) anthropicStreamMain(res, model, spec);
      else openaiStreamMain(res, model, spec);
      return;
    }
    // Side queries: non-streaming JSON, per backend envelope.
    let content = "", exhausted = false;
    if (category === "evaluator" || category === "classifier") {
      const r = nextFrom(category);
      content = r.value ?? "__MOCK_EXHAUSTED__";
      exhausted = r.exhausted;
    } // memory / other -> neutral empty (does not consume a queue)
    logServed(backend, category, body, content, exhausted);
    if (isAnthropic) anthropicSideJSON(res, model, content);
    else { res.writeHead(200, { "Content-Type": "application/json" }); res.end(JSON.stringify(openaiCompletionJSON(model, content))); }
  });
});

const port = Number(process.env.MOCK_LLM_PORT || 0);
server.listen(port, "127.0.0.1", () => {
  console.log(`MOCK_LLM_LISTENING ${server.address().port}`);
});
