// Integration tests against the REAL Python CLI (python -m mini_claude) through
// the same mock, proving the Python REPL/chat loop is wired like the TS one.
// The Python CLI imports the anthropic/openai SDKs, so these skip cleanly when
// the chosen python lacks them (e.g. the bare python3 used in `npm run check`).
// Run the full set with INTEG_PYTHON=/path/to/python-with-deps.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { runRepl } from "./harness.mjs";

const PY = process.env.INTEG_PYTHON || "python3";
function pythonHasDeps() {
  const r = spawnSync(PY, ["-c", "import anthropic, openai"], { stdio: "ignore" });
  return r.status === 0;
}
const SKIP = !pythonHasDeps();
const opts = SKIP ? { skip: `python (${PY}) lacks anthropic/openai` } : {};

test("py: basic chat streams to stdout", opts, async () => {
  const { stdout, code } = await runRepl({
    python: true, pythonBin: PY,
    script: { main: [{ content: "PY_BASIC_OK" }] },
    stdin: ["say hi"],
  });
  assert.equal(code, 0, `exit (stdout: ${stdout})`);
  assert.match(stdout, /PY_BASIC_OK/);
});

test("py: /goal achieve → Goal achieved", opts, async () => {
  const { stdout } = await runRepl({
    python: true, pythonBin: PY,
    stdin: ["/goal your reply contains DONE"],
    script: { main: [{ content: "DONE" }], evaluator: ['{"ok":true,"reason":"has DONE"}'] },
  });
  assert.match(stdout, /Goal achieved/);
});

test("py: /goal impossible → brake", opts, async () => {
  const { stdout } = await runRepl({
    python: true, pythonBin: PY,
    stdin: ["/goal make 2+2 equal 5"],
    script: { main: [{ content: "trying" }], evaluator: ['{"ok":false,"impossible":true,"reason":"math"}'] },
  });
  assert.match(stdout, /judged impossible/i);
});

test("py: /loop dynamic converges", opts, async () => {
  const { stdout } = await runRepl({
    python: true, pythonBin: PY,
    stdin: ["/loop one-time thing"],
    script: { main: [{ content: "done, no reschedule" }] },
  });
  assert.match(stdout, /converged/i);
});

test("py: Auto Mode two-stage block → Denied", opts, async () => {
  const { stdout } = await runRepl({
    python: true, pythonBin: PY,
    args: ["--auto"], gitInit: true,
    stdin: ["push to main"],
    script: {
      main: [
        { tool_calls: [{ name: "run_shell", arguments: { command: "git push origin main" } }] },
        { content: "acknowledged" },
      ],
      classifier: [
        "<block>yes</block><reason>[Git Push to Default Branch] s1</reason>",
        "<block>yes</block><reason>[Git Push to Default Branch] bypasses review</reason>",
      ],
    },
  });
  assert.match(stdout, /Denied:.*\[Auto Mode\].*Default Branch/);
});

test("py: Auto Mode fast-path (read_file) allowed without classifier", opts, async () => {
  const { stdout } = await runRepl({
    python: true, pythonBin: PY,
    args: ["--auto"], gitInit: true,
    stdin: ["read README.md"],
    script: { main: [{ tool_calls: [{ name: "read_file", arguments: { file_path: "README.md" } }] }, { content: "read it" }] },
  });
  assert.doesNotMatch(stdout, /Denied/);
});
