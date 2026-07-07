// Self-tests for the integration infra itself (the user asked: "does the infra
// have bugs?"). Two things must hold: (1) the mock behaves as specified —
// categorizes requests, serves per-category queues, streams SSE; (2) the harness
// can actually FAIL — a wrong expectation is caught, so green means something.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { startMock, runRepl } from "./harness.mjs";

const HARNESS = join(dirname(fileURLToPath(import.meta.url)), "harness.mjs");

async function postJSON(port, body) {
  const res = await fetch(`http://127.0.0.1:${port}/v1/chat/completions`, {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
  });
  return res;
}

test("mock: categorizes side queries by system prompt and serves each queue", async () => {
  const mock = await startMock({
    classifier: ["<block>no</block>"],
    evaluator: ['{"ok":true,"reason":"z"}'],
  });
  try {
    const evalRes = await (await postJSON(mock.port, {
      messages: [{ role: "system", content: "You are evaluating a hook condition in Claude Code." }, { role: "user", content: "x" }],
    })).json();
    assert.equal(evalRes.choices[0].message.content, '{"ok":true,"reason":"z"}');

    const clsRes = await (await postJSON(mock.port, {
      messages: [{ role: "system", content: "You are a security monitor for autonomous AI coding agents." }, { role: "user", content: "x" }],
    })).json();
    assert.equal(clsRes.choices[0].message.content, "<block>no</block>");

    // An unrecognized side query (e.g. memory recall) is neutralized to empty.
    const memRes = await (await postJSON(mock.port, {
      messages: [{ role: "system", content: "recall relevant memories" }, { role: "user", content: "x" }],
    })).json();
    assert.equal(memRes.choices[0].message.content, "");
  } finally {
    mock.stop();
  }
});

test("mock: streams SSE for main turns and advances the main cursor", async () => {
  const mock = await startMock({ main: [{ content: "FIRST" }, { content: "SECOND" }] });
  try {
    const r1 = await (await postJSON(mock.port, { stream: true, messages: [{ role: "user", content: "a" }] })).text();
    assert.match(r1, /data: /);
    assert.match(r1, /FIRST/);
    assert.match(r1, /\[DONE\]/);
    const r2 = await (await postJSON(mock.port, { stream: true, messages: [{ role: "user", content: "b" }] })).text();
    assert.match(r2, /SECOND/, "second main request must get the next queued item");
    assert.doesNotMatch(r2, /FIRST/);
  } finally {
    mock.stop();
  }
});

test("harness: exit code and stdout are captured faithfully", async () => {
  const { stdout, code } = await runRepl({
    script: { main: [{ content: "CAPTURE_ME" }] },
    stdin: ["hi"],
  });
  assert.equal(code, 0, "a clean REPL session must report exit 0");
  assert.match(stdout, /CAPTURE_ME/);
});

test("no false-green: a wrong real test makes the runner exit non-zero", async () => {
  // Prove the WHOLE pipeline fails on a bad test, not just that assert.match
  // throws in-process. Write a real node:test file that drives the CLI and then
  // asserts a string the CLI never produces; run it in a child node --test and
  // require a non-zero exit that names the missing string.
  const dir = mkdtempSync(join(tmpdir(), "mc-nfg-"));
  const badTest = join(dir, "deliberately-wrong.test.mjs");
  writeFileSync(badTest, `
import { test } from "node:test";
import assert from "node:assert/strict";
import { runRepl } from ${JSON.stringify(HARNESS)};
test("this SHOULD fail", async () => {
  const { stdout } = await runRepl({ script: { main: [{ content: "ALPHA_ONLY" }] }, stdin: ["hi"] });
  assert.match(stdout, /OMEGA_NEVER_PRODUCED_9f3c/);
});
`);
  try {
    // Strip the parent's test-runner env so the nested `node --test` actually
    // runs (inherited NODE_OPTIONS / NODE_TEST_CONTEXT otherwise suppress it).
    const env = { ...process.env };
    delete env.NODE_OPTIONS;
    delete env.NODE_TEST_CONTEXT;
    const r = spawnSync(process.execPath, ["--test", badTest], { encoding: "utf8", timeout: 60000, env });
    assert.notEqual(r.status, 0, "a wrong test must make node --test exit non-zero (else everything is false-green)");
    assert.match(r.stdout + r.stderr, /OMEGA_NEVER_PRODUCED_9f3c/, "the failure output should name the wrong expectation");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("no false-green: an under-scripted round is caught by strict exhaustion", async () => {
  // Remove the final main turn an Auto-Mode round needs; the harness must throw
  // rather than pass on the mock's empty fallback.
  await assert.rejects(
    () => runRepl({
      args: ["--auto"], gitInit: true,
      stdin: ["run echo"],
      script: {
        main: [{ tool_calls: [{ name: "run_shell", arguments: { command: "echo X" } }] }], // missing final turn
        classifier: ["<block>no</block>"],
      },
    }),
    /exhausted/i,
    "an under-scripted round must fail loudly, not pass on the empty fallback",
  );
});
