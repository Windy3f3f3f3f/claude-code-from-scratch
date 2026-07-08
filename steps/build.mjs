#!/usr/bin/env node
// Generate self-contained, runnable per-chapter snapshots from a single
// annotated source (steps/canonical/). Each snapshot in steps/dist/<step>/ is
// the code exactly as it stands at the end of that chapter — no drift, because
// there is only one source of truth.
//
// Markers in the canonical files (comment leaders // for TS, # for Python):
//   //#step >=2      keep the block below when building step 2 or later
//   //#step ==1      keep only when building step 1
//   //#endstep       close the block
// Consecutive //#step lines before an //#endstep act as if/elif: the first
// branch whose condition matches the target step wins.

import { readFileSync, writeFileSync, mkdirSync, rmSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";

const HERE = dirname(fileURLToPath(import.meta.url));
const CANON = join(HERE, "canonical");
const DIST = join(HERE, "dist");

const STEPS = [
  { n: 1, name: "01-agent-loop" },
  { n: 2, name: "02-tools" },
  { n: 3, name: "03-system-prompt" },
  { n: 4, name: "04-cli-session" },
  { n: 5, name: "05-streaming" },
  { n: 6, name: "06-permissions" },
  { n: 7, name: "07-context" },
  { n: 8, name: "08-memory" },
];

// Each file, and the first step at which it exists.
const FILES = {
  ts: [
    { file: "agent.ts", from: 1 },
    { file: "tools.ts", from: 1 },
    { file: "cli.ts", from: 1 },
    { file: "prompt.ts", from: 3 },
    { file: "session.ts", from: 4 },
    { file: "permissions.ts", from: 6 },
    { file: "context.ts", from: 7 },
    { file: "memory.ts", from: 8 },
  ],
  py: [
    { file: "agent.py", from: 1 },
    { file: "tools.py", from: 1 },
    { file: "__main__.py", from: 1 },
    { file: "prompt.py", from: 3 },
    { file: "session.py", from: 4 },
    { file: "permissions.py", from: 6 },
    { file: "context.py", from: 7 },
    { file: "memory.py", from: 8 },
  ],
};

// Marker leader is //# (TypeScript) or # (Python), then step/endstep.
const MARK = /^\s*(?:\/\/#|#)step\s+(>=|<=|==|>|<)\s*(\d+)\s*$/;
const ENDMARK = /^\s*(?:\/\/#|#)endstep\s*$/;

function condTrue(op, num, k) {
  switch (op) {
    case ">=": return k >= num;
    case "<=": return k <= num;
    case "==": return k === num;
    case ">": return k > num;
    case "<": return k < num;
  }
}

// Resolve #step markers in one file's text for a target step.
function slice(text, k) {
  const out = [];
  let inGroup = false, emitted = false, keep = false;
  for (const line of text.split("\n")) {
    const m = line.match(MARK);
    if (m) {
      if (!inGroup) { inGroup = true; emitted = false; }
      keep = !emitted && condTrue(m[1], Number(m[2]), k);
      if (keep) emitted = true;
      continue; // marker lines are never emitted
    }
    if (ENDMARK.test(line)) { inGroup = false; keep = false; continue; }
    if (!inGroup || keep) out.push(line);
  }
  return out.join("\n");
}

rmSync(DIST, { recursive: true, force: true });
let count = 0;
for (const step of STEPS) {
  for (const lang of ["ts", "py"]) {
    for (const { file, from } of FILES[lang]) {
      if (from > step.n) continue;
      const src = readFileSync(join(CANON, lang, file), "utf-8");
      const outPath = join(DIST, step.name, lang, file);
      mkdirSync(dirname(outPath), { recursive: true });
      writeFileSync(outPath, slice(src, step.n));
      count++;
    }
    // TS steps need module resolution; emit a minimal package.json so Node
    // treats .js output as ESM and resolves @anthropic-ai/sdk from the repo.
    if (lang === "ts") {
      writeFileSync(
        join(DIST, step.name, "ts", "package.json"),
        JSON.stringify({ type: "module" }, null, 2) + "\n"
      );
    }
  }
}
console.log(`Generated ${count} files across ${STEPS.length} steps into steps/dist/`);
