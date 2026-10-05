// Run explicitly: node --test examples/parallel-search/test.mjs
// Exercises both real CLIs and their MCP loaders through the documented bridge.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { readFileSync } from "node:fs";
import { runReplInteractive, countCategory, toolResultTexts } from "../../test/integration/harness.mjs";

const run = promisify(execFile);
const config = JSON.parse(readFileSync(new URL(".mcp.json", import.meta.url), "utf8"));
const endpoint = "https://search.parallel.ai/mcp";
const userAgent = "claude-code-from-scratch/1.0.0";
const live = process.env.PARALLEL_MCP_LIVE === "1";
const tools = [
  { name: "web_search", description: "Search the web", inputSchema: {
    type: "object", properties: { objective: { type: "string" }, search_queries: {
      type: "array", items: { type: "string" } } }, required: ["objective", "search_queries"],
  } },
  { name: "web_fetch", description: "Read a web page", inputSchema: {
    type: "object", properties: { urls: { type: "array", items: { type: "string" } } }, required: ["urls"],
  } },
];
const source = "https://modelcontextprotocol.io/introduction";
const excerpt = "MCP connects AI applications to external tools and data sources.";

// A local Streamable HTTP server, or a recording proxy for the opt-in live check.
// Records every request so discovery alone cannot satisfy execution assertions.
async function serve() {
  const observed = [];
  const server = createServer(async (req, res) => {
    try {
      let body = "";
      for await (const chunk of req) body += chunk;
      const message = body ? JSON.parse(body) : {};
      observed.push({ method: req.method, rpc: message, headers: req.headers });
      if (live && req.method !== "GET") {
        const headers = { ...req.headers };
        for (const key of ["host", "connection", "content-length", "transfer-encoding"]) delete headers[key];
        // curl uses the host's network proxy settings; the model subprocess
        // remains isolated. No credentials are added to the forwarded request.
        const curlArgs = ["--disable", "--silent", "--show-error", "--max-time", "30",
          "--suppress-connect-headers", "--include", "--compressed",
          "--request", req.method, endpoint];
        for (const [name, value] of Object.entries(headers)) {
          curlArgs.push("--header", `${name}: ${value}`);
        }
        if (body) curlArgs.push("--data-binary", body);
        const { stdout } = await run("curl", curlArgs, { maxBuffer: 2 * 1024 * 1024 });
        const split = stdout.indexOf("\r\n\r\n");
        assert.ok(split >= 0, "upstream HTTP response must contain headers");
        const lines = stdout.slice(0, split).split("\r\n");
        const status = Number(lines.shift().split(" ")[1]);
        const responseHeaders = Object.fromEntries(lines.map((line) => {
          const colon = line.indexOf(":");
          return [line.slice(0, colon).toLowerCase(), line.slice(colon + 1).trim()];
        }));
        res.writeHead(status, { "content-type": responseHeaders["content-type"] || "application/json",
          ...(responseHeaders["mcp-session-id"] ? { "mcp-session-id": responseHeaders["mcp-session-id"] } : {}) });
        res.end(stdout.slice(split + 4));
        return;
      }
      if (req.method !== "POST") { res.writeHead(405); res.end(); return; }
      if (message.id === undefined) { res.writeHead(202); res.end(); return; }
      let result;
      if (message.method === "initialize") result = {
        protocolVersion: message.params.protocolVersion, capabilities: { tools: {} },
        serverInfo: { name: "parallel-search-fixture", version: "1.0.0" },
      };
      else if (message.method === "tools/list") result = { tools };
      else if (message.method === "tools/call") result = { content: [{ type: "text", text:
        JSON.stringify({ results: [{ url: source, title: "Model Context Protocol", excerpts: [excerpt] }] }) }] };
      else { res.writeHead(400); res.end(); return; }
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ jsonrpc: "2.0", id: message.id, result }));
    } catch (error) { res.writeHead(502); res.end(String(error)); }
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  return { observed, url: `http://127.0.0.1:${server.address().port}/mcp`,
    close: () => new Promise((resolve) => { server.closeAllConnections(); server.close(resolve); }) };
}

// Serialize the two CLIs, including the optional live traffic.
for (const python of [false, true]) {
  test(`${python ? "Python" : "TypeScript"}: opt-in Parallel configuration, search and fetch${live ? " (live)" : ""}`, async () => {
    assert.equal(config.mcpServers["parallel-search"].command, "mcp-remote");
    assert.ok(config.mcpServers["parallel-search"].args.includes(endpoint));
    assert.ok(config.mcpServers["parallel-search"].args.includes(`User-Agent: ${userAgent}`));
    const fixture = await serve();
    try {
      const effective = structuredClone(config);
      // Only the destination changes for recording; the production bridge,
      // version, HTTP transport and identifying header remain exactly as shipped.
      const args = effective.mcpServers["parallel-search"].args;
      args[args.indexOf(endpoint)] = fixture.url;
      args.push("--allow-http");
      const result = await runReplInteractive({
        python, backend: "anthropic", gitInit: true,
        sandboxFiles: { ".mcp.json": JSON.stringify(effective) },
        // Never inherit Parallel credentials or a user's bridge auth cache.
        extraEnv: { PARALLEL_API_KEY: "", PARALLEL_API_TOKEN: "" },
        steps: [{ send: "Use Parallel web_search and web_fetch to explain MCP and cite the documentation." },
          { wait: /Source: https:\/\/modelcontextprotocol\.io\/introduction/ }],
        script: { main: [
          { tool_calls: [{ name: "mcp__parallel-search__web_search", arguments: {
            objective: "Find the official introduction to Model Context Protocol", search_queries: ["Model Context Protocol introduction"] } }] },
          { tool_calls: [{ name: "mcp__parallel-search__web_fetch", arguments: { urls: [source] } }] },
          { content: `${excerpt} Source: ${source}` },
        ] }, timeoutMs: 60000, stepTimeoutMs: 55000,
      });
      assert.equal(result.code, 0, JSON.stringify(result));
      assert.equal(countCategory(result.servedLog, "main"), 3);
      const outputs = toolResultTexts(result.servedLog);
      assert.equal(outputs.length, 3); // Each model request includes prior tool results.
      for (const output of outputs) {
        let payload = JSON.parse(output);
        if (typeof payload === "string") payload = JSON.parse(payload);
        assert.ok(payload.results?.some((item) => item.url && item.excerpts?.some((text) => text.length > 20)),
          "tool output must contain a source URL and useful excerpts");
        assert.match(output, /modelcontextprotocol\.io/i);
        assert.doesNotMatch(output, /Denied|Error calling|rate limit|unauthorized/i);
        if (!live) assert.ok(output.includes(excerpt));
      }
      assert.match(result.stdout, /MCP connects AI applications to external tools/);
      assert.ok(fixture.observed.some((r) => r.rpc.method === "initialize"));
      assert.ok(fixture.observed.some((r) => r.rpc.method === "tools/list"));
      const calls = fixture.observed.filter((r) => r.rpc.method === "tools/call");
      assert.deepEqual(calls.map((r) => r.rpc.params.name), ["web_search", "web_fetch"]);
      for (const request of fixture.observed) assert.equal(request.headers.authorization, undefined);
      for (const request of fixture.observed.filter((r) => ["initialize", "tools/list", "tools/call"].includes(r.rpc.method))) {
        assert.equal(request.headers["user-agent"], userAgent, JSON.stringify(request));
        assert.equal(request.headers.authorization, undefined);
      }
      console.log(JSON.stringify({ implementation: python ? "python" : "typescript", live,
        effective_configuration: effective, observed_requests: fixture.observed,
        tool_results: outputs, final_answer: `${excerpt} Source: ${source}` }));
    } finally { await fixture.close(); }
  });
}
