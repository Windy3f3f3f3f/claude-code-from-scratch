#!/usr/bin/env node
// Enter the code state at the end of chapter <N> and run it.
//
//   node steps/run.mjs --list            # steps + what each can do
//   node steps/run.mjs 2                 # DEFAULT: no-key demo (local mock model)
//   node steps/run.mjs 2 --py            # ...in Python
//   node steps/run.mjs 2 --diff          # what chapter 2 added vs chapter 1
//   node steps/run.mjs 2 --live          # real model (needs .env), REPL
//   node steps/run.mjs 2 --live -- "hi"  # real model, one-shot
//
// The demo needs no API key: it runs the step's real Agent against a local mock
// that replays a scripted scenario, so anyone can watch the chapter work.

import { startMock } from "./mock-anthropic.mjs";
import { existsSync, readFileSync, mkdirSync, mkdtempSync, writeFileSync, readdirSync } from "fs";
import { join, dirname } from "path";
import { pathToFileURL, fileURLToPath } from "url";
import { spawnSync } from "child_process";
import { tmpdir } from "os";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = dirname(HERE);
const DIST = join(HERE, "dist");
const SCEN = join(HERE, "scenarios");
// ch12: point the MCP client at the bundled demo server (inherited by child procs).
if (!process.env.MINI_MCP_SERVER) process.env.MINI_MCP_SERVER = join(HERE, "mcp-demo-server.mjs");

const STEP_INFO = {
  1: "agent loop — talk to the model and call one tool (read_file)",
  2: "tools — read, write, edit, list, grep, run shell",
  3: "system prompt — behave like a coding agent",
  4: "CLI & sessions — arg parsing, /clear, save & --resume a conversation",
  5: "streaming — the model call becomes a stream; text appears as it is generated",
  6: "permissions — a gate checks each tool call; dangerous shell commands are blocked",
  7: "context — when the history grows too long, older messages are summarized (compacted)",
  8: "memory — recall facts saved across sessions and inject them into the prompt",
  9: "skills — /name runs a reusable prompt template loaded from a file",
  10: "plan mode — --plan makes the agent read-only; writes and shell are denied",
  11: "multi-agent — the agent tool forks a read-only sub-agent to investigate",
  12: "MCP — connect an external stdio JSON-RPC tool server and call its tools",
  15: "autonomy — /goal keeps working until an evaluator judges the condition met; --auto gates writes with a classifier",
};

const args = process.argv.slice(2);
const flag = (f) => args.includes(f);
const argVal = (f) => { const i = args.indexOf(f); return i >= 0 ? args[i + 1] : undefined; };
const stepArg = args.find((a) => /^\d+$/.test(a));
const dashDash = args.indexOf("--");
const promptArgs = dashDash >= 0 ? args.slice(dashDash + 1) : [];
const usePy = flag("--py");
const caseId = argVal("--case"); // pick a specific scenario for steps with several

if (!existsSync(DIST)) spawnSync("node", [join(HERE, "build.mjs")], { stdio: "inherit" });
const stepDirs = existsSync(DIST) ? readdirSync(DIST).sort() : [];
const nameOf = (n) => stepDirs.find((s) => s.startsWith(String(n).padStart(2, "0") + "-"));

if (flag("--list") || !stepArg) {
  console.log("Steps (node steps/run.mjs <N>):");
  for (const s of stepDirs) console.log(`  ${s.slice(0, 2)}  ${s}  —  ${STEP_INFO[Number(s.slice(0, 2))] || ""}`);
  process.exit(0);
}
const n = Number(stepArg);
const name = nameOf(n);
if (!name) { console.error(`Step ${n} not found. Have: ${stepDirs.join(", ")}`); process.exit(1); }

// --- --diff: what this chapter changed vs the previous one (source only) ---
if (flag("--diff")) {
  // the previous GENERATED step (chapters 13/14 add no code, so ch15 diffs vs ch12)
  let prev = null;
  for (let k = n - 1; k >= 1; k--) { const p = nameOf(k); if (p) { prev = p; break; } }
  if (!prev) { console.log(`Step ${n} is the first step — nothing to diff.`); process.exit(0); }
  const lang = usePy ? "py" : "ts";
  const ext = usePy ? ".py" : ".ts";
  const srcFiles = new Set([...listSrc(join(DIST, prev, lang), ext), ...listSrc(join(DIST, name, lang), ext)]);
  for (const f of [...srcFiles].sort()) {
    // a file new in this chapter has no previous version — diff against /dev/null
    const a = existsSync(join(DIST, prev, lang, f)) ? join(DIST, prev, lang, f) : "/dev/null";
    const b = existsSync(join(DIST, name, lang, f)) ? join(DIST, name, lang, f) : "/dev/null";
    spawnSync("git", ["--no-pager", "diff", "--no-index", "--", a, b], { stdio: "inherit" });
  }
  process.exit(0);
}
function listSrc(dir, ext) {
  try { return readdirSync(dir).filter((f) => f.endsWith(ext)); } catch { return []; }
}

// --- --live: the real model via .env ---
if (flag("--live")) {
  const env = { ...process.env };
  for (const k of ["http_proxy", "https_proxy", "all_proxy", "HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY"]) delete env[k];
  const envFile = join(REPO, ".env");
  if (existsSync(envFile)) for (const line of readFileSync(envFile, "utf-8").split("\n")) {
    const m = line.match(/^\s*([A-Z_][A-Z0-9_]*)\s*=\s*(.*)\s*$/); if (m) env[m[1]] = m[2];
  }
  if (usePy) {
    const r = spawnSync(join(REPO, ".venv", "bin", "python"), [join(DIST, name, "py", "__main__.py"), ...promptArgs], { stdio: "inherit", env, cwd: REPO });
    process.exit(r.status ?? 0);
  }
  const tsDir = join(DIST, name, "ts");
  const tsc = join(REPO, "node_modules", ".bin", "tsc");
  const b = spawnSync(tsc, ["--module", "nodenext", "--moduleResolution", "nodenext", "--target", "es2022", "--skipLibCheck", "--outDir", tsDir, join(tsDir, "cli.ts")], { stdio: "inherit", env });
  if (b.status !== 0) process.exit(b.status ?? 1);
  const r = spawnSync("node", [join(tsDir, "cli.js"), ...promptArgs], { stdio: "inherit", env, cwd: REPO });
  process.exit(r.status ?? 0);
}

// --- default: no-key demo against the local mock ---
const map = JSON.parse(readFileSync(join(SCEN, "_map.json"), "utf-8"));
// A step may map to several scenarios (e.g. ch15); --case picks one, else first.
const mapEntry = map[String(n)];
const confs = Array.isArray(mapEntry) ? mapEntry : [mapEntry];
const conf = caseId ? confs.find((c) => c.scenario === caseId) : confs[0];
if (!conf) { console.error(`Step ${n} has no scenario "${caseId}". Have: ${confs.map((c) => c.scenario).join(", ")}`); process.exit(1); }
const scenarioPath = join(SCEN, conf.scenario + ".json");
const scenario = JSON.parse(readFileSync(scenarioPath, "utf-8"));
const expect = conf.expect || {};
if (promptArgs.length) console.log("(the demo replays a scripted scenario; use --live for your own prompt)\n");
const workdir = mkdtempSync(join(tmpdir(), `stepdemo-${n}-`));
for (const [f, c] of Object.entries(scenario.setup?.files || {})) { const p = join(workdir, f); mkdirSync(dirname(p), { recursive: true }); writeFileSync(p, c); }

console.log(`▶ step ${n} demo (no API key — local mock model)   sandbox: ${workdir}`);
if (scenario.runs) { for (const r of scenario.runs) console.log(`  $ mini-claude ${r.argv.join(" ")}`); console.log(); }
else console.log(`  you: ${scenario.prompt}\n`);

// After the run, show a real check of the side effect so it isn't just talk.
function verify() {
  for (const [f, content] of Object.entries(expect.files || {})) {
    const p = join(workdir, f);
    const ok = existsSync(p) && readFileSync(p, "utf-8") === content;
    console.log(`\n  ✓ verified: ${f} ${ok ? `contains "${content}"` : "MISSING/incorrect"}`);
  }
}

if (usePy) {
  const env = { ...process.env };
  for (const k of ["http_proxy", "https_proxy", "all_proxy", "HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY"]) delete env[k];
  const r = spawnSync(join(REPO, ".venv", "bin", "python"), [join(HERE, "_pydriver.py"), join(DIST, name, "py"), scenarioPath, join(workdir, "_events.jsonl"), workdir], { stdio: "inherit", env });
  verify();
  process.exit(r.status ?? 0);
}

// TS demo: in-process mock + the step's real code (CLI for runs, Agent for chat).
const tsDir = join(DIST, name, "ts");
const tsc = join(REPO, "node_modules", ".bin", "tsc");
const entry = scenario.runs ? "cli.ts" : "agent.ts";
const b = spawnSync(tsc, ["--module", "nodenext", "--moduleResolution", "nodenext", "--target", "es2022", "--skipLibCheck", "--outDir", tsDir, join(tsDir, entry)], { encoding: "utf-8" });
if (b.status !== 0) { console.error(b.stdout + b.stderr); process.exit(1); }
const mock = await startMock({ scenario, logPath: join(workdir, "_events.jsonl") });
process.env.ANTHROPIC_BASE_URL = mock.url; process.env.ANTHROPIC_API_KEY = "test";
process.chdir(workdir);
if (scenario.runs) {
  const mod = await import(pathToFileURL(join(tsDir, "cli.js")).href);
  for (const r of scenario.runs) await mod.runCli(r.argv);
} else {
  const mod = await import(pathToFileURL(join(tsDir, "agent.js")).href);
  await new mod.Agent().chat(scenario.prompt);
}
await mock.close();
verify();
process.exit(0);
