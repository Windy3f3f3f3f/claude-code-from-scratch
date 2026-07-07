// Integration tests for two paths the earlier suite didn't reach: the streaming
// tool-call argument accumulator (arguments split across SSE chunks), and the
// /loop dynamic schedule_wakeup path stopped by SIGINT. Node CLI.
import { test } from "node:test";
import assert from "node:assert/strict";
import { runRepl } from "./harness.mjs";

test("streaming: tool-call arguments split across chunks are reassembled", async () => {
  // The command JSON is delivered in three SSE fragments; if the client's
  // accumulation is wrong the command won't parse and the marker won't run.
  const { stdout, code } = await runRepl({
    gitInit: true,
    stdin: ["run the split command"],
    script: {
      main: [
        { tool_calls: [{ name: "run_shell", arguments: { command: "echo SPLIT_ARGS_OK" }, splitArgsAt: [5, 18] }] },
        { content: "SPLIT_FINAL" },
      ],
    },
  });
  assert.equal(code, 0);
  assert.match(stdout, /SPLIT_ARGS_OK/, "reassembled arguments must produce a runnable command");
  assert.match(stdout, /SPLIT_FINAL/);
});

test("/loop dynamic: schedule_wakeup then SIGINT stops the loop", async () => {
  const { stdout } = await runRepl({
    stdin: ["/loop keep checking"],
    script: {
      main: [
        { tool_calls: [{ name: "schedule_wakeup", arguments: { delaySeconds: 60, reason: "check later", prompt: "keep checking" } }] },
        { content: "scheduled the next run" },
      ],
    },
    signalAfterMs: 1500, // interrupt during the (60s-clamped) wait
    timeoutMs: 20000,
  });
  assert.match(stdout, /next run in 60s/, "the model's schedule_wakeup should schedule a clamped delay");
  assert.match(stdout, /Loop stopped/i, "SIGINT during the wait must stop the loop");
});
