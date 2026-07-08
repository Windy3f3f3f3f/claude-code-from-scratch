"""Python twin of mock-anthropic.mjs. Speaks the real Anthropic /v1/messages
protocol (create + SSE stream, tool_use, usage, errors) and replays a scripted
scenario. Runs in-thread so a Python step in the same process can reach it
(cross-process loopback is intercepted by the dev host's proxy). Reads the same
steps/scenarios/*.json as the Node mock, so the two cannot behave differently.
"""

import json
import threading
from http.server import BaseHTTPRequestHandler, HTTPServer


def _message_from_turn(turn, model, req_index):
    content = []
    if turn.get("text"):
        content.append({"type": "text", "text": turn["text"]})
    for j, t in enumerate(turn.get("tools", [])):
        content.append({"type": "tool_use", "id": f"toolu_mock_{req_index}_{j}",
                        "name": t["name"], "input": t.get("input", {})})
    stop_reason = "tool_use" if turn.get("tools") else "end_turn"
    usage = turn.get("usage", {"input_tokens": 100, "output_tokens": 20})
    return {"id": f"msg_mock_{req_index}", "type": "message", "role": "assistant",
            "model": model, "content": content, "stop_reason": stop_reason,
            "stop_sequence": None, "usage": usage}


def _sse(block_lines):
    return "".join(f"event: {e}\ndata: {json.dumps(d)}\n\n" for e, d in block_lines)


def _stream_body(msg):
    lines = [("message_start", {"type": "message_start", "message": {**msg, "content": [], "stop_reason": None,
              "usage": {**msg["usage"], "output_tokens": 0}}})]
    for i, block in enumerate(msg["content"]):
        if block["type"] == "text":
            lines.append(("content_block_start", {"type": "content_block_start", "index": i,
                          "content_block": {"type": "text", "text": ""}}))
            text = block["text"]
            for k in range(0, len(text), 24):
                lines.append(("content_block_delta", {"type": "content_block_delta", "index": i,
                              "delta": {"type": "text_delta", "text": text[k:k + 24]}}))
            lines.append(("content_block_stop", {"type": "content_block_stop", "index": i}))
        else:
            lines.append(("content_block_start", {"type": "content_block_start", "index": i,
                          "content_block": {"type": "tool_use", "id": block["id"], "name": block["name"], "input": {}}}))
            lines.append(("content_block_delta", {"type": "content_block_delta", "index": i,
                          "delta": {"type": "input_json_delta", "partial_json": json.dumps(block["input"])}}))
            lines.append(("content_block_stop", {"type": "content_block_stop", "index": i}))
    lines.append(("message_delta", {"type": "message_delta",
                  "delta": {"stop_reason": msg["stop_reason"], "stop_sequence": None},
                  "usage": {"output_tokens": msg["usage"]["output_tokens"]}}))
    lines.append(("message_stop", {"type": "message_stop"}))
    return _sse(lines)


def start_mock(scenario, log_path=None):
    """Start the mock in a daemon thread. Returns (url, close)."""
    turns = (scenario or {}).get("turns", [])
    state = {"req": 0}

    def log(obj):
        if log_path:
            with open(log_path, "a") as f:
                f.write(json.dumps(obj) + "\n")

    class Handler(BaseHTTPRequestHandler):
        def do_POST(self):
            if not self.path.startswith("/v1/messages"):
                self.send_response(404); self.end_headers(); self.wfile.write(b"not found"); return
            body = json.loads(self.rfile.read(int(self.headers.get("content-length", 0))) or b"{}")
            req_index = state["req"]
            assistant_count = sum(1 for m in body.get("messages", []) if m.get("role") == "assistant")
            turn = turns[assistant_count] if assistant_count < len(turns) else None

            sys_text = body.get("system", "")
            if isinstance(sys_text, list):
                sys_text = "".join(b.get("text", "") for b in sys_text)
            log({"type": "request", "req": req_index, "turnIndex": assistant_count,
                 "system": sys_text, "tools": [t["name"] for t in body.get("tools", [])],
                 "messages": [{"role": m["role"], "content": (m["content"] if isinstance(m["content"], str)
                              else [(f"tool_use:{b['name']}" if b.get("type") == "tool_use"
                                     else "tool_result" if b.get("type") == "tool_result" else b.get("type"))
                                    for b in m["content"]])} for m in body.get("messages", [])],
                 "stream": bool(body.get("stream"))})

            if turn is None:
                log({"type": "exhausted", "req": req_index, "turnIndex": assistant_count})
                err = json.dumps({"type": "error", "error": {"type": "mock_exhausted",
                      "message": f"no turn {assistant_count} (only {len(turns)})"}}).encode()
                self.send_response(500); self.send_header("content-type", "application/json")
                self.send_header("content-length", str(len(err))); self.end_headers(); self.wfile.write(err); return

            msg = _message_from_turn(turn, body.get("model", "mock"), req_index)
            log({"type": "response", "req": req_index, "stop_reason": msg["stop_reason"],
                 "tool_use": [{"name": b["name"], "input": b["input"]} for b in msg["content"] if b["type"] == "tool_use"]})
            state["req"] += 1

            if body.get("stream"):
                b = _stream_body(msg).encode()
                self.send_response(200); self.send_header("content-type", "text/event-stream")
                self.send_header("content-length", str(len(b))); self.end_headers(); self.wfile.write(b)
            else:
                b = json.dumps(msg).encode()
                self.send_response(200); self.send_header("content-type", "application/json")
                self.send_header("content-length", str(len(b))); self.end_headers(); self.wfile.write(b)

        def log_message(self, *a):
            pass

    srv = HTTPServer(("127.0.0.1", 0), Handler)
    port = srv.server_address[1]
    threading.Thread(target=srv.serve_forever, daemon=True).start()
    return f"http://127.0.0.1:{port}", srv.shutdown
