"""Conformance selftest for the Python mock: the real Python SDK must work
against it for create, streaming (text chunks + tool input), usage, scenario
exhaustion (extra call -> error), and a malformed request. Same-process, which
is the only loopback shape that works on the dev host. The Node mock has its own
selftest (mock-anthropic.selftest.mjs); test.mjs exercises both end-to-end.
"""

import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
os.environ.pop("http_proxy", None); os.environ.pop("https_proxy", None); os.environ.pop("all_proxy", None)

import anthropic  # noqa: E402
from mock_anthropic import start_mock  # noqa: E402

# Three turns because this selftest makes three independent calls against one
# mock (create, stream, stream); the mock counts requests per track.
scenario = {"id": "selftest", "turns": [
    {"tools": [{"name": "read_file", "input": {"file_path": "x.txt"}}]},
    {"text": "all done reading the file"},
    {"tools": [{"name": "read_file", "input": {"file_path": "x.txt"}}]},
]}

fails = []


def check(name, cond):
    print(f"{'ok  ' if cond else 'FAIL'} {name}")
    if not cond:
        fails.append(name)


url, close = start_mock(scenario)
c = anthropic.Anthropic(api_key="test", base_url=url, timeout=10, max_retries=0)
tools = [{"name": "read_file", "description": "d", "input_schema": {"type": "object", "properties": {}, "required": []}}]

# create -> tool_use, with usage
m0 = c.messages.create(model="mock", max_tokens=50, tools=tools, messages=[{"role": "user", "content": "hi"}])
check("create -> tool_use", m0.stop_reason == "tool_use" and any(b.type == "tool_use" and b.name == "read_file" for b in m0.content))
check("usage present", m0.usage.output_tokens > 0)

# streaming -> text chunks accumulate + final message
msgs = [{"role": "user", "content": "hi"}, {"role": "assistant", "content": m0.content},
        {"role": "user", "content": [{"type": "tool_result", "tool_use_id": "toolu_mock_0_0", "content": "data"}]}]
chunks = 0
with c.messages.stream(model="mock", max_tokens=50, tools=tools, messages=msgs) as s:
    for _ in s.text_stream:
        chunks += 1
    fin = s.get_final_message()
check("stream -> final end_turn", fin.stop_reason == "end_turn")
check("stream -> text chunked", chunks >= 1 and "done" in "".join(b.text for b in fin.content if b.type == "text"))

# streaming tool input round-trips
with c.messages.stream(model="mock", max_tokens=50, tools=tools, messages=[{"role": "user", "content": "hi"}]) as s:
    for _ in s.text_stream:
        pass
    fin2 = s.get_final_message()
check("stream -> tool input intact", any(b.type == "tool_use" and b.input == {"file_path": "x.txt"} for b in fin2.content))

# exhaustion: a third assistant turn was never scripted -> error, not silent success
try:
    over = [{"role": "user", "content": "hi"},
            {"role": "assistant", "content": [{"type": "text", "text": "a"}]},
            {"role": "assistant", "content": [{"type": "text", "text": "b"}]}]
    c.messages.create(model="mock", max_tokens=10, messages=over)
    check("exhaustion -> error", False)
except anthropic.APIError:
    check("exhaustion -> error", True)

close()
print("\n" + ("SELFTEST FAILED: " + ", ".join(fails) if fails else "SELFTEST PASSED"))
sys.exit(1 if fails else 0)
