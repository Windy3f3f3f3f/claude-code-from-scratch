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
    """Start the mock in a daemon thread. Returns (url, close). A scenario is
    flat ({turns}) or multi-track ({tracks: {main:{turns}, compact:{match,turns}}});
    requests route to a track by a substring its `match` finds in the system
    prompt (default "main"), each track with its own counter."""
    tracks = (scenario or {}).get("tracks") or {"main": {"turns": (scenario or {}).get("turns", [])}}
    state = {"req": 0, "counters": {}}

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

            sys_text = body.get("system", "")
            if isinstance(sys_text, list):
                sys_text = "".join(b.get("text", "") for b in sys_text)
            # Route to a track by its `match` substring; default "main".
            track = "main"
            for name, t in tracks.items():
                if t.get("match") and t["match"] in sys_text:
                    track = name
                    break
            turn_index = state["counters"].get(track, 0)
            track_turns = tracks.get(track, {}).get("turns", [])
            turn = track_turns[turn_index] if turn_index < len(track_turns) else None

            # tool_result blocks the agent sent back — proof the tool actually
            # ran, with its real output.
            tool_results = []
            for m in body.get("messages", []):
                if isinstance(m.get("content"), list):
                    for b in m["content"]:
                        if b.get("type") == "tool_result":
                            c = b.get("content")
                            tool_results.append({"tool_use_id": b.get("tool_use_id"),
                                                 "content": c if isinstance(c, str) else json.dumps(c)})
            first_user = next((m for m in body.get("messages", []) if m.get("role") == "user"), None)
            first_user_text = first_user["content"] if first_user and isinstance(first_user.get("content"), str) else ""
            log({"type": "request", "req": req_index, "track": track, "turnIndex": turn_index,
                 "system": sys_text, "tools": [t["name"] for t in body.get("tools", [])],
                 "toolResults": tool_results, "messageCount": len(body.get("messages", [])),
                 "firstUserText": first_user_text, "stream": bool(body.get("stream"))})

            if turn is None:
                log({"type": "exhausted", "req": req_index, "track": track, "turnIndex": turn_index})
                err = json.dumps({"type": "error", "error": {"type": "mock_exhausted",
                      "message": f'track "{track}" has no turn {turn_index}'}}).encode()
                self.send_response(500); self.send_header("content-type", "application/json")
                self.send_header("content-length", str(len(err))); self.end_headers(); self.wfile.write(err); return
            state["counters"][track] = turn_index + 1

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
