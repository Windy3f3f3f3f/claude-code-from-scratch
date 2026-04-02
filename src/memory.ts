// Memory system — 4-type file-based memory with MEMORY.md index.
// Mirrors Claude Code's memory architecture (user/feedback/project/reference).

import {
  readFileSync, writeFileSync, existsSync, mkdirSync, readdirSync,
  unlinkSync, statSync,
} from "fs";
import { join } from "path";
import { homedir } from "os";
import { createHash } from "crypto";
import { parseFrontmatter, formatFrontmatter } from "./frontmatter.js";

// ─── Types ──────────────────────────────────────────────────

export type MemoryType = "user" | "feedback" | "project" | "reference";

export interface MemoryEntry {
  name: string;
  description: string;
  type: MemoryType;
  filename: string;
  content: string;
}

const VALID_TYPES = new Set<MemoryType>(["user", "feedback", "project", "reference"]);
const MAX_INDEX_LINES = 200;
const MAX_INDEX_BYTES = 25000;

// ─── Paths ──────────────────────────────────────────────────

function getProjectHash(): string {
  return createHash("sha256").update(process.cwd()).digest("hex").slice(0, 16);
}

export function getMemoryDir(): string {
  const dir = join(homedir(), ".mini-claude", "projects", getProjectHash(), "memory");
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  return dir;
}

function getIndexPath(): string {
  return join(getMemoryDir(), "MEMORY.md");
}

// ─── Slugify ────────────────────────────────────────────────

function slugify(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_|_$/g, "")
    .slice(0, 40);
}

// ─── CRUD ───────────────────────────────────────────────────

export function listMemories(): MemoryEntry[] {
  const dir = getMemoryDir();
  const files = readdirSync(dir).filter(
    (f) => f.endsWith(".md") && f !== "MEMORY.md"
  );
  const entries: MemoryEntry[] = [];
  for (const file of files) {
    try {
      const raw = readFileSync(join(dir, file), "utf-8");
      const { meta, body } = parseFrontmatter(raw);
      if (!meta.name || !meta.type) continue;
      entries.push({
        name: meta.name,
        description: meta.description || "",
        type: (VALID_TYPES.has(meta.type as MemoryType) ? meta.type : "project") as MemoryType,
        filename: file,
        content: body,
      });
    } catch { /* skip corrupt files */ }
  }
  // Sort by mtime desc
  entries.sort((a, b) => {
    try {
      const statA = statSync(join(dir, a.filename));
      const statB = statSync(join(dir, b.filename));
      return statB.mtimeMs - statA.mtimeMs;
    } catch { return 0; }
  });
  return entries;
}

export function saveMemory(entry: Omit<MemoryEntry, "filename">): string {
  const dir = getMemoryDir();
  const filename = `${entry.type}_${slugify(entry.name)}.md`;
  const content = formatFrontmatter(
    { name: entry.name, description: entry.description, type: entry.type },
    entry.content
  );
  writeFileSync(join(dir, filename), content);
  updateMemoryIndex();
  return filename;
}

export function deleteMemory(filename: string): boolean {
  const filepath = join(getMemoryDir(), filename);
  if (!existsSync(filepath)) return false;
  unlinkSync(filepath);
  updateMemoryIndex();
  return true;
}

// ─── Index ──────────────────────────────────────────────────

function updateMemoryIndex(): void {
  const memories = listMemories();
  const lines = ["# Memory Index", ""];
  for (const m of memories) {
    lines.push(`- **[${m.name}](${m.filename})** (${m.type}) — ${m.description}`);
  }
  writeFileSync(getIndexPath(), lines.join("\n"));
}

export function loadMemoryIndex(): string {
  const indexPath = getIndexPath();
  if (!existsSync(indexPath)) return "";
  let content = readFileSync(indexPath, "utf-8");
  // Truncate to limits (matching Claude Code: 200 lines, 25KB)
  const lines = content.split("\n");
  if (lines.length > MAX_INDEX_LINES) {
    content = lines.slice(0, MAX_INDEX_LINES).join("\n") +
      "\n\n[... truncated, too many memory entries ...]";
  }
  if (Buffer.byteLength(content) > MAX_INDEX_BYTES) {
    content = content.slice(0, MAX_INDEX_BYTES) +
      "\n\n[... truncated, index too large ...]";
  }
  return content;
}

// ─── Recall (keyword matching) ──────────────────────────────

export function recallMemories(query: string, limit = 5): MemoryEntry[] {
  const memories = listMemories();
  if (memories.length === 0) return [];

  // Tokenize query into words
  const queryWords = query.toLowerCase().split(/\s+/).filter((w) => w.length > 2);
  if (queryWords.length === 0) return memories.slice(0, limit);

  // Score each memory by keyword overlap
  const scored = memories.map((m) => {
    const text = `${m.name} ${m.description} ${m.type} ${m.content}`.toLowerCase();
    let score = 0;
    for (const word of queryWords) {
      if (text.includes(word)) score++;
    }
    return { memory: m, score };
  });

  return scored
    .filter((s) => s.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, limit)
    .map((s) => s.memory);
}

// ─── System prompt section ──────────────────────────────────

export function buildMemoryPromptSection(): string {
  const index = loadMemoryIndex();
  const memoryDir = getMemoryDir();

  return `# Memory System

You have a persistent, file-based memory system at \`${memoryDir}\`.

## Memory Types
- **user**: User's role, preferences, knowledge level
- **feedback**: Corrections and guidance from the user (include Why + How to apply)
- **project**: Ongoing work, goals, deadlines, decisions
- **reference**: Pointers to external resources (URLs, tools, dashboards)

## How to Save Memories
Use the write_file tool to create a memory file with YAML frontmatter:

\`\`\`markdown
---
name: memory name
description: one-line description
type: user|feedback|project|reference
---
Memory content here.
\`\`\`

Save to: \`${memoryDir}/\`
Filename format: \`{type}_{slugified_name}.md\`

The MEMORY.md index is auto-updated when you write to the memory directory — do NOT update it manually.

## What NOT to Save
- Code patterns or architecture (read the code instead)
- Git history (use git log)
- Anything already in CLAUDE.md
- Ephemeral task details

## When to Recall
When the user asks you to remember or recall, or when prior context seems relevant.
${index ? `\n## Current Memory Index\n${index}` : "\n(No memories saved yet.)"}`;
}
