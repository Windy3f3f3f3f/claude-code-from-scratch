// Deterministic mock LLM backend for integration tests. Implements just enough
// of the OpenAI-compatible /chat/completions API for the real mini-claude CLI to
// run end-to-end with no network: the CLI is launched with
// OPENAI_BASE_URL=http://127.0.0.1:<port> and OPENAI_API_KEY=test.
//
// Requests are categorized and served from independent scripted queues, so the
// classifier / goal-evaluator / memory side-queries (which interleave with main
// turns) each draw from their own list and stay in sync:
//
//   - stream:true  -> a MAIN agent turn (callOpenAIStream) -> `main` queue, SSE.
//   - stream:false -> a side query (non-streaming JSON):
//       system contains "evaluating a hook condition"          -> `evaluator`
//       system contains "security monitor for autonomous"      -> `classifier`
//       otherwise (e.g. memory recall)                         -> neutral empty.
//
// Script file (path in env MOCK_LLM_SCRIPT) shape:
//   { "main": [ {content?, tool_calls?:[{name,arguments}]} , ... ],
//     "classifier": [ "<block>no</block>", ... ],
//     "evaluator":  [ "{\"ok\":true,\"reason\":\"x\"}", ... ] }
// Each category advances its own cursor; running past the end yields a safe
// default (empty content) rather than erroring, and every served item is logged
// to MOCK_LLM_LOG (if set) for assertions about what the CLI actually requested.
import http from "node:http";
import { readFileSync, appendFileSync } from "node:fs";

const scriptPath = process.env.MOCK_LLM_SCRIPT;
const logPath = process.env.MOCK_LLM_LOG;
const script = scriptPath ? JSON.parse(readFileSync(scriptPath, "utf8")) : {};
const cursors = { main: 0, classifier: 0, evaluator: 0, memory: 0 };

function logServed(category, req, served, exhausted = false) {
  if (!logPath) return;
  try {
    appendFileSync(logPath, JSON.stringify({ category, served, exhausted, lastUser: lastUserText(req) }) + "\n");
  } catch { /* ignore */ }
}

function lastUserText(body) {
  const msgs = body.messages || [];
  for (let i = msgs.length - 1; i >= 0; i--) {
    if (msgs[i].role === "user") {
      const c = msgs[i].content;
      return typeof c === "string" ? c : JSON.stringify(c);
    }
  }
  return "";
}

function systemText(body) {
  const msgs = body.messages || [];
  return msgs.filter((m) => m.role === "system").map((m) => m.content).join("\n");
}

function categorize(body) {
  if (body.stream) return "main";
  const sys = systemText(body);
  if (/evaluating a hook condition/i.test(sys)) return "evaluator";
  if (/security monitor for autonomous/i.test(sys)) return "classifier";
  return "memory";
}

// Returns { value, exhausted }. exhausted:true means the request ran past the
// scripted queue — a signal that the test under-scripted, mis-routed, or the CLI
// made an unexpected extra call. The harness fails on it unless the test opted
// in (allowExhausted), so an empty fallback can't create a false-green.
function nextFrom(category) {
  const list = script[category] || [];
  const i = cursors[category]++;
  if (i < list.length) return { value: list[i], exhausted: false };
  return { value: undefined, exhausted: true };
}

const created = 1720000000; // fixed (Date.now unavailable / determinism)
let idCounter = 0;
const nextId = () => `chatcmpl-mock-${idCounter++}`;

function completionJSON(model, content) {
  return {
    id: nextId(), object: "chat.completion", created, model,
    choices: [{ index: 0, message: { role: "assistant", content: content ?? "" }, finish_reason: "stop" }],
    usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
  };
}

function sseChunk(obj) {
  return `data: ${JSON.stringify(obj)}\n\n`;
}

// Build the SSE stream for a main-turn spec {content?, tool_calls?}.
function streamMain(res, model, spec) {
  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
    Connection: "keep-alive",
  });
  const id = nextId();
  const base = (choices) => ({ id, object: "chat.completion.chunk", created, model, choices });
  const content = spec?.content ?? "";
  const toolCalls = spec?.tool_calls ?? [];

  if (content) {
    res.write(sseChunk(base([{ index: 0, delta: { role: "assistant", content }, finish_reason: null }])));
  } else {
    res.write(sseChunk(base([{ index: 0, delta: { role: "assistant" }, finish_reason: null }])));
  }
  toolCalls.forEach((tc, index) => {
    const argStr = JSON.stringify(tc.arguments ?? {});
    // splitArgsAt: [i, j, ...] streams the arguments string across multiple
    // chunks (same tool_call index), exercising the client's chunk-accumulation
    // path. The first chunk carries id + name; the rest carry argument slices.
    const cuts = Array.isArray(tc.splitArgsAt) ? tc.splitArgsAt : [];
    const bounds = [0, ...cuts.filter((n) => n > 0 && n < argStr.length), argStr.length];
    const slices = [];
    for (let k = 0; k < bounds.length - 1; k++) slices.push(argStr.slice(bounds[k], bounds[k + 1]));
    slices.forEach((slice, si) => {
      res.write(sseChunk(base([{
        index: 0,
        delta: {
          tool_calls: [si === 0
            ? { index, id: tc.id || `call_mock_${index}`, type: "function", function: { name: tc.name, arguments: slice } }
            : { index, function: { arguments: slice } }],
        },
        finish_reason: null,
      }])));
    });
  });
  res.write(sseChunk(base([{ index: 0, delta: {}, finish_reason: toolCalls.length ? "tool_calls" : "stop" }])));
  // Final usage-only chunk (stream_options.include_usage).
  res.write(sseChunk({ id, object: "chat.completion.chunk", created, model, choices: [], usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 } }));
  res.write("data: [DONE]\n\n");
  res.end();
}

const server = http.createServer((req, res) => {
  if (req.method !== "POST" || !req.url.includes("/chat/completions")) {
    res.writeHead(404).end("not found");
    return;
  }
  let raw = "";
  req.on("data", (c) => { raw += c; });
  req.on("end", () => {
    let body = {};
    try { body = JSON.parse(raw); } catch { /* keep {} */ }
    const model = body.model || "mock-model";
    const category = categorize(body);

    if (category === "main") {
      const { value, exhausted } = nextFrom("main");
      const spec = value ?? { content: "__MOCK_EXHAUSTED_main__" };
      logServed("main", body, spec, exhausted);
      streamMain(res, model, spec);
      return;
    }
    // Side queries are non-streaming JSON.
    let content = "", exhausted = false;
    if (category === "evaluator" || category === "classifier") {
      const r = nextFrom(category);
      content = r.value ?? "__MOCK_EXHAUSTED__";
      exhausted = r.exhausted;
    } // memory / other -> neutral empty (does not consume a queue)
    logServed(category, body, content, exhausted);
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify(completionJSON(model, content)));
  });
});

const port = Number(process.env.MOCK_LLM_PORT || 0);
server.listen(port, "127.0.0.1", () => {
  const addr = server.address();
  // Print the chosen port so the harness (or a human) can read it.
  console.log(`MOCK_LLM_LISTENING ${addr.port}`);
});
