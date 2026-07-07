// Integration tests: Auto Mode (--auto) driven through the REAL chat loop and
// permission path against the mock LLM. Covers the two-stage classifier, the
// fast-path, and — critically — that auto propagates into sub-agents so a
// blocked action can't be laundered through the `agent` tool. Node CLI.
//
// Assertions verify the FULL round, not just "not Denied": the tool result /
// final assistant content, the exit code, and the exact number of main and
// classifier requests (via the mock's served log). Strict queue exhaustion in
// the harness additionally fails any under-scripted round.
import { test } from "node:test";
import assert from "node:assert/strict";
import { runRepl, countCategory } from "./harness.mjs";

test("Auto Mode: fast-path tool (read_file) allowed without the classifier", async () => {
  const { stdout, code, servedLog } = await runRepl({
    args: ["--auto"], gitInit: true, // sandbox README.md contains "hi"
    stdin: ["read the file README.md"],
    script: {
      main: [
        { tool_calls: [{ name: "read_file", arguments: { file_path: "README.md" } }] },
        { content: "FASTPATH_FINAL the file contains hi" },
      ],
    },
  });
  assert.equal(code, 0, `exit (stderr elided)`);
  assert.doesNotMatch(stdout, /Denied/, "read_file must not be blocked");
  assert.match(stdout, /hi/, "the file's content should have been read");
  assert.match(stdout, /FASTPATH_FINAL/, "the round must reach the final assistant turn");
  assert.equal(countCategory(servedLog, "classifier"), 0, "fast-path tool must not call the classifier");
  assert.equal(countCategory(servedLog, "main"), 2);
});

test("Auto Mode: stage 1 allow → tool runs, exactly one classifier call", async () => {
  const { stdout, code, servedLog } = await runRepl({
    args: ["--auto"], gitInit: true,
    stdin: ["run echo"],
    script: {
      main: [
        { tool_calls: [{ name: "run_shell", arguments: { command: "echo HELLO_AUTO" } }] },
        { content: "RAN_IT_FINAL" },
      ],
      classifier: ["<block>no</block>"],
    },
  });
  assert.equal(code, 0);
  assert.doesNotMatch(stdout, /Denied/);
  assert.match(stdout, /HELLO_AUTO/, "the allowed shell command should have executed");
  assert.match(stdout, /RAN_IT_FINAL/);
  assert.equal(countCategory(servedLog, "classifier"), 1, "stage 1 allow → exactly one classifier call");
  assert.equal(countCategory(servedLog, "main"), 2);
});

test("Auto Mode: stage 1 block → stage 2 allow (intent) → tool runs, two calls", async () => {
  const { stdout, code, servedLog } = await runRepl({
    args: ["--auto"], gitInit: true,
    stdin: ["I authorize this: run echo"],
    script: {
      main: [
        { tool_calls: [{ name: "run_shell", arguments: { command: "echo INTENT_OK" } }] },
        { content: "RAN_AFTER_INTENT" },
      ],
      classifier: ["<block>yes</block><reason>[X] aggressive</reason>", "<block>no</block>"],
    },
  });
  assert.equal(code, 0);
  assert.doesNotMatch(stdout, /Denied/);
  assert.match(stdout, /INTENT_OK/, "the command must actually run after stage 2 clears it");
  assert.match(stdout, /RAN_AFTER_INTENT/);
  assert.equal(countCategory(servedLog, "classifier"), 2, "stage 1 block escalates to stage 2");
});

test("Auto Mode: stage 1 block → stage 2 block → Denied", async () => {
  const { stdout, code, servedLog } = await runRepl({
    args: ["--auto"], gitInit: true,
    stdin: ["push to main"],
    script: {
      main: [
        { tool_calls: [{ name: "run_shell", arguments: { command: "git push origin main" } }] },
        { content: "ACK_BLOCK_FINAL" },
      ],
      classifier: [
        "<block>yes</block><reason>[Git Push to Default Branch] s1</reason>",
        "<block>yes</block><reason>[Git Push to Default Branch] bypasses review</reason>",
      ],
    },
  });
  assert.equal(code, 0);
  assert.match(stdout, /Denied:.*\[Auto Mode\].*Default Branch/);
  assert.match(stdout, /ACK_BLOCK_FINAL/, "after the block, the model turn continues");
  assert.equal(countCategory(servedLog, "classifier"), 2);
});

test("Auto Mode: propagates into sub-agents (blocked action can't be laundered)", async () => {
  const { stdout, code } = await runRepl({
    args: ["--auto"], gitInit: true,
    stdin: ["delegate a push to a sub-agent"],
    script: {
      main: [
        { tool_calls: [{ name: "agent", arguments: { type: "general", prompt: "run git push origin main" } }] },
        { tool_calls: [{ name: "run_shell", arguments: { command: "git push origin main" } }] }, // sub-agent
        { content: "SUBAGENT_BLOCKED_FINAL" }, // sub-agent final
        { content: "PARENT_REPORTS_BLOCK" },   // parent final
      ],
      classifier: [
        "<block>no</block>",                                                        // parent: agent tool allowed
        "<block>yes</block><reason>[Git Push to Default Branch] s1</reason>",        // sub: run_shell S1
        "<block>yes</block><reason>[Git Push to Default Branch] bypasses review</reason>", // sub: run_shell S2
      ],
    },
  });
  assert.equal(code, 0);
  assert.match(stdout, /Denied:.*\[Auto Mode\].*Default Branch/, "sub-agent's push must be classified and blocked");
});
