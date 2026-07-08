import { readdirSync, readFileSync, existsSync } from "fs";
import { join } from "path";

// Cross-session memory: small facts saved as files under .mini-memory/. Before
// each turn we recall the ones relevant to what the user asked and drop them
// into the system prompt. Recall is deterministic keyword overlap — no model
// call, no embeddings — enough to see the mechanism.
const MEMORY_DIR = join(process.cwd(), ".mini-memory");

//#region recall
export function recallMemories(query: string): string {
  if (!existsSync(MEMORY_DIR)) return "";
  const queryWords = new Set(query.toLowerCase().split(/\W+/).filter((w) => w.length > 2));

  const scored: { text: string; score: number }[] = [];
  for (const file of readdirSync(MEMORY_DIR).filter((f) => f.endsWith(".md"))) {
    const text = readFileSync(join(MEMORY_DIR, file), "utf-8").trim();
    const words = new Set(text.toLowerCase().split(/\W+/));
    let score = 0;
    for (const w of queryWords) if (words.has(w)) score++;
    if (score > 0) scored.push({ text, score });
  }
  if (scored.length === 0) return "";

  const top = scored.sort((a, b) => b.score - a.score).slice(0, 3).map((s) => `- ${s.text}`).join("\n");
  return `\n\n# Memory (things you remember about the user and project)\n${top}`;
}
//#endregion
