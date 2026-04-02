import { readFileSync, existsSync } from "fs";
import { join, resolve } from "path";
import { execSync } from "child_process";
import * as os from "os";
import { fileURLToPath } from "url";
import { buildMemoryPromptSection } from "./memory.js";
import { buildSkillDescriptions } from "./skills.js";
import { buildAgentDescriptions } from "./subagent.js";

// ─── CLAUDE.md loader ────────────────────────────────────────

export function loadClaudeMd(): string {
  const parts: string[] = [];
  let dir = process.cwd();
  while (true) {
    const file = join(dir, "CLAUDE.md");
    if (existsSync(file)) {
      try {
        parts.unshift(readFileSync(file, "utf-8"));
      } catch {}
    }
    const parent = resolve(dir, "..");
    if (parent === dir) break;
    dir = parent;
  }
  return parts.length > 0
    ? "\n\n# Project Instructions (CLAUDE.md)\n" + parts.join("\n\n---\n\n")
    : "";
}

// ─── Git context ─────────────────────────────────────────────

export function getGitContext(): string {
  try {
    const opts = { encoding: "utf-8" as const, timeout: 3000, stdio: ["pipe", "pipe", "pipe"] as ["pipe", "pipe", "pipe"] };
    const branch = execSync("git rev-parse --abbrev-ref HEAD", opts).trim();
    const log = execSync("git log --oneline -5", opts).trim();
    const status = execSync("git status --short", opts).trim();
    let result = `\nGit branch: ${branch}`;
    if (log) result += `\nRecent commits:\n${log}`;
    if (status) result += `\nGit status:\n${status}`;
    return result;
  } catch {
    return "";
  }
}

// ─── System prompt builder ───────────────────────────────────

export function buildSystemPrompt(): string {
  const __dirname = fileURLToPath(new URL(".", import.meta.url));
  const template = readFileSync(join(__dirname, "system-prompt.md"), "utf-8");

  const date = new Date().toISOString().split("T")[0];
  const platform = `${os.platform()} ${os.arch()}`;
  const shell = process.platform === "win32"
    ? (process.env.ComSpec || "cmd.exe")
    : (process.env.SHELL || "/bin/sh");
  const gitContext = getGitContext();
  const claudeMd = loadClaudeMd();
  const memorySection = buildMemoryPromptSection();
  const skillsSection = buildSkillDescriptions();
  const agentSection = buildAgentDescriptions();

  // Use split/join to replace ALL occurrences and avoid $ special chars
  return template
    .split("{{cwd}}").join(process.cwd())
    .split("{{date}}").join(date)
    .split("{{platform}}").join(platform)
    .split("{{shell}}").join(shell)
    .split("{{git_context}}").join(gitContext)
    .split("{{claude_md}}").join(claudeMd)
    .split("{{memory}}").join(memorySection)
    .split("{{skills}}").join(skillsSection)
    .split("{{agents}}").join(agentSection);
}
