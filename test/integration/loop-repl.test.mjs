// Integration tests: /loop interval mode + core REPL commands, through the real
// REPL against the mock LLM. Node CLI.
import { test } from "node:test";
import assert from "node:assert/strict";
import { runRepl } from "./harness.mjs";

test("/loop interval: re-invokes on the interval, stopped by --max-turns", async () => {
  const { stdout } = await runRepl({
    args: ["--max-turns", "2"],
    stdin: ["/loop 1s reply briefly"],
    script: { main: [{ content: "tick one" }, { content: "tick two" }] },
    timeoutMs: 20000,
  });
  assert.match(stdout, /loop tick 1/);
  assert.match(stdout, /loop tick 2/);
  assert.match(stdout, /tick limit reached/i, "should stop at the --max-turns tick limit");
});

test("REPL /cost prints usage without an API call", async () => {
  const { stdout, code } = await runRepl({
    stdin: ["/cost"],
    script: {},
  });
  assert.equal(code, 0);
  assert.match(stdout, /Tokens:/);
});

test("REPL /skills lists skills without an API call", async () => {
  const { stdout } = await runRepl({
    stdin: ["/skills"],
    script: {},
  });
  assert.match(stdout, /skills|SKILL\.md/i);
});

test("REPL unknown /command falls through to a normal chat turn", async () => {
  const { stdout } = await runRepl({
    stdin: ["/definitelynotacommand"],
    script: { main: [{ content: "TREATED_AS_CHAT" }] },
  });
  assert.match(stdout, /TREATED_AS_CHAT/);
});

test("REPL /clear resets and still responds afterward", async () => {
  const { stdout, code } = await runRepl({
    stdin: ["/clear", "hello again"],
    script: { main: [{ content: "AFTER_CLEAR_OK" }] },
  });
  assert.equal(code, 0);
  assert.match(stdout, /AFTER_CLEAR_OK/);
});
