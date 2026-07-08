import os
import re

# Cross-session memory: small facts saved as files under .mini-memory/. Before
# each turn we recall the ones relevant to what the user asked and drop them
# into the system prompt. Recall is deterministic keyword overlap — no model
# call, no embeddings — enough to see the mechanism.
MEMORY_DIR = os.path.join(os.getcwd(), ".mini-memory")


#region recall
def recall_memories(query: str) -> str:
    if not os.path.isdir(MEMORY_DIR):
        return ""
    query_words = {w for w in re.split(r"\W+", query.lower()) if len(w) > 2}

    scored = []
    for name in os.listdir(MEMORY_DIR):
        if not name.endswith(".md"):
            continue
        text = open(os.path.join(MEMORY_DIR, name), encoding="utf-8").read().strip()
        words = set(re.split(r"\W+", text.lower()))
        score = sum(1 for w in query_words if w in words)
        if score > 0:
            scored.append((score, text))
    if not scored:
        return ""

    top = "\n".join(f"- {t}" for _, t in sorted(scored, key=lambda s: -s[0])[:3])
    return f"\n\n# Memory (things you remember about the user and project)\n{top}"
#endregion
