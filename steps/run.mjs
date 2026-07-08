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

const STEP_INFO = {
  1: "agent loop — talk to the model and call one tool (read_file)",
  2: "tools — read, write, edit, list, grep, run shell",
  3: "system prompt — behave like a coding agent",
};

const args = process.argv.slice(2);
const flag = (f) => args.includes(f);
const stepArg = args.find((a) => /^\d+$/.test(a));
const dashDash = args.indexOf("--");
const promptArgs = dashDash >= 0 ? args.slice(dashDash + 1) : [];
const usePy = flag("--py");

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

// --- --diff: what this chapter changed vs the previous one ---
if (flag("--diff")) {
  const prev = nameOf(n - 1);
  if (!prev) { console.log(`Step ${n} is the first step — nothing to diff.`); process.exit(0); }
  const lang = usePy ? "py" : "ts";
  const r = spawnSync("git", ["--no-pager", "diff", "--no-index", "--",
    join(DIST, prev, lang), join(DIST, name, lang)], { stdio: "inherit" });
  process.exit(r.status === 1 ? 0 : (r.status ?? 0)); // git diff exits 1 when there are differences
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
const scenario = JSON.parse(readFileSync(join(SCEN, map[String(n)] + ".json"), "utf-8"));
const workdir = mkdtempSync(join(tmpdir(), `stepdemo-${n}-`));
for (const [f, c] of Object.entries(scenario.setup?.files || {})) { const p = join(workdir, f); mkdirSync(dirname(p), { recursive: true }); writeFileSync(p, c); }

console.log(`▶ step ${n} demo (no API key — local mock model)`);
console.log(`  you: ${scenario.prompt}\n`);

if (usePy) {
  const env = { ...process.env, MOCK_DEMO: "1" };
  for (const k of ["http_proxy", "https_proxy", "all_proxy"]) delete env[k];
  const r = spawnSync(join(REPO, ".venv", "bin", "python"), [join(HERE, "_pydriver.py"), join(DIST, name, "py"), join(SCEN, map[String(n)] + ".json"), join(workdir, "_events.jsonl"), workdir], { stdio: "inherit", env });
  process.exit(r.status ?? 0);
}

// TS demo: in-process mock + the step's real Agent.
const tsDir = join(DIST, name, "ts");
const tsc = join(REPO, "node_modules", ".bin", "tsc");
const b = spawnSync(tsc, ["--module", "nodenext", "--moduleResolution", "nodenext", "--target", "es2022", "--skipLibCheck", "--outDir", tsDir, join(tsDir, "agent.ts")], { encoding: "utf-8" });
if (b.status !== 0) { console.error(b.stdout + b.stderr); process.exit(1); }
const mock = await startMock({ scenario, logPath: join(workdir, "_events.jsonl") });
process.env.ANTHROPIC_BASE_URL = mock.url; process.env.ANTHROPIC_API_KEY = "test";
process.chdir(workdir);
const mod = await import(pathToFileURL(join(tsDir, "agent.js")).href);
await new mod.Agent().chat(scenario.prompt);
await mock.close();
process.exit(0);
