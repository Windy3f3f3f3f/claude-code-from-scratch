// Error/retry path. The mock injects HTTP errors per main request. We set
// MINI_CLAUDE_SDK_MAX_RETRIES=0 to switch OFF the SDK's built-in retry layer, so
// these tests actually exercise the CLI's own withRetry (agent.ts: 429/503/529,
// maxRetries 3) rather than being silently absorbed by the SDK. Both backends.
import { test } from "node:test";
import assert from "node:assert/strict";
import { runRepl, runReplInteractive, parseServed } from "./harness.mjs";

const SDK_OFF = { MINI_CLAUDE_SDK_MAX_RETRIES: "0" };

for (const backend of ["openai", "anthropic"]) {
  test(`[${backend}] CLI withRetry recovers 429 → 200 (SDK retries off)`, async () => {
    const { stdout, code, servedLog } = await runRepl({
      backend, stdin: ["say hi"],
      script: { status: [429, 200], main: [{ content: "RECOVERED_AFTER_429" }] },
      extraEnv: SDK_OFF,
      timeoutMs: 20000, // one CLI backoff ~1-2s
    });
    assert.equal(code, 0, `exit (stdout: ${stdout})`);
    assert.match(stdout, /RECOVERED_AFTER_429/, "the turn must complete after the retry");
    assert.match(stdout, /Retry 1\/3/i, "the CLI's own withRetry banner must show (proves it, not the SDK layer)");
    const served = parseServed(servedLog);
    assert.equal(served.filter((e) => e.httpStatus === 429).length, 1, "exactly one 429 — the SDK did not retry it");
    assert.equal(served.filter((e) => e.category === "main" && !e.httpStatus).length, 1, "one successful main serve after the retry");
  });

  test(`[${backend}] CLI withRetry exhausts on all-429 → gives up, no false success (SDK off)`, async () => {
    const { stdout, stderr, code } = await runReplInteractive({
      backend,
      script: { statusAlways: 429, main: [{ content: "SHOULD_NEVER_APPEAR" }] },
      steps: [{ send: "say hi" }, { wait: /Error:/i }], // the final give-up (not the "Retry N/3" banners)
      extraEnv: SDK_OFF,
      allowExhausted: ["main"],
      stepTimeoutMs: 25000, // the give-up comes only after ~1+2+4s of backoff
      timeoutMs: 40000,
    });
    assert.doesNotMatch(stdout, /SHOULD_NEVER_APPEAR/, "must not print content that was never served");
    assert.match(stdout, /Retry 3\/3/i, "the retry loop must run to the max before giving up");
    assert.match(stdout + stderr, /Error:/i, "the final failure must surface");
    assert.equal(code, 0, "the REPL must recover to the prompt and exit cleanly");
  });

  test(`[${backend}] non-retryable 400 surfaces immediately, REPL survives`, async () => {
    const { stdout, stderr, code } = await runReplInteractive({
      backend,
      script: { statusAlways: 400, main: [{ content: "SHOULD_NEVER_APPEAR" }] },
      steps: [{ send: "say hi" }, { wait: /error|400|invalid/i }],
      allowExhausted: ["main"],
      timeoutMs: 30000,
    });
    assert.doesNotMatch(stdout, /SHOULD_NEVER_APPEAR/, "must not print content that was never served");
    assert.doesNotMatch(stdout, /Retry \d\/3/i, "a 400 is not retryable — no retry banner");
    assert.match(stdout + stderr, /error|400|invalid|request/i, "the failure must surface");
    assert.equal(code, 0, "the REPL must recover and exit cleanly after an API error");
  });
}
