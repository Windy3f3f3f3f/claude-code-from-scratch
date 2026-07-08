// Prove the Node mock speaks enough of the real Anthropic protocol that the
// actual TS SDK works against it — create, stream, and tool_use — same-process
// (the only loopback shape that works on the dev host). The Python mock is
// exercised end-to-end by test.mjs's Python path against the real Python SDK.

import { startMock } from "./mock-anthropic.mjs";
import Anthropic from "@anthropic-ai/sdk";

const scenario = {
  id: "selftest",
  turns: [
    { tools: [{ name: "read_file", input: { file_path: "x.txt" } }] },
    { text: "done reading" },
  ],
};

const fails = [];
function check(name, cond) {
  console.log(`${cond ? "ok  " : "FAIL"} ${name}`);
  if (!cond) fails.push(name);
}

const mock = await startMock({ scenario });
const client = new Anthropic({ apiKey: "test", baseURL: mock.url, timeout: 15000, maxRetries: 0 });

// --- TS create: turn 0 (tool_use), then turn 1 (text) ---
const m0 = await client.messages.create({
  model: "mock", max_tokens: 100,
  tools: [{ name: "read_file", description: "d", input_schema: { type: "object", properties: {}, required: [] } }],
  messages: [{ role: "user", content: "read x.txt" }],
});
check("TS create -> tool_use", m0.stop_reason === "tool_use" && m0.content.some((b) => b.type === "tool_use" && b.name === "read_file"));

const m1 = await client.messages.create({
  model: "mock", max_tokens: 100,
  messages: [
    { role: "user", content: "read x.txt" },
    { role: "assistant", content: m0.content },
    { role: "user", content: [{ type: "tool_result", tool_use_id: "toolu_mock_0_0", content: "hi" }] },
  ],
});
check("TS create -> final text", m1.stop_reason === "end_turn" && m1.content[0]?.type === "text" && m1.content[0].text.includes("done"));

// --- TS stream: turn 0 tool_use accumulates into a final message ---
const stream = client.messages.stream({
  model: "mock", max_tokens: 100,
  tools: [{ name: "read_file", description: "d", input_schema: { type: "object", properties: {}, required: [] } }],
  messages: [{ role: "user", content: "read x.txt" }],
});
let streamedText = "";
stream.on("text", (t) => (streamedText += t));
const fin = await stream.finalMessage();
check("TS stream -> tool_use in final", fin.stop_reason === "tool_use" && fin.content.some((b) => b.type === "tool_use" && JSON.stringify(b.input) === JSON.stringify({ file_path: "x.txt" })));

await mock.close();
console.log(fails.length ? `\nSELFTEST FAILED: ${fails.join(", ")}` : "\nSELFTEST PASSED");
process.exit(fails.length ? 1 : 0);
