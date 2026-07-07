// Integration tests for the mid-turn confirmation prompt — the interactive path
// the bulk harness cannot reach (the "Allow? (y/n)" question reads input WHILE a
// turn is executing a dangerous tool). Uses the expect-style interactive mode.
import { test } from "node:test";
import assert from "node:assert/strict";
import { runReplInteractive, countCategory } from "./harness.mjs";

test("confirm: answering 'y' at the Allow? prompt lets the action run", async () => {
  const { stdout, code, servedLog } = await runReplInteractive({
    gitInit: true,
    steps: [
      { send: "remove a scratch file" },
      { wait: /Allow\?/, send: "y" },
      { wait: /CONFIRM_YES_DONE/ },
    ],
    script: {
      main: [
        { tool_calls: [{ name: "run_shell", arguments: { command: "rm -rf ./mc-scratch-noop" } }] },
        { content: "CONFIRM_YES_DONE" },
      ],
    },
  });
  assert.equal(code, 0, `exit (stdout tail: ${stdout.slice(-200)})`);
  assert.match(stdout, /Allow\?/, "a dangerous shell command must prompt for confirmation");
  assert.match(stdout, /CONFIRM_YES_DONE/, "after approval the round completes");
  assert.equal(countCategory(servedLog, "main"), 2);
});

test("confirm: answering 'n' denies the action (it does not run)", async () => {
  // A dangerous command (rm -rf triggers the prompt) that would echo a visible
  // marker IF it ran — declining must keep that marker out of stdout.
  const { stdout, code } = await runReplInteractive({
    gitInit: true,
    steps: [
      { send: "remove a scratch file" },
      { wait: /Allow\?/, send: "n" },
      { wait: /CONFIRM_NO_DONE/ },
    ],
    // The marker is computed by the shell ($((6*7)) -> 42), so "MARK_42_END"
    // only appears in stdout if the command actually EXECUTED — the command text
    // itself shows the un-evaluated "MARK_$((6*7))_END".
    script: {
      main: [
        { tool_calls: [{ name: "run_shell", arguments: { command: "rm -rf ./mc-noop && echo MARK_$((6*7))_END" } }] },
        { content: "CONFIRM_NO_DONE" },
      ],
    },
  });
  assert.equal(code, 0);
  assert.match(stdout, /Allow\?/);
  assert.doesNotMatch(stdout, /MARK_42_END/, "the declined command must not execute");
  assert.match(stdout, /CONFIRM_NO_DONE/, "the round continues after the denial");
});
