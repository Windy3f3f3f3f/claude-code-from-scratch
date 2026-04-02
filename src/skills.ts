// Skills system — discover, parse, and execute .claude/skills/*/SKILL.md
// Mirrors Claude Code's skill architecture: frontmatter metadata + prompt templates.

import { readFileSync, existsSync, readdirSync, statSync } from "fs";
import { join, basename } from "path";
import { homedir } from "os";
import { parseFrontmatter } from "./frontmatter.js";

// ─── Types ──────────────────────────────────────────────────

export interface SkillDefinition {
  name: string;
  description: string;
  whenToUse?: string;
  allowedTools?: string[];
  userInvocable: boolean;
  context: "inline" | "fork";   // inline = inject into conversation, fork = run in sub-agent
  promptTemplate: string;
  source: "project" | "user";
  skillDir: string;
}

// ─── Discovery ──────────────────────────────────────────────

let cachedSkills: SkillDefinition[] | null = null;

export function discoverSkills(): SkillDefinition[] {
  if (cachedSkills) return cachedSkills;

  const skills = new Map<string, SkillDefinition>();

  // User-level skills (lower priority)
  const userDir = join(homedir(), ".claude", "skills");
  loadSkillsFromDir(userDir, "user", skills);

  // Project-level skills (higher priority, overwrites user-level)
  const projectDir = join(process.cwd(), ".claude", "skills");
  loadSkillsFromDir(projectDir, "project", skills);

  cachedSkills = Array.from(skills.values());
  return cachedSkills;
}

function loadSkillsFromDir(
  baseDir: string,
  source: "project" | "user",
  skills: Map<string, SkillDefinition>
): void {
  if (!existsSync(baseDir)) return;
  let entries: string[];
  try {
    entries = readdirSync(baseDir);
  } catch { return; }

  for (const entry of entries) {
    const skillDir = join(baseDir, entry);
    try {
      if (!statSync(skillDir).isDirectory()) continue;
    } catch { continue; }
    const skillFile = join(skillDir, "SKILL.md");
    if (!existsSync(skillFile)) continue;

    const skill = parseSkillFile(skillFile, source, skillDir);
    if (skill) skills.set(skill.name, skill);
  }
}

function parseSkillFile(
  filePath: string,
  source: "project" | "user",
  skillDir: string
): SkillDefinition | null {
  try {
    const raw = readFileSync(filePath, "utf-8");
    const { meta, body } = parseFrontmatter(raw);

    const name = meta.name || basename(skillDir) || "unknown";
    const userInvocable = meta["user-invocable"] !== "false";
    const context = meta.context === "fork" ? "fork" as const : "inline" as const;

    // Parse allowed-tools (comma or JSON array format)
    let allowedTools: string[] | undefined;
    if (meta["allowed-tools"]) {
      const raw = meta["allowed-tools"];
      if (raw.startsWith("[")) {
        try { allowedTools = JSON.parse(raw); } catch {
          allowedTools = raw.replace(/[\[\]]/g, "").split(",").map((s) => s.trim());
        }
      } else {
        allowedTools = raw.split(",").map((s) => s.trim());
      }
    }

    return {
      name,
      description: meta.description || "",
      whenToUse: meta.when_to_use || meta["when-to-use"],
      allowedTools,
      userInvocable,
      context,
      promptTemplate: body,
      source,
      skillDir,
    };
  } catch {
    return null;
  }
}

// ─── Resolution ─────────────────────────────────────────────

export function getSkillByName(name: string): SkillDefinition | null {
  return discoverSkills().find((s) => s.name === name) || null;
}

export function resolveSkillPrompt(skill: SkillDefinition, args: string): string {
  let prompt = skill.promptTemplate;
  // Replace $ARGUMENTS and ${ARGUMENTS}
  prompt = prompt.replace(/\$ARGUMENTS|\$\{ARGUMENTS\}/g, args);
  // Replace ${CLAUDE_SKILL_DIR}
  prompt = prompt.replace(/\$\{CLAUDE_SKILL_DIR\}/g, skill.skillDir);
  return prompt;
}

export function executeSkill(
  skillName: string,
  args: string
): { prompt: string; allowedTools?: string[]; context: "inline" | "fork" } | null {
  const skill = getSkillByName(skillName);
  if (!skill) return null;
  return {
    prompt: resolveSkillPrompt(skill, args),
    allowedTools: skill.allowedTools,
    context: skill.context,
  };
}

// ─── System prompt section ──────────────────────────────────

export function buildSkillDescriptions(): string {
  const skills = discoverSkills();
  if (skills.length === 0) return "";

  const lines = ["# Available Skills", ""];
  const invocable = skills.filter((s) => s.userInvocable);
  const autoOnly = skills.filter((s) => !s.userInvocable);

  if (invocable.length > 0) {
    lines.push("User-invocable skills (user types /<name> to invoke):");
    for (const s of invocable) {
      lines.push(`- **/${s.name}**: ${s.description}`);
      if (s.whenToUse) lines.push(`  When to use: ${s.whenToUse}`);
    }
    lines.push("");
  }

  if (autoOnly.length > 0) {
    lines.push("Auto-invocable skills (use the skill tool when appropriate):");
    for (const s of autoOnly) {
      lines.push(`- **${s.name}**: ${s.description}`);
      if (s.whenToUse) lines.push(`  When to use: ${s.whenToUse}`);
    }
    lines.push("");
  }

  lines.push(
    "To invoke a skill programmatically, use the `skill` tool with the skill name and optional arguments."
  );
  return lines.join("\n");
}

// Reset cache (useful for testing)
export function resetSkillCache(): void {
  cachedSkills = null;
}
