import { readFileSync, writeFileSync, existsSync, mkdirSync, readdirSync, statSync } from "fs";
import { execSync, execFileSync } from "child_process";
import { glob } from "glob";
import { dirname, join, basename, extname } from "path";
import { homedir } from "os";

const isWin = process.platform === "win32";
import { getMemoryDir } from "./memory.js";
import type Anthropic from "@anthropic-ai/sdk";
// Note: skill execution is handled in agent.ts (supports fork mode)

// ─── Permission modes ──────────────────────────────────────
// Mirrors Claude Code's 5 external permission modes.

export type PermissionMode = "default" | "plan" | "acceptEdits" | "bypassPermissions" | "dontAsk";

const READ_TOOLS = new Set(["read_file", "list_files", "grep_search"]);
const EDIT_TOOLS = new Set(["write_file", "edit_file"]);

// Tool definition type for Claude API
export type ToolDef = Anthropic.Tool;

// ─── Tool definitions ───────────────────────────────────────

export const toolDefinitions: ToolDef[] = [
  {
    name: "read_file",
    description:
      "Read the contents of a file. Returns the file content with line numbers.",
    input_schema: {
      type: "object" as const,
      properties: {
        file_path: {
          type: "string",
          description: "The path to the file to read",
        },
      },
      required: ["file_path"],
    },
  },
  {
    name: "write_file",
    description:
      "Write content to a file. Creates the file if it doesn't exist, overwrites if it does.",
    input_schema: {
      type: "object" as const,
      properties: {
        file_path: {
          type: "string",
          description: "The path to the file to write",
        },
        content: {
          type: "string",
          description: "The content to write to the file",
        },
      },
      required: ["file_path", "content"],
    },
  },
  {
    name: "edit_file",
    description:
      "Edit a file by replacing an exact string match with new content. The old_string must match exactly (including whitespace and indentation).",
    input_schema: {
      type: "object" as const,
      properties: {
        file_path: {
          type: "string",
          description: "The path to the file to edit",
        },
        old_string: {
          type: "string",
          description: "The exact string to find and replace",
        },
        new_string: {
          type: "string",
          description: "The string to replace it with",
        },
      },
      required: ["file_path", "old_string", "new_string"],
    },
  },
  {
    name: "list_files",
    description:
      "List files matching a glob pattern. Returns matching file paths.",
    input_schema: {
      type: "object" as const,
      properties: {
        pattern: {
          type: "string",
          description:
            'Glob pattern to match files (e.g., "**/*.ts", "src/**/*")',
        },
        path: {
          type: "string",
          description:
            "Base directory to search from. Defaults to current directory.",
        },
      },
      required: ["pattern"],
    },
  },
  {
    name: "grep_search",
    description:
      "Search for a pattern in files. Returns matching lines with file paths and line numbers.",
    input_schema: {
      type: "object" as const,
      properties: {
        pattern: {
          type: "string",
          description: "The regex pattern to search for",
        },
        path: {
          type: "string",
          description: "Directory or file to search in. Defaults to current directory.",
        },
        include: {
          type: "string",
          description:
            'File glob pattern to include (e.g., "*.ts", "*.py")',
        },
      },
      required: ["pattern"],
    },
  },
  {
    name: "run_shell",
    description:
      "Execute a shell command and return its output. Use this for running tests, installing packages, git operations, etc.",
    input_schema: {
      type: "object" as const,
      properties: {
        command: {
          type: "string",
          description: "The shell command to execute",
        },
        timeout: {
          type: "number",
          description: "Timeout in milliseconds (default: 30000)",
        },
      },
      required: ["command"],
    },
  },
  // ─── Skill tool ─────────────────────────────────────────────
  {
    name: "skill",
    description:
      "Invoke a registered skill by name. Skills are prompt templates loaded from .claude/skills/. Returns the skill's resolved prompt to follow.",
    input_schema: {
      type: "object" as const,
      properties: {
        skill_name: {
          type: "string",
          description: "The name of the skill to invoke",
        },
        args: {
          type: "string",
          description: "Optional arguments to pass to the skill",
        },
      },
      required: ["skill_name"],
    },
  },
  // ─── Agent tool ─────────────────────────────────────────────
  {
    name: "agent",
    description:
      "Launch a sub-agent to handle a task autonomously. Sub-agents have isolated context and return their result. Types: 'explore' (read-only, fast search), 'plan' (read-only, structured planning), 'general' (full tools).",
    input_schema: {
      type: "object" as const,
      properties: {
        description: {
          type: "string",
          description: "Short (3-5 word) description of the sub-agent's task",
        },
        prompt: {
          type: "string",
          description: "Detailed task instructions for the sub-agent",
        },
        type: {
          type: "string",
          enum: ["explore", "plan", "general"],
          description: "Agent type: explore (read-only), plan (planning), general (full tools). Default: general",
        },
      },
      required: ["description", "prompt"],
    },
  },
];

// ─── Tool execution ─────────────────────────────────────────

function readFile(input: { file_path: string }): string {
  try {
    const content = readFileSync(input.file_path, "utf-8");
    const lines = content.split("\n");
    const numbered = lines
      .map((line, i) => `${String(i + 1).padStart(4)} | ${line}`)
      .join("\n");
    return numbered;
  } catch (e: any) {
    return `Error reading file: ${e.message}`;
  }
}

function writeFile(input: { file_path: string; content: string }): string {
  try {
    const dir = dirname(input.file_path);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    writeFileSync(input.file_path, input.content);
    // Auto-update memory index when writing to memory directory
    autoUpdateMemoryIndex(input.file_path);
    // Return content preview for UI display
    const lines = input.content.split("\n");
    const lineCount = lines.length;
    const preview = lines.slice(0, 30).map((l, i) =>
      `${String(i + 1).padStart(4)} | ${l}`
    ).join("\n");
    const truncNote = lineCount > 30 ? `\n  ... (${lineCount} lines total)` : "";
    return `Successfully wrote to ${input.file_path} (${lineCount} lines)\n\n${preview}${truncNote}`;
  } catch (e: any) {
    return `Error writing file: ${e.message}`;
  }
}

function autoUpdateMemoryIndex(filePath: string): void {
  try {
    const memDir = getMemoryDir();
    if (filePath.startsWith(memDir) && filePath.endsWith(".md") && !filePath.endsWith("MEMORY.md")) {
      // Re-import dynamically to avoid circular — but we already import getMemoryDir
      // Rebuild the index from all memory files
      const { readdirSync } = require("fs");
      const files = readdirSync(memDir).filter(
        (f: string) => f.endsWith(".md") && f !== "MEMORY.md"
      );
      const lines = ["# Memory Index", ""];
      for (const file of files) {
        try {
          const raw = readFileSync(join(memDir, file), "utf-8");
          const nameMatch = raw.match(/^name:\s*(.+)$/m);
          const typeMatch = raw.match(/^type:\s*(.+)$/m);
          const descMatch = raw.match(/^description:\s*(.+)$/m);
          if (nameMatch && typeMatch) {
            lines.push(`- **[${nameMatch[1].trim()}](${file})** (${typeMatch[1].trim()}) — ${descMatch?.[1]?.trim() || ""}`);
          }
        } catch { /* skip */ }
      }
      writeFileSync(join(memDir, "MEMORY.md"), lines.join("\n"));
    }
  } catch { /* non-critical */ }
}

// ─── Edit helpers: quote normalization + diff ───────────────

function normalizeQuotes(s: string): string {
  return s
    .replace(/[\u2018\u2019\u2032]/g, "'")   // curly single quotes, prime
    .replace(/[\u201C\u201D\u2033]/g, '"');   // curly double quotes, double prime
}

function findActualString(fileContent: string, searchString: string): string | null {
  // Direct match first (cheapest)
  if (fileContent.includes(searchString)) return searchString;
  // Try with normalized quotes
  const normSearch = normalizeQuotes(searchString);
  const normFile = normalizeQuotes(fileContent);
  const idx = normFile.indexOf(normSearch);
  if (idx !== -1) return fileContent.substring(idx, idx + searchString.length);
  return null;
}

function generateDiff(
  oldContent: string, _newContent: string,
  oldString: string, newString: string
): string {
  const beforeChange = oldContent.split(oldString)[0];
  const lineNum = (beforeChange.match(/\n/g) || []).length + 1;
  const oldLines = oldString.split("\n");
  const newLines = newString.split("\n");

  const parts: string[] = [`@@ -${lineNum},${oldLines.length} +${lineNum},${newLines.length} @@`];
  // Show removed lines
  for (const l of oldLines) parts.push(`- ${l}`);
  // Show added lines
  for (const l of newLines) parts.push(`+ ${l}`);

  return parts.join("\n");
}

function editFile(input: {
  file_path: string;
  old_string: string;
  new_string: string;
}): string {
  try {
    const content = readFileSync(input.file_path, "utf-8");

    // Find the actual string (with quote normalization fallback)
    const actual = findActualString(content, input.old_string);
    if (!actual) {
      return `Error: old_string not found in ${input.file_path}`;
    }

    const count = content.split(actual).length - 1;
    if (count > 1)
      return `Error: old_string found ${count} times in ${input.file_path}. Must be unique.`;

    // Use split/join to avoid $ special chars in String.replace()
    const newContent = content.split(actual).join(input.new_string);
    writeFileSync(input.file_path, newContent);

    // Generate diff for result
    const diff = generateDiff(content, newContent, actual, input.new_string);
    const quoteNote = actual !== input.old_string ? " (matched via quote normalization)" : "";
    return `Successfully edited ${input.file_path}${quoteNote}\n\n${diff}`;
  } catch (e: any) {
    return `Error editing file: ${e.message}`;
  }
}

async function listFiles(input: {
  pattern: string;
  path?: string;
}): Promise<string> {
  try {
    const files = await glob(input.pattern, {
      cwd: input.path || process.cwd(),
      nodir: true,
      ignore: ["node_modules/**", ".git/**"],
    });
    if (files.length === 0) return "No files found matching the pattern.";
    return files.slice(0, 200).join("\n") +
      (files.length > 200 ? `\n... and ${files.length - 200} more` : "");
  } catch (e: any) {
    return `Error listing files: ${e.message}`;
  }
}

function grepSearch(input: {
  pattern: string;
  path?: string;
  include?: string;
}): string {
  // Try system grep first (available on Linux/macOS and Windows with Git in PATH)
  if (!isWin) {
    try {
      const args = ["--line-number", "--color=never", "-r"];
      if (input.include) args.push(`--include=${input.include}`);
      args.push("--", input.pattern);
      args.push(input.path || ".");
      const result = execFileSync("grep", args, {
        encoding: "utf-8",
        maxBuffer: 1024 * 1024,
        timeout: 10000,
      });
      const lines = result.split("\n").filter(Boolean);
      return lines.slice(0, 100).join("\n") +
        (lines.length > 100 ? `\n... and ${lines.length - 100} more matches` : "");
    } catch (e: any) {
      if (e.status === 1) return "No matches found.";
      return `Error: ${e.message}`;
    }
  }
  // Pure JS fallback for Windows
  return grepJS(input.pattern, input.path || ".", input.include);
}

function grepJS(pattern: string, dir: string, include?: string): string {
  const re = new RegExp(pattern);
  const includeRe = include ? new RegExp(include.replace(/\*/g, ".*").replace(/\?/g, ".")) : null;
  const matches: string[] = [];
  function walk(d: string) {
    if (matches.length >= 200) return;
    let entries: string[];
    try { entries = readdirSync(d); } catch { return; }
    for (const name of entries) {
      if (name.startsWith(".") || name === "node_modules") continue;
      const full = join(d, name);
      let st;
      try { st = statSync(full); } catch { continue; }
      if (st.isDirectory()) { walk(full); continue; }
      if (includeRe && !includeRe.test(name)) continue;
      try {
        const text = readFileSync(full, "utf-8");
        const lines = text.split("\n");
        for (let i = 0; i < lines.length; i++) {
          if (re.test(lines[i])) {
            matches.push(`${full}:${i + 1}:${lines[i]}`);
            if (matches.length >= 200) return;
          }
        }
      } catch {}
    }
  }
  walk(dir);
  if (matches.length === 0) return "No matches found.";
  const shown = matches.slice(0, 100);
  return shown.join("\n") +
    (matches.length > 100 ? `\n... and ${matches.length - 100} more matches` : "");
}

function runShell(input: { command: string; timeout?: number }): string {
  try {
    const result = execSync(input.command, {
      encoding: "utf-8",
      maxBuffer: 5 * 1024 * 1024,
      timeout: input.timeout || 30000,
      stdio: ["pipe", "pipe", "pipe"],
      shell: isWin ? "powershell.exe" : "/bin/sh",
    });
    return result || "(no output)";
  } catch (e: any) {
    const stderr = e.stderr ? `\nStderr: ${e.stderr}` : "";
    const stdout = e.stdout ? `\nStdout: ${e.stdout}` : "";
    return `Command failed (exit code ${e.status})${stdout}${stderr}`;
  }
}

// ─── Dangerous command patterns ─────────────────────────────

const DANGEROUS_PATTERNS = [
  /\brm\s/,
  /\bgit\s+(push|reset|clean|checkout\s+\.)/,
  /\bsudo\b/,
  /\bmkfs\b/,
  /\bdd\s/,
  />\s*\/dev\//,
  /\bkill\b/,
  /\bpkill\b/,
  /\breboot\b/,
  /\bshutdown\b/,
  // Windows dangerous commands
  /\bdel\s/i,
  /\brmdir\s/i,
  /\bformat\s/i,
  /\btaskkill\s/i,
  /\bRemove-Item\s/i,
  /\bStop-Process\s/i,
];

export function isDangerous(command: string): boolean {
  return DANGEROUS_PATTERNS.some((p) => p.test(command));
}

// ─── Permission rules (.claude/settings.json) ───────────────

interface ParsedRule {
  tool: string;
  pattern: string | null;
}

interface PermissionRules {
  allow: ParsedRule[];
  deny: ParsedRule[];
}

let cachedRules: PermissionRules | null = null;

function parseRule(rule: string): ParsedRule {
  const match = rule.match(/^([a-z_]+)\((.+)\)$/);
  if (match) {
    return { tool: match[1], pattern: match[2] };
  }
  return { tool: rule, pattern: null };
}

function loadSettings(filePath: string): any {
  if (!existsSync(filePath)) return null;
  try {
    return JSON.parse(readFileSync(filePath, "utf-8"));
  } catch { return null; }
}

export function loadPermissionRules(): PermissionRules {
  if (cachedRules) return cachedRules;

  const allow: ParsedRule[] = [];
  const deny: ParsedRule[] = [];

  // Load from user-level settings (~/.claude/settings.json)
  const userSettings = loadSettings(join(homedir(), ".claude", "settings.json"));
  // Load from project-level settings (.claude/settings.json)
  const projectSettings = loadSettings(join(process.cwd(), ".claude", "settings.json"));

  for (const settings of [userSettings, projectSettings]) {
    if (!settings?.permissions) continue;
    if (Array.isArray(settings.permissions.allow)) {
      for (const r of settings.permissions.allow) allow.push(parseRule(r));
    }
    if (Array.isArray(settings.permissions.deny)) {
      for (const r of settings.permissions.deny) deny.push(parseRule(r));
    }
  }

  cachedRules = { allow, deny };
  return cachedRules;
}

function matchesRule(rule: ParsedRule, toolName: string, input: Record<string, any>): boolean {
  if (rule.tool !== toolName) return false;
  if (!rule.pattern) return true; // Matches all invocations of this tool

  // Get the value to match against
  let value = "";
  if (toolName === "run_shell") value = input.command || "";
  else if (input.file_path) value = input.file_path;
  else return true; // No specific value, tool name match is enough

  const pattern = rule.pattern;
  // Wildcard matching: pattern ending with * is prefix match
  if (pattern.endsWith("*")) {
    return value.startsWith(pattern.slice(0, -1));
  }
  return value === pattern;
}

function checkPermissionRules(
  toolName: string,
  input: Record<string, any>
): "allow" | "deny" | null {
  const rules = loadPermissionRules();

  // Deny rules checked first (higher priority)
  for (const rule of rules.deny) {
    if (matchesRule(rule, toolName, input)) return "deny";
  }
  // Then allow rules
  for (const rule of rules.allow) {
    if (matchesRule(rule, toolName, input)) return "allow";
  }
  return null; // No matching rule, fall through to default logic
}

// ─── Unified permission check ───────────────────────────────
// Returns: { action, message? }
//   - allow: proceed without confirmation
//   - deny: block the tool call
//   - confirm: ask user for approval (message is the description)

export function checkPermission(
  toolName: string,
  input: Record<string, any>,
  mode: PermissionMode = "default"
): { action: "allow" | "deny" | "confirm"; message?: string } {
  // bypassPermissions (--yolo): allow everything
  if (mode === "bypassPermissions") return { action: "allow" };

  // Step 1: Check permission rules from settings (deny rules override even modes)
  const ruleResult = checkPermissionRules(toolName, input);
  if (ruleResult === "deny") {
    return { action: "deny", message: `Denied by permission rule for ${toolName}` };
  }
  if (ruleResult === "allow") {
    return { action: "allow" };
  }

  // Step 2: Mode-specific logic
  // Read tools are always allowed in all modes
  if (READ_TOOLS.has(toolName)) return { action: "allow" };

  // plan mode: block all write/edit tools (prompt alone is not enough)
  if (mode === "plan" && EDIT_TOOLS.has(toolName)) {
    return { action: "deny", message: `Blocked in plan mode: ${toolName}` };
  }

  // acceptEdits: auto-approve file writes/edits
  if (mode === "acceptEdits" && EDIT_TOOLS.has(toolName)) {
    return { action: "allow" };
  }

  // Step 3: Built-in dangerous pattern checks
  let needsConfirm = false;
  let confirmMessage = "";

  if (toolName === "run_shell" && isDangerous(input.command)) {
    needsConfirm = true;
    confirmMessage = input.command;
  } else if (toolName === "write_file" && !existsSync(input.file_path)) {
    needsConfirm = true;
    confirmMessage = `write new file: ${input.file_path}`;
  } else if (toolName === "edit_file" && !existsSync(input.file_path)) {
    needsConfirm = true;
    confirmMessage = `edit non-existent file: ${input.file_path}`;
  }

  if (needsConfirm) {
    // dontAsk: auto-deny anything that would need confirmation (for CI / non-interactive)
    if (mode === "dontAsk") {
      return { action: "deny", message: `Auto-denied (dontAsk mode): ${confirmMessage}` };
    }
    return { action: "confirm", message: confirmMessage };
  }

  return { action: "allow" };
}

// Legacy exports for backward compatibility
export function needsConfirmation(
  toolName: string,
  input: Record<string, any>
): string | null {
  const result = checkPermission(toolName, input);
  if (result.action === "confirm") return result.message || null;
  return null;
}

// ─── Truncate long tool results ─────────────────────────────

const MAX_RESULT_CHARS = 50000;

function truncateResult(result: string): string {
  if (result.length <= MAX_RESULT_CHARS) return result;
  const keepEach = Math.floor((MAX_RESULT_CHARS - 60) / 2);
  return (
    result.slice(0, keepEach) +
    "\n\n[... truncated " +
    (result.length - keepEach * 2) +
    " chars ...]\n\n" +
    result.slice(-keepEach)
  );
}

// ─── Execute a tool call ────────────────────────────────────
// The "agent" tool is handled in agent.ts to avoid circular deps.

export async function executeTool(
  name: string,
  input: Record<string, any>
): Promise<string> {
  let result: string;
  switch (name) {
    case "read_file":
      result = readFile(input as { file_path: string });
      break;
    case "write_file":
      result = writeFile(input as { file_path: string; content: string });
      break;
    case "edit_file":
      result = editFile(
        input as { file_path: string; old_string: string; new_string: string }
      );
      break;
    case "list_files":
      result = await listFiles(input as { pattern: string; path?: string });
      break;
    case "grep_search":
      result = grepSearch(
        input as { pattern: string; path?: string; include?: string }
      );
      break;
    case "run_shell":
      result = runShell(input as { command: string; timeout?: number });
      break;
    // "skill" and "agent" are handled in agent.ts (to support fork mode and avoid circular deps)
    default:
      return `Unknown tool: ${name}`;
  }
  return truncateResult(result);
}

// Reset permission cache (for testing)
export function resetPermissionCache(): void {
  cachedRules = null;
}
