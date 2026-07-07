// Integration tests: drive the REAL mini-claude REPL (node CLI) against the mock
// LLM, exercising /goal, /loop, and basic chat end-to-end (chat loop + wiring +
// evaluator, no network). Run via `node --test test/integration/*.test.mjs`
// after `npm run build`.
import { test } from "node:test";
import assert from "node:assert/strict";
import { runRepl } from "./harness.mjs";

test("basic chat: streamed main reply reaches stdout", async () => {
  const { stdout, code } = await runRepl({
    script: { main: [{ content: "MOCK_BASIC_OK" }] },
    stdin: ["say hi"],
  });
  assert.equal(code, 0, `exit code (stdout: ${stdout})`);
  assert.match(stdout, /MOCK_BASIC_OK/);
});

test("/goal achieve: evaluator ok:true → Goal achieved", async () => {
  const { stdout } = await runRepl({
    stdin: ["/goal your reply contains DONE"],
    script: {
      main: [{ content: "acknowledged — DONE" }],
      evaluator: ['{"ok":true,"reason":"reply contains DONE"}'],
    },
  });
  assert.match(stdout, /Goal achieved/);
});

test("/goal not-met then achieve: reason fed back, then met", async () => {
  const { stdout } = await runRepl({
    stdin: ["/goal your reply contains DONE"],
    script: {
      main: [{ content: "still working" }, { content: "ok DONE now" }],
      evaluator: [
        '{"ok":false,"reason":"no DONE yet"}',
        '{"ok":true,"reason":"DONE present"}',
      ],
    },
  });
  assert.match(stdout, /condition was not met/i, "should feed the not-met reason back");
  assert.match(stdout, /Goal achieved/);
});

test("/goal impossible: evaluator impossible → brake", async () => {
  const { stdout } = await runRepl({
    stdin: ["/goal make 2+2 equal 5"],
    script: {
      main: [{ content: "trying" }],
      evaluator: ['{"ok":false,"impossible":true,"reason":"arithmetic"}'],
    },
  });
  assert.match(stdout, /judged impossible/i);
});

test("/goal iteration cap: never-met condition stops at the backstop", async () => {
  // Empty queues -> mock returns empty content -> evaluator verdict is
  // unparseable -> not-met every round, so the GOAL_MAX_ITERATIONS backstop must
  // eventually stop it rather than looping forever.
  const { stdout } = await runRepl({
    stdin: ["/goal a condition that is never reported met"],
    script: { main: [], evaluator: [] },
    allowExhausted: ["main", "evaluator"], // intentional: empty queues drive not-met forever
    timeoutMs: 25000,
  });
  assert.match(stdout, /reached \d+ iterations/i, "the deadlock backstop must fire");
});

test("/loop dynamic converges when model schedules no wakeup", async () => {
  const { stdout } = await runRepl({
    stdin: ["/loop do a one-time thing"],
    // one main turn, no schedule_wakeup tool call → loop converges
    script: { main: [{ content: "did it, nothing to schedule" }] },
  });
  assert.match(stdout, /converged/i);
});
