// LIVE tests: drive the real CLI against the REAL model API (both backends),
// reading keys from .env. Real models are non-deterministic, so these assert
// robust behavioral invariants (a token is echoed; a file's content is reported
// after a real tool call) rather than exact text. Each test SKIPS cleanly when
// that backend's key isn't in .env, and RUNS when it is — so the same suite is
// safe in CI (no keys → all skip) and meaningful locally (keys → real coverage).
//
// Run just these with keys present:  node --test test/integration/live.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { runReplInteractive, liveKeyAvailable } from "./harness.mjs";

// A capable model per backend (behavioral prompts need real tool-use ability).
const MODEL = { anthropic: "claude-sonnet-4-5-20250929", openai: "gpt-4o" };

for (const backend of ["anthropic", "openai"]) {
  const skip = liveKeyAvailable(backend) ? false : `no ${backend} key in .env (live test skipped)`;

  test(`[live:${backend}] basic prompt reaches the real model`, { skip }, async () => {
    const { stdout } = await runReplInteractive({
      backend, live: true, model: MODEL[backend],
      steps: [{ send: "Reply with exactly the token LIVEPROBE7 and nothing else." }, { wait: /LIVEPROBE7|error/i }],
      timeoutMs: 60000,
    });
    assert.match(stdout, /LIVEPROBE7/, "the real model should echo the requested token");
  });

  test(`[live:${backend}] real tool use: reads a file, echoes a token in the FINAL reply`, { skip }, async () => {
    // Unique token + composed marker: the tool output alone is "LIVE_FILE_7Q2";
    // only if the model actually read it AND composed its final reply will the
    // combined "LIVE_TOOL_OK_LIVE_FILE_7Q2" appear — so this proves the real
    // tool loop, not just the CLI echoing the tool result.
    const { stdout } = await runReplInteractive({
      backend, live: true, model: MODEL[backend],
      sandboxFiles: { "secret.txt": "LIVE_FILE_7Q2\n" },
      steps: [
        { send: "Read the file secret.txt in the current directory, then reply with exactly LIVE_TOOL_OK_ immediately followed by the token you found (e.g. LIVE_TOOL_OK_ABC123)." },
        { wait: /LIVE_TOOL_OK_LIVE_FILE_7Q2|error/i },
      ],
      timeoutMs: 60000,
    });
    assert.match(stdout, /LIVE_TOOL_OK_LIVE_FILE_7Q2/, "the model must read the file and echo the token in its own final reply");
  });
}
