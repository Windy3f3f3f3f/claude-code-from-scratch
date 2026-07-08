#!/usr/bin/env node
// Validate the marker integrity of the canonical sources: every #step group is
// closed, no orphan #endstep, no #region left open, region names unique per file.
// A broken marker silently corrupts a generated snapshot, so this fails the build.

import { readFileSync, readdirSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";

const HERE = dirname(fileURLToPath(import.meta.url));
const CANON = join(HERE, "canonical");

const STEP = /^\s*(?:\/\/#|#)step\s+(>=|<=|==|>|<)\s*\d+\s*$/;
const ENDSTEP = /^\s*(?:\/\/#|#)endstep\s*$/;
const REGION = /^\s*(?:\/\/#|#)region\s+(\S+)\s*$/;
const ENDREGION = /^\s*(?:\/\/#|#)endregion\s*$/;

const errors = [];
for (const lang of ["ts", "py"]) {
  const dir = join(CANON, lang);
  for (const file of readdirSync(dir)) {
    const lines = readFileSync(join(dir, file), "utf-8").split("\n");
    // Matches build.mjs: a #step opens a group; further #step lines before
    // #endstep are elif branches (not nested groups); #endstep closes it.
    let inGroup = false, regionOpen = null;
    const regionNames = new Set();
    lines.forEach((line, i) => {
      const at = `${lang}/${file}:${i + 1}`;
      if (STEP.test(line)) inGroup = true;
      else if (ENDSTEP.test(line)) { if (!inGroup) errors.push(`${at}: #endstep without #step`); inGroup = false; }
      else if (REGION.test(line)) {
        const nm = line.match(REGION)[1];
        if (regionOpen) errors.push(`${at}: #region ${nm} opened while ${regionOpen} still open`);
        if (regionNames.has(nm)) errors.push(`${at}: duplicate region name ${nm}`);
        regionNames.add(nm); regionOpen = nm;
      } else if (ENDREGION.test(line)) { if (!regionOpen) errors.push(`${at}: #endregion without #region`); regionOpen = null; }
    });
    if (inGroup) errors.push(`${lang}/${file}: a #step group is not closed`);
    if (regionOpen) errors.push(`${lang}/${file}: region ${regionOpen} not closed`);
  }
}

if (errors.length) { console.error("marker lint FAILED:\n" + errors.map((e) => "  " + e).join("\n")); process.exit(1); }
console.log("marker lint OK");
