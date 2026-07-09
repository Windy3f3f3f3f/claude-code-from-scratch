// Backend parity: run the SAME core scenarios against BOTH the OpenAI-compatible
// and the Anthropic-native backend (mock mode, same scripts), asserting the
// observable behavior is identical. This is what proves the Anthropic wire path
// (anthropicBaseURL → messages.stream / messages.create) is wired as well as the
// OpenAI one — previously only OpenAI was exercised. Node CLI.
import { test } from "node:test";
import assert from "node:assert/strict";
import { runRepl, countCategory } from "./harness.mjs";

const BACKENDS = ["openai", "anthropic"];

for (const backend of BACKENDS) {
  test(`[${backend}] basic chat: streamed reply reaches stdout`, async () => {
    const { stdout, code, servedLog } = await runRepl({
      backend, script: { main: [{ content: "PARITY_CHAT_OK" }] }, stdin: ["say hi"],
    });
    assert.equal(code, 0, `exit (stdout: ${stdout})`);
    assert.match(stdout, /PARITY_CHAT_OK/);
    assert.equal(countCategory(servedLog, "main"), 1);
    // the request really hit the backend we intended
    assert.ok(servedLog.includes(`"backend":"${backend}"`), `served log should record backend=${backend}`);
  });

  test(`[${backend}] tool round: read_file executes and result feeds back`, async () => {
    const { stdout, code, servedLog } = await runRepl({
      backend, gitInit: true, // sandbox README.md contains "hi"
      stdin: ["read README.md"],
      script: {
        main: [
          { tool_calls: [{ name: "read_file", arguments: { file_path: "README.md" } }] },
          { content: "PARITY_TOOL_FINAL saw the file" },
        ],
      },
    });
    assert.equal(code, 0);
    assert.match(stdout, /hi/, "file content should be read back");
    assert.match(stdout, /PARITY_TOOL_FINAL/, "must reach the final turn after the tool");
    assert.equal(countCategory(servedLog, "main"), 2);
  });

  test(`[${backend}] /goal achieve: evaluator ok:true → Goal achieved`, async () => {
    const { stdout, code } = await runRepl({
      backend, stdin: ["/goal your reply contains DONE"],
      script: {
        main: [{ content: "acknowledged — DONE" }],
        evaluator: ['{"ok":true,"reason":"contains DONE"}'],
      },
    });
    assert.equal(code, 0);
    assert.match(stdout, /Goal achieved/);
  });

  test(`[${backend}] streaming tool args split across chunks reassemble`, async () => {
    // splitArgsAt forces the tool arguments to arrive in several SSE deltas; the
    // client must reassemble them (differs OpenAI tool_calls vs Anthropic
    // input_json_delta — both must work).
    const { stdout, code } = await runRepl({
      backend, gitInit: true,
      stdin: ["read the readme"],
      script: {
        main: [
          { tool_calls: [{ name: "read_file", arguments: { file_path: "README.md" }, splitArgsAt: [5, 12] }] },
          { content: "SPLIT_ARGS_FINAL" },
        ],
      },
    });
    assert.equal(code, 0);
    assert.match(stdout, /hi/, "split-arg tool call must still parse file_path and read the file");
    assert.match(stdout, /SPLIT_ARGS_FINAL/);
  });
}
