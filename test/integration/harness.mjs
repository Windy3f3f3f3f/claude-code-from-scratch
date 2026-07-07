// Integration harness: start the mock LLM, run the REAL mini-claude CLI (node or
// python) as a subprocess wired to the mock, drive it, capture stdout. This
// exercises the actual REPL / chat loop / permission wiring end-to-end with no
// network and full isolation (a throwaway HOME + cwd, so the real ~/.claude —
// skills, memory, settings, MCP servers — can neither pollute nor be polluted).
//
// Two drive modes:
//   runRepl        — pre-load all input lines, then EOF (fast, for turns that
//                    don't prompt back).
//   runReplInteractive — expect-style: send a line, wait for a stdout pattern,
//                    send the next; the only way to answer a mid-turn confirm /
//                    plan-approval prompt (those read input WHILE a turn runs).
import { spawn, spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync, rmSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = join(HERE, "..", "..");
const MOCK = join(HERE, "mock-llm.mjs");
const CLI_JS = join(REPO, "dist", "cli.js");
const PY_DIR = join(REPO, "python");

// Start the mock LLM on a random port with the given script object. Resolves to
// { port, log, stop }. Cleans up on start failure too.
export function startMock(script) {
  const dir = mkdtempSync(join(tmpdir(), "mc-mock-"));
  const scriptPath = join(dir, "script.json");
  const logPath = join(dir, "served.log");
  writeFileSync(scriptPath, JSON.stringify(script));
  const proc = spawn(process.execPath, [MOCK], {
    env: { ...process.env, MOCK_LLM_SCRIPT: scriptPath, MOCK_LLM_PORT: "0", MOCK_LLM_LOG: logPath },
    stdio: ["ignore", "pipe", "pipe"],
  });
  const cleanup = () => {
    try { proc.kill("SIGKILL"); } catch {}
    try { rmSync(dir, { recursive: true, force: true }); } catch {}
  };
  return new Promise((resolve, reject) => {
    let buf = "";
    const t = setTimeout(() => { cleanup(); reject(new Error("mock did not start in time")); }, 5000);
    proc.stdout.on("data", (d) => {
      buf += d;
      const m = buf.match(/MOCK_LLM_LISTENING (\d+)/);
      if (m) { clearTimeout(t); resolve({ port: Number(m[1]), log: logPath, stop: cleanup }); }
    });
    proc.on("error", (e) => { clearTimeout(t); cleanup(); reject(e); });
  });
}

// Parse the served-request log into structured events. Robust to any content in
// user messages (each line is a JSON object written by the mock).
export function parseServed(servedLog) {
  return servedLog.split("\n").filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return { category: "PARSE_ERROR", raw: l }; } });
}
export function countCategory(servedLog, category) {
  return parseServed(servedLog).filter((e) => e.category === category).length;
}

// Throw if the CLI made more requests than a queue was scripted for (unless the
// test opted in via allowExhausted). This turns an under-scripted / mis-routed
// scenario — which would otherwise pass on the mock's empty fallback — into a
// loud failure, so a green integration test really means the full round ran.
function assertNoExhaustion(servedLog, allowExhausted = []) {
  const bad = parseServed(servedLog).filter((e) => e.exhausted && !allowExhausted.includes(e.category));
  if (bad.length) {
    throw new Error(`mock queue exhausted (under-scripted or unexpected extra request): ${bad.map((e) => e.category).join(", ")}. If intentional (a backstop test), pass allowExhausted: [${[...new Set(bad.map((e) => e.category))].map((c) => `"${c}"`).join(", ")}].`);
  }
}

function makeEnv(mockPort, home) {
  return {
    ...process.env,
    HOME: home, USERPROFILE: home, XDG_CONFIG_HOME: join(home, ".config"),
    FORCE_COLOR: "", NO_COLOR: "1",
    OPENAI_API_KEY: "test",
    OPENAI_BASE_URL: `http://127.0.0.1:${mockPort}`,
    MINI_CLAUDE_MODEL: "mock",
  };
}

function initSandbox(gitInit) {
  const sandbox = mkdtempSync(join(tmpdir(), "mc-cwd-"));
  if (gitInit) {
    const g = (a) => spawnSync("git", a, { cwd: sandbox, stdio: "ignore" });
    g(["init", "-q"]); g(["config", "user.email", "t@t.co"]); g(["config", "user.name", "t"]);
    writeFileSync(join(sandbox, "README.md"), "hi\n");
    g(["add", "-A"]); g(["commit", "-qm", "init"]);
  }
  return sandbox;
}

function spawnCli({ python, pythonBin, args, env, cwd }) {
  let cmd, cmdArgs, spawnEnv = env;
  if (python) {
    cmd = pythonBin; cmdArgs = ["-B", "-m", "mini_claude", ...args];
    spawnEnv = { ...env, PYTHONPATH: PY_DIR };
  } else {
    cmd = process.execPath; cmdArgs = [CLI_JS, ...args];
  }
  // detached so we can kill the whole process group on timeout (tools may spawn).
  return spawn(cmd, cmdArgs, { cwd, env: spawnEnv, stdio: ["pipe", "pipe", "pipe"], detached: true });
}

function killGroup(child) {
  try { process.kill(-child.pid, "SIGKILL"); } catch { try { child.kill("SIGKILL"); } catch {} }
}

/**
 * Bulk mode: pre-load all input lines + "exit", EOF, wait for exit.
 * opts: script, args, stdin[], python, pythonBin, gitInit, timeoutMs, signalAfterMs.
 */
export async function runRepl(opts = {}) {
  const {
    script = {}, args = [], stdin = [], python = false,
    pythonBin = process.env.INTEG_PYTHON || "python3",
    gitInit = false, timeoutMs = 30000, signalAfterMs = 0, allowExhausted = [],
  } = opts;

  const mock = await startMock(script);
  const home = mkdtempSync(join(tmpdir(), "mc-home-"));
  const sandbox = initSandbox(gitInit);
  try {
    const child = spawnCli({ python, pythonBin, args, env: makeEnv(mock.port, home), cwd: sandbox });
    let stdout = "", stderr = "";
    child.stdout.on("data", (d) => { stdout += d; });
    child.stderr.on("data", (d) => { stderr += d; });

    child.stdin.write([...stdin, "exit"].join("\n") + "\n");
    child.stdin.end();

    if (signalAfterMs > 0) setTimeout(() => { try { child.kill("SIGINT"); } catch {} }, signalAfterMs);

    const code = await new Promise((resolve) => {
      const t = setTimeout(() => { killGroup(child); resolve("TIMEOUT"); }, timeoutMs);
      child.on("exit", (c) => { clearTimeout(t); resolve(c); });
    });
    let servedLog = "";
    try { servedLog = readFileSync(mock.log, "utf8"); } catch {}
    assertNoExhaustion(servedLog, allowExhausted);
    return { stdout, stderr, code, servedLog };
  } finally {
    mock.stop();
    try { rmSync(sandbox, { recursive: true, force: true }); } catch {}
    try { rmSync(home, { recursive: true, force: true }); } catch {}
  }
}

/**
 * Interactive expect mode: drive prompt-by-prompt so mid-turn prompts (confirm,
 * plan approval) can be answered. steps: [{ send }, { wait: RegExp, send }, ...].
 * A final "exit" is sent and stdin closed automatically.
 * opts: script, args, steps[], python, pythonBin, gitInit, timeoutMs, stepTimeoutMs.
 */
export async function runReplInteractive(opts = {}) {
  const {
    script = {}, args = [], steps = [], python = false,
    pythonBin = process.env.INTEG_PYTHON || "python3",
    gitInit = false, timeoutMs = 30000, stepTimeoutMs = 8000, allowExhausted = [],
  } = opts;

  const mock = await startMock(script);
  const home = mkdtempSync(join(tmpdir(), "mc-home-"));
  const sandbox = initSandbox(gitInit);
  try {
    const child = spawnCli({ python, pythonBin, args, env: makeEnv(mock.port, home), cwd: sandbox });
    let stdout = "", stderr = "";
    let exited = false, exitCode = null;
    child.stdout.on("data", (d) => { stdout += d; });
    child.stderr.on("data", (d) => { stderr += d; });
    child.on("exit", (c) => { exited = true; exitCode = c; });

    const waitFor = (re) => new Promise((resolve, reject) => {
      const start = Date.now();
      const tick = () => {
        if (re.test(stdout)) return resolve();
        if (exited) return reject(new Error(`process exited before matching ${re}\n--stdout--\n${stdout}`));
        if (Date.now() - start > stepTimeoutMs) return reject(new Error(`timeout waiting for ${re}\n--stdout--\n${stdout}`));
        setTimeout(tick, 25);
      };
      tick();
    });

    try {
      for (const step of steps) {
        if (step.wait) await waitFor(step.wait);
        if (step.send !== undefined && !exited) child.stdin.write(step.send + "\n");
      }
      if (!exited) { child.stdin.write("exit\n"); child.stdin.end(); }
    } catch (e) {
      killGroup(child);
      let servedLog = ""; try { servedLog = readFileSync(mock.log, "utf8"); } catch {}
      return { stdout, stderr, code: "STEP_ERROR", error: String(e), servedLog };
    }

    const code = await new Promise((resolve) => {
      if (exited) return resolve(exitCode);
      const t = setTimeout(() => { killGroup(child); resolve("TIMEOUT"); }, timeoutMs);
      child.on("exit", (c) => { clearTimeout(t); resolve(c); });
    });
    let servedLog = ""; try { servedLog = readFileSync(mock.log, "utf8"); } catch {}
    assertNoExhaustion(servedLog, allowExhausted);
    return { stdout, stderr, code, servedLog };
  } finally {
    mock.stop();
    try { rmSync(sandbox, { recursive: true, force: true }); } catch {}
    try { rmSync(home, { recursive: true, force: true }); } catch {}
  }
}
