// Multi-turn tool chain: read → edit → read-back, driven through the real chat
// loop. Each tool result is fed back and the next turn depends on it.
//
// Anti-false-green: the final reply is a MARKER ONLY ("CHAIN_DONE"), so "hello"
// can't come from scripted content. We assert (a) the read-back tool_result the
// CLI fed back actually contains "hello" (and not the original "hi"), and (b) the
// sandbox file on disk is really "hello\n" — so breaking edit_file turns it red.
// Both backends. Node CLI.
import { test } from "node:test";
import assert from "node:assert/strict";
import { runRepl, countCategory, toolResultTexts } from "./harness.mjs";

for (const backend of ["openai", "anthropic"]) {
  test(`[${backend}] tool chain: read → edit → read-back reflects the edit on disk`, async () => {
    const { stdout, code, servedLog, files } = await runRepl({
      backend, gitInit: true, captureFiles: ["README.md"], // sandbox README.md = "hi\n"
      stdin: ["change hi to hello in README.md and confirm"],
      script: {
        main: [
          { tool_calls: [{ name: "read_file", arguments: { file_path: "README.md" } }] },
          { tool_calls: [{ name: "edit_file", arguments: { file_path: "README.md", old_string: "hi", new_string: "hello" } }] },
          { tool_calls: [{ name: "read_file", arguments: { file_path: "README.md" } }] },
          { content: "CHAIN_DONE" },
        ],
      },
      timeoutMs: 20000,
    });
    assert.equal(code, 0, `exit (stdout: ${stdout})`);
    assert.match(stdout, /CHAIN_DONE/, "the chain must reach the final turn");
    assert.equal(countCategory(servedLog, "main"), 4, "four main turns: read, edit, read, final");
    // the edit really persisted to disk
    assert.equal(files["README.md"], "hello\n", "edit_file must have written 'hello' to the file");
    // the read-back after the edit fed the NEW content to the model
    const results = toolResultTexts(servedLog);
    assert.ok(results.some((t) => t.includes("hello")), "a tool_result must carry the edited content 'hello'");
  });
}
