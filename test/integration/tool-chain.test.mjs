// Multi-turn tool chain: read → edit → read-back, driven through the real chat
// loop. Each tool result is fed back and the next turn depends on it — this
// exercises the loop's turn-to-turn state carry, not just a single tool call.
// Both backends. Node CLI.
import { test } from "node:test";
import assert from "node:assert/strict";
import { runRepl, countCategory } from "./harness.mjs";

for (const backend of ["openai", "anthropic"]) {
  test(`[${backend}] tool chain: read → edit → read-back reflects the edit`, async () => {
    const { stdout, code, servedLog } = await runRepl({
      backend, gitInit: true, // sandbox README.md contains "hi\n"
      stdin: ["change hi to hello in README.md and confirm"],
      script: {
        main: [
          { tool_calls: [{ name: "read_file", arguments: { file_path: "README.md" } }] },
          { tool_calls: [{ name: "edit_file", arguments: { file_path: "README.md", old_string: "hi", new_string: "hello" } }] },
          { tool_calls: [{ name: "read_file", arguments: { file_path: "README.md" } }] },
          { content: "CHAIN_DONE the file now says hello" },
        ],
      },
      timeoutMs: 20000,
    });
    assert.equal(code, 0, `exit (stdout: ${stdout})`);
    assert.match(stdout, /hello/, "the read-back after the edit must show the new content");
    assert.match(stdout, /CHAIN_DONE/, "the chain must reach the final turn");
    assert.equal(countCategory(servedLog, "main"), 4, "four main turns: read, edit, read, final");
  });
}
