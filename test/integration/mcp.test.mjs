// MCP integration: a project .claude/settings.json declares a real external MCP
// server (spawned as a stdio subprocess by the CLI's McpManager); the model calls
// its prefixed tool (mcp__demo__add) and the result flows back through the chat
// loop. Exercises real MCP discovery + JSON-RPC routing end-to-end, both backends.
//
// The assertion checks the tool RESULT the CLI fed back (the mock logs it), NOT a
// business value baked into the final scripted reply — so breaking the MCP server
// turns the test red. Node CLI. (Reuses the tutorial's demo MCP server: `add`.)
import { test } from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { runReplInteractive, countCategory, toolResultTexts } from "./harness.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = join(HERE, "..", "..");
const MCP_SERVER = join(REPO, "steps", "mcp-demo-server.mjs");
const settings = JSON.stringify({ mcpServers: { demo: { command: "node", args: [MCP_SERVER] } } });

for (const backend of ["openai", "anthropic"]) {
  test(`[${backend}] MCP: external server tool is discovered, called, result fed back`, async () => {
    const { stdout, code, servedLog } = await runReplInteractive({
      backend, gitInit: true,
      sandboxFiles: { ".claude/settings.json": settings },
      // final reply is a MARKER ONLY — the "42" must come from the MCP server.
      steps: [{ send: "use the demo add tool to add 17 and 25" }, { wait: /MCP_DONE|Denied|error/i }],
      script: {
        main: [
          { tool_calls: [{ name: "mcp__demo__add", arguments: { a: 17, b: 25 } }] },
          { content: "MCP_DONE" },
        ],
      },
      timeoutMs: 25000,
    });
    assert.equal(code, 0, `exit (stdout: ${stdout})`);
    assert.match(stdout, /MCP_DONE/, "the round must reach the final turn after the MCP tool");
    assert.equal(countCategory(servedLog, "main"), 2);
    // the REAL MCP result (42) must have been fed back to the model
    assert.ok(
      toolResultTexts(servedLog).some((t) => t.includes("42")),
      `the MCP server's result (42) must reach the model via tool_result; got: ${JSON.stringify(toolResultTexts(servedLog))}`,
    );
  });
}
