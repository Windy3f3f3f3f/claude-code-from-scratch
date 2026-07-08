#!/usr/bin/env node
// Fill code blocks, diffs, and transcripts in the docs FROM the canonical source,
// so the tutorial's code can never drift from the code readers actually run — it
// is generated from the same source. Placeholders (HTML comments) in the .md:
//
//   <!-- @snippet lang=ts file=agent.ts region=loop step=1 -->
//   ```ts
//   ...generated, do not edit...
//   ```
//   <!-- @endsnippet -->
//
//   <!-- @diff file=tools.ts step=2 lang=ts -->  ```diff ... ```  <!-- @enddiff -->
//   <!-- @transcript step=1 lang=ts -->          ``` ... ```      <!-- @endtranscript -->
//
// Usage: node steps/docs-sync.mjs          # write
//        node steps/docs-sync.mjs --check   # fail if any doc is out of date (CI)

import { startMock } from "./mock-anthropic.mjs";
import { existsSync, readFileSync, writeFileSync, readdirSync, mkdirSync, rmSync } from "fs";
import { join, dirname } from "path";
import { pathToFileURL, fileURLToPath } from "url";
import { spawnSync } from "child_process";
import { tmpdir } from "os";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = dirname(HERE);
const DIST = join(HERE, "dist");
const SCEN = join(HERE, "scenarios");
const check = process.argv.includes("--check");

// Always regenerate from canonical, so --check can never compare a stale dist
// (a changed canonical with an old dist would otherwise look "in sync").
const built = spawnSync("node", [join(HERE, "build.mjs")], { stdio: "inherit" });
if (built.status !== 0) { console.error("build.mjs failed"); process.exit(2); }
const stepDirs = readdirSync(DIST).sort();
const stepName = (n) => stepDirs.find((s) => s.startsWith(String(n).padStart(2, "0") + "-"));
const langOf = { ts: "typescript", py: "python" };

const REGION = /^\s*(?:\/\/#|#)region\s+(\S+)\s*$/;
const ENDREGION = /^\s*(?:\/\/#|#)endregion\s*$/;

function extractRegion(file, lang, step, region) {
  const path = join(DIST, stepName(step), lang, file);
  if (!existsSync(path)) throw new Error(`no ${file} at step ${step} (${lang})`);
  const lines = readFileSync(path, "utf-8").split("\n");
  let out = null;
  for (const line of lines) {
    const m = line.match(REGION);
    if (m && m[1] === region) { out = []; continue; }
    if (out && ENDREGION.test(line)) break;
    if (out) out.push(line);
  }
  if (out === null) throw new Error(`region "${region}" not found in ${file} at step ${step} (${lang})`);
  if (!out.length) throw new Error(`region "${region}" is empty in ${file} at step ${step} (${lang})`);
  // dedent by the common leading whitespace
  const indent = Math.min(...out.filter((l) => l.trim()).map((l) => l.match(/^\s*/)[0].length));
  return out.map((l) => l.slice(indent)).join("\n").replace(/\s+$/, "");
}

function diffBlock(file, step, lang) {
  const prev = stepName(step - 1), cur = stepName(step);
  if (!prev) throw new Error(`@diff needs a previous step (step ${step})`);
  const r = spawnSync("git", ["--no-pager", "diff", "--no-index", "--unified=2", "--",
    join(DIST, prev, lang, file), join(DIST, cur, lang, file)], { encoding: "utf-8" });
  // keep only hunks (drop the diff/index/+++/--- header lines so paths/temp don't leak)
  const body = (r.stdout || "").split("\n").filter((l) => /^[-+ @]/.test(l) && !/^(\+\+\+|---)/.test(l)).join("\n");
  return body.trim();
}

function normalizeTranscript(s) {
  return s
    .replace(/\x1b\[[0-9;]*m/g, "")                          // strip ANSI
    .replace(/sandbox: \S+/g, "sandbox: <sandbox>")           // stabilize temp path
    .replace(/\/tmp\/\S*stepdemo\S*/g, "<sandbox>")           // any stray temp path
    .replace(/\d{4}-\d{2}-\d{2}/g, "<date>")                  // stabilize dates
    .replace(/[ \t]+$/gm, "").trim();
}

// The transcript is exactly what a reader sees running the demo command — we
// shell out to run.mjs so it can't diverge from the real thing.
async function transcript(step, lang) {
  const args = [join(HERE, "run.mjs"), String(step)];
  if (lang === "py") args.push("--py");
  const env = { ...process.env, NO_COLOR: "1" };
  for (const k of ["http_proxy", "https_proxy", "all_proxy", "HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY"]) delete env[k];
  const r = spawnSync("node", args, { encoding: "utf-8", env, timeout: 60000 });
  if (r.status !== 0) throw new Error(`run.mjs ${step} ${lang} failed: ${(r.stderr || "").split("\n").slice(-3).join(" | ")}`);
  return normalizeTranscript(`$ node steps/run.mjs ${step}${lang === "py" ? " --py" : ""}\n${r.stdout || ""}`);
}

const PLACEHOLDER = /<!--\s*@(snippet|diff|transcript)\s+([^>]*?)\s*-->/g;
function parseAttrs(s) { const o = {}; for (const m of s.matchAll(/(\w+)=(\S+)/g)) o[m[1]] = m[2]; return o; }

async function blockFor(kind, a) {
  if (kind === "snippet") return "```" + (langOf[a.lang] || a.lang) + "\n" + extractRegion(a.file, a.lang, Number(a.step), a.region) + "\n```";
  if (kind === "diff") return "```diff\n" + diffBlock(a.file, Number(a.step), a.lang) + "\n```";
  return "```\n" + (await transcript(Number(a.step), a.lang)) + "\n```";
}

// Walk placeholders left-to-right with a moving cursor so identical placeholders
// and shifting offsets are handled correctly (indexOf-from-start would clobber).
async function syncFile(path) {
  const original = readFileSync(path, "utf-8");
  let text = original, cursor = 0;
  while (true) {
    PLACEHOLDER.lastIndex = cursor;
    const m = PLACEHOLDER.exec(text);
    if (!m) break;
    const kind = m[1], a = parseAttrs(m[2]);
    const openEnd = m.index + m[0].length;
    const close = `<!-- @end${kind} -->`;
    const closeIdx = text.indexOf(close, openEnd);
    if (closeIdx < 0) throw new Error(`unbalanced @${kind} near offset ${m.index}`);
    const segment = `\n${await blockFor(kind, a)}\n`;
    text = text.slice(0, openEnd) + segment + text.slice(closeIdx);
    cursor = openEnd + segment.length + close.length;
  }
  const changed = text !== original;
  if (changed && !check) writeFileSync(path, text);
  return changed;
}

const docDirs = [join(REPO, "docs"), join(REPO, "en", "docs")];
let changedAny = false;
for (const d of docDirs) {
  if (!existsSync(d)) continue;
  for (const f of readdirSync(d).filter((f) => f.endsWith(".md"))) {
    try { if (await syncFile(join(d, f))) { changedAny = true; console.log(`${check ? "OUT OF DATE" : "synced"}: ${join(d, f).replace(REPO + "/", "")}`); } }
    catch (e) { console.error(`ERROR in ${f}: ${e.message}`); process.exit(2); }
  }
}
if (check && changedAny) { console.error("\ndocs are out of date — run: node steps/docs-sync.mjs"); process.exit(1); }
console.log(check ? "docs in sync" : "docs-sync done");
