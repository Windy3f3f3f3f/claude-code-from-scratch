#!/usr/bin/env node
// Verify every step in both languages against the in-process mock — no API key.
// For each step × {ts, py}: run the scenario, then assert the mock event log
// (tool calls), the file side effects, no scenario exhaustion, and TS/Python
// parity on a normalized event log.

import { startMock } from "./mock-anthropic.mjs";
import { existsSync, readFileSync, writeFileSync, mkdirSync, rmSync, readdirSync } from "fs";
import { join, dirname } from "path";
import { pathToFileURL, fileURLToPath } from "url";
import { spawnSync } from "child_process";
import { tmpdir } from "os";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = dirname(HERE);
const DIST = join(HERE, "dist");
const SCEN = join(HERE, "scenarios");
const TSC = join(REPO, "node_modules", ".bin", "tsc");
const VENV_PY = join(REPO, ".venv", "bin", "python");

if (!existsSync(DIST)) spawnSync("node", [join(HERE, "build.mjs")], { stdio: "inherit" });
const map = JSON.parse(readFileSync(join(SCEN, "_map.json"), "utf-8"));
const stepDirs = readdirSync(DIST).sort();
const stepName = (n) => stepDirs.find((s) => s.startsWith(String(n).padStart(2, "0") + "-"));

let scratchN = 0;
const scratch = () => { const d = join(tmpdir(), `steptest-${process.pid}-${scratchN++}`); rmSync(d, { recursive: true, force: true }); mkdirSync(d, { recursive: true }); return d; };
const readLog = (p) => existsSync(p) ? readFileSync(p, "utf-8").split("\n").filter(Boolean).map((l) => JSON.parse(l)) : [];

function setupFiles(scenario, workdir) {
  for (const [name, content] of Object.entries(scenario.setup?.files || {})) {
    const p = join(workdir, name); mkdirSync(dirname(p), { recursive: true }); writeFileSync(p, content);
  }
}

async function runTs(n, scenario, logPath, workdir) {
  const tsDir = join(DIST, stepName(n), "ts");
  const build = spawnSync(TSC, ["--module", "nodenext", "--moduleResolution", "nodenext", "--target", "es2022",
    "--skipLibCheck", "--outDir", tsDir, join(tsDir, "agent.ts")], { encoding: "utf-8" });
  if (build.status !== 0) throw new Error(`tsc failed for step ${n}:\n${build.stdout}${build.stderr}`);
  setupFiles(scenario, workdir);
  const mock = await startMock({ scenario, logPath });
  const prev = { cwd: process.cwd(), base: process.env.ANTHROPIC_BASE_URL, key: process.env.ANTHROPIC_API_KEY, write: process.stdout.write };
  process.env.ANTHROPIC_BASE_URL = mock.url; process.env.ANTHROPIC_API_KEY = "test";
  process.chdir(workdir);
  process.stdout.write = () => true; // silence the agent during tests
  try {
    const mod = await import(pathToFileURL(join(tsDir, "agent.js")).href + `?t=${Date.now()}`);
    await new mod.Agent().chat(scenario.prompt);
  } finally {
    process.stdout.write = prev.write; process.chdir(prev.cwd);
    process.env.ANTHROPIC_BASE_URL = prev.base; process.env.ANTHROPIC_API_KEY = prev.key;
    await mock.close();
  }
}

function runPy(n, scenarioPath, logPath, workdir) {
  const pyDir = join(DIST, stepName(n), "py");
  const env = { ...process.env };
  delete env.http_proxy; delete env.https_proxy; delete env.all_proxy;
  const r = spawnSync(VENV_PY, [join(HERE, "_pydriver.py"), pyDir, scenarioPath, logPath, workdir],
    { encoding: "utf-8", env, timeout: 30000 });
  if (r.status !== 0) throw new Error(`python driver failed for step ${n}:\n${(r.stderr || "").split("\n").slice(-6).join("\n")}`);
}

// Normalize an event log to what must match across languages.
function normalize(log) {
  return JSON.stringify({
    requests: log.filter((e) => e.type === "request").map((e) => ({ tools: e.tools })),
    responses: log.filter((e) => e.type === "response").map((e) => ({ stop_reason: e.stop_reason, tool_use: e.tool_use })),
    exhausted: log.some((e) => e.type === "exhausted"),
  });
}

const fails = [];
function assert(name, cond, detail = "") { console.log(`${cond ? "ok  " : "FAIL"} ${name}${cond ? "" : "  " + detail}`); if (!cond) fails.push(name); }

const steps = Object.keys(map).map(Number).sort((a, b) => a - b);
for (const n of steps) {
  const scenarioPath = join(SCEN, map[String(n)] + ".json");
  const scenario = JSON.parse(readFileSync(scenarioPath, "utf-8"));
  const norms = {};
  for (const lang of ["ts", "py"]) {
    const workdir = scratch();
    const logPath = join(workdir, "_events.jsonl");
    try {
      if (lang === "ts") await runTs(n, scenario, logPath, workdir);
      else { setupFiles(scenario, workdir); runPy(n, scenarioPath, logPath, workdir); }
    } catch (e) { assert(`step${n} ${lang} runs`, false, e.message.split("\n")[0]); continue; }
    const log = readLog(logPath);
    norms[lang] = normalize(log);

    // 1) reached the end without exhausting the scripted scenario
    assert(`step${n} ${lang} not exhausted`, !log.some((e) => e.type === "exhausted"));
    // 2) the scripted tool calls actually happened
    const wantTools = scenario.turns.flatMap((t) => (t.tools || []).map((x) => x.name));
    const gotTools = log.filter((e) => e.type === "response").flatMap((e) => (e.tool_use || []).map((x) => x.name));
    assert(`step${n} ${lang} tool calls [${wantTools.join(",")}]`, JSON.stringify(wantTools) === JSON.stringify(gotTools), `got [${gotTools.join(",")}]`);
    // 3) file side effects
    for (const [name, content] of Object.entries(scenario.assert?.files || {})) {
      const p = join(workdir, name);
      assert(`step${n} ${lang} wrote ${name}`, existsSync(p) && readFileSync(p, "utf-8") === content);
    }
    rmSync(workdir, { recursive: true, force: true });
  }
  // 4) parity
  assert(`step${n} ts/py parity`, norms.ts === norms.py, "event logs differ");
}

console.log(fails.length ? `\nTESTS FAILED (${fails.length}): ${fails.join(", ")}` : `\nALL TESTS PASSED (${steps.length} steps × 2 languages)`);
process.exit(fails.length ? 1 : 0);
