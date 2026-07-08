// A local server that speaks the real Anthropic Messages API (POST /v1/messages,
// both blocking and SSE streaming) and replays a *scripted* scenario. The agent
// code is unmodified — only ANTHROPIC_BASE_URL points here — so there is no test
// branch in the teaching code.
//
// Which scripted turn to return is derived from the request itself: the number
// of assistant messages already in `messages` is the index of the next turn.
// That is stateless and matches however the client replays history.
//
// A scenario is { id, turns: [ turn, ... ] } where a turn is:
//   { "tools": [ { "name": "...", "input": {...} } ], "text": "optional preamble" }  -> stop_reason tool_use
//   { "text": "..." }                                                                 -> stop_reason end_turn
//   optional per-turn { "usage": { "input_tokens": N, "output_tokens": M } }
//
// Every request is appended to MOCK_LOG (JSONL) as an event the tests assert on.

import { createServer } from "http";
import { appendFileSync } from "fs";

function messageFromTurn(turn, model, reqIndex) {
  const content = [];
  if (turn.text && (turn.tools?.length)) content.push({ type: "text", text: turn.text });
  else if (turn.text) content.push({ type: "text", text: turn.text });
  (turn.tools || []).forEach((t, j) => {
    content.push({ type: "tool_use", id: `toolu_mock_${reqIndex}_${j}`, name: t.name, input: t.input ?? {} });
  });
  const stop_reason = turn.tools?.length ? "tool_use" : "end_turn";
  const usage = turn.usage || { input_tokens: 100, output_tokens: 20 };
  return { id: `msg_mock_${reqIndex}`, type: "message", role: "assistant", model, content, stop_reason, stop_sequence: null, usage };
}

function writeBlocking(res, msg) {
  const body = JSON.stringify(msg);
  res.writeHead(200, { "content-type": "application/json" });
  res.end(body);
}

function sse(res, event, data) {
  res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
}

async function writeStreaming(res, msg) {
  res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive" });
  sse(res, "message_start", { type: "message_start", message: { ...msg, content: [], stop_reason: null, usage: { ...msg.usage, output_tokens: 0 } } });
  msg.content.forEach((block, i) => {
    if (block.type === "text") {
      sse(res, "content_block_start", { type: "content_block_start", index: i, content_block: { type: "text", text: "" } });
      // Split text into a few chunks so streaming is observably chunked.
      const chunks = block.text.match(/.{1,24}(\s|$)|.+$/g) || [block.text];
      for (const c of chunks) sse(res, "content_block_delta", { type: "content_block_delta", index: i, delta: { type: "text_delta", text: c } });
      sse(res, "content_block_stop", { type: "content_block_stop", index: i });
    } else {
      sse(res, "content_block_start", { type: "content_block_start", index: i, content_block: { type: "tool_use", id: block.id, name: block.name, input: {} } });
      sse(res, "content_block_delta", { type: "content_block_delta", index: i, delta: { type: "input_json_delta", partial_json: JSON.stringify(block.input) } });
      sse(res, "content_block_stop", { type: "content_block_stop", index: i });
    }
  });
  sse(res, "message_delta", { type: "message_delta", delta: { stop_reason: msg.stop_reason, stop_sequence: null }, usage: { output_tokens: msg.usage.output_tokens } });
  sse(res, "message_stop", { type: "message_stop" });
  res.end();
}

// Start the mock. Returns { url, close, port }.
export function startMock({ scenario, logPath } = {}) {
  const turns = scenario?.turns || [];
  let reqIndex = 0;

  const server = createServer((req, res) => {
    if (req.method !== "POST" || !req.url.startsWith("/v1/messages")) {
      res.writeHead(404); res.end("not found"); return;
    }
    let raw = "";
    req.on("data", (c) => (raw += c));
    req.on("end", async () => {
      let body;
      try { body = JSON.parse(raw); } catch { res.writeHead(400); res.end("bad json"); return; }

      const assistantCount = (body.messages || []).filter((m) => m.role === "assistant").length;
      const turn = turns[assistantCount];

      if (logPath) {
        appendFileSync(logPath, JSON.stringify({
          type: "request",
          req: reqIndex,
          turnIndex: assistantCount,
          system: typeof body.system === "string" ? body.system : (Array.isArray(body.system) ? body.system.map((b) => b.text).join("") : ""),
          tools: (body.tools || []).map((t) => t.name),
          messages: (body.messages || []).map((m) => ({
            role: m.role,
            content: typeof m.content === "string" ? m.content
              : (m.content || []).map((b) => b.type === "tool_use" ? `tool_use:${b.name}` : b.type === "tool_result" ? "tool_result" : b.type),
          })),
          stream: !!body.stream,
        }) + "\n");
      }

      // Queue exhausted: fail loudly. A false green is worse than a red test.
      if (!turn) {
        const err = { type: "error", error: { type: "mock_exhausted", message: `mock scenario has no turn ${assistantCount} (only ${turns.length})` } };
        if (logPath) appendFileSync(logPath, JSON.stringify({ type: "exhausted", req: reqIndex, turnIndex: assistantCount }) + "\n");
        res.writeHead(500, { "content-type": "application/json" }); res.end(JSON.stringify(err)); return;
      }

      const msg = messageFromTurn(turn, body.model || "mock", reqIndex);
      if (logPath) appendFileSync(logPath, JSON.stringify({
        type: "response", req: reqIndex, stop_reason: msg.stop_reason,
        tool_use: msg.content.filter((b) => b.type === "tool_use").map((b) => ({ name: b.name, input: b.input })),
      }) + "\n");
      reqIndex++;

      if (body.stream) await writeStreaming(res, msg);
      else writeBlocking(res, msg);
    });
  });

  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const port = server.address().port;
      resolve({ url: `http://127.0.0.1:${port}`, port, close: () => new Promise((r) => server.close(r)) });
    });
  });
}
