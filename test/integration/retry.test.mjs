// Error/retry path: the mock injects a 429 on the first main request, then 200.
// The CLI's exponential-backoff retry (agent.ts isRetryable: 429/503/529,
// maxRetries 3) must recover and still complete the turn. Both backends. This
// path was previously untested. Node CLI.
import { test } from "node:test";
import assert from "node:assert/strict";
import { runRepl, runReplInteractive, parseServed } from "./harness.mjs";

for (const backend of ["openai", "anthropic"]) {
  test(`[${backend}] retry: 429 then 200 → turn recovers`, async () => {
    const { stdout, code, servedLog } = await runRepl({
      backend,
      stdin: ["say hi"],
      script: {
        status: [429, 200],           // first main request 429, retry gets 200
        main: [{ content: "RECOVERED_AFTER_429" }],
      },
      timeoutMs: 20000,               // first backoff is ~1-2s
    });
    assert.equal(code, 0, `exit (stdout: ${stdout})`);
    assert.match(stdout, /RECOVERED_AFTER_429/, "the turn must complete after the retry");
    const served = parseServed(servedLog);
    assert.ok(served.some((e) => e.httpStatus === 429), "a 429 must have been injected");
    assert.ok(served.some((e) => e.category === "main" && !e.httpStatus), "the retried request must have been served the main turn");
  });

  test(`[${backend}] hard error (400) surfaces, no false success, REPL survives`, async () => {
    // A non-retryable 400 on every main request: neither the SDK's internal
    // retries nor the CLI's withRetry (429/503/529 only) recover. The turn must
    // NOT print the never-served content, must surface an error, and the REPL
    // must recover to the prompt and exit cleanly (interactive mode: wait for the
    // error, then send exit — avoids the bulk-stdin readline race on error turns).
    const { stdout, stderr, code } = await runReplInteractive({
      backend,
      script: { statusAlways: 400, main: [{ content: "SHOULD_NEVER_APPEAR" }] },
      steps: [{ send: "say hi" }, { wait: /error|400|invalid/i }],
      allowExhausted: ["main"],
      timeoutMs: 30000,
    });
    assert.doesNotMatch(stdout, /SHOULD_NEVER_APPEAR/, "must not print content that was never served");
    assert.match(stdout + stderr, /error|400|fail|invalid|request/i, "the failure must surface, not silently pass");
    assert.equal(code, 0, "the REPL must recover to the prompt and exit cleanly after an API error");
  });
}
