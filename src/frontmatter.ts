// Shared YAML frontmatter parser for memory and skills files.
// Handles simple `key: value` pairs between `---` delimiters.

export interface FrontmatterResult {
  meta: Record<string, string>;
  body: string;
}

export function parseFrontmatter(content: string): FrontmatterResult {
  const lines = content.split("\n");
  if (lines[0]?.trim() !== "---") return { meta: {}, body: content };

  let endIdx = -1;
  for (let i = 1; i < lines.length; i++) {
    if (lines[i].trim() === "---") { endIdx = i; break; }
  }
  if (endIdx === -1) return { meta: {}, body: content };

  const meta: Record<string, string> = {};
  for (let i = 1; i < endIdx; i++) {
    const colonIdx = lines[i].indexOf(":");
    if (colonIdx === -1) continue;
    const key = lines[i].slice(0, colonIdx).trim();
    const value = lines[i].slice(colonIdx + 1).trim();
    if (key) meta[key] = value;
  }

  const body = lines.slice(endIdx + 1).join("\n").trim();
  return { meta, body };
}

export function formatFrontmatter(meta: Record<string, string>, body: string): string {
  const lines = ["---"];
  for (const [key, value] of Object.entries(meta)) {
    lines.push(`${key}: ${value}`);
  }
  lines.push("---");
  lines.push("");
  lines.push(body);
  return lines.join("\n");
}
