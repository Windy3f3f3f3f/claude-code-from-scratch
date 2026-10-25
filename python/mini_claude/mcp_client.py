"""
MCP Client — connects to stdio-based MCP servers, discovers and forwards tool calls.
Uses raw JSON-RPC over stdio (no SDK dependency for simplicity).

Config is read from .claude/settings.json and ~/.claude/settings.json:
  { "mcpServers": { "name": { "command": "...", "args": [...], "env": {...} } } }

Each MCP tool is exposed with a "mcp__serverName__toolName" prefix to avoid conflicts.
"""

from __future__ import annotations

import asyncio
import json
import os
import subprocess
from pathlib import Path
from typing import Any


# ─── Single MCP connection (one per server) ──────────────────


class McpConnection:
    """Manages a single MCP server process and JSON-RPC communication."""

    def __init__(self, server_name: str, command: str, args: list[str] | None = None,
                 env: dict[str, str] | None = None):
        self.server_name = server_name
        self.command = command
        self.args = args or []
        self.env = env or {}
        self._process: asyncio.subprocess.Process | None = None
        self._next_id = 1
        self._pending: dict[int, asyncio.Future] = {}
        self._reader_task: asyncio.Task | None = None

    async def connect(self) -> None:
        """Spawn the server process."""
        merged_env = {**os.environ, **self.env}
        self._process = await asyncio.create_subprocess_exec(
            self.command, *self.args,
            stdin=subprocess.PIPE,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            env=merged_env,
        )
        # Start reading stdout lines in background
        self._reader_task = asyncio.create_task(self._read_loop())

    async def _read_loop(self) -> None:
        """Read newline-delimited JSON-RPC responses from stdout."""
        assert self._process and self._process.stdout
        while True:
            line = await self._process.stdout.readline()
            if not line:
                break
            try:
                msg = json.loads(line)
            except json.JSONDecodeError:
                continue
            msg_id = msg.get("id")
            if msg_id is not None and msg_id in self._pending:
                fut = self._pending.pop(msg_id)
                if "error" in msg:
                    e = msg["error"]
                    fut.set_exception(
                        RuntimeError(f"MCP error {e.get('code')}: {e.get('message')}")
                    )
                else:
                    fut.set_result(msg.get("result"))

    async def _send_request(self, method: str, params: dict | None = None) -> Any:
        """Send a JSON-RPC request and wait for response."""
        assert self._process and self._process.stdin
        req_id = self._next_id
        self._next_id += 1
        msg = json.dumps({"jsonrpc": "2.0", "id": req_id, "method": method, "params": params or {}})
        self._process.stdin.write((msg + "\n").encode())
        await self._process.stdin.drain()
        loop = asyncio.get_event_loop()
        fut: asyncio.Future = loop.create_future()
        self._pending[req_id] = fut
        return await fut

    def _send_notification(self, method: str, params: dict | None = None) -> None:
        """Send a JSON-RPC notification (no response expected)."""
        if not self._process or not self._process.stdin:
            return
        msg = json.dumps({"jsonrpc": "2.0", "method": method, "params": params or {}})
        self._process.stdin.write((msg + "\n").encode())

    async def initialize(self) -> None:
        """Perform MCP initialize handshake."""
        await self._send_request("initialize", {
            "protocolVersion": "2024-11-05",
            "capabilities": {},
            "clientInfo": {"name": "mini-claude", "version": "1.0.0"},
        })
        self._send_notification("notifications/initialized")

    async def list_tools(self) -> list[dict]:
        """Discover available tools from this server."""
        result = await self._send_request("tools/list")
        if not result or not isinstance(result.get("tools"), list):
            return []
        return [
            {
                "name": t["name"],
                "description": t.get("description", ""),
                "inputSchema": t.get("inputSchema"),
                "serverName": self.server_name,
            }
            for t in result["tools"]
        ]

    async def call_tool(self, name: str, args: dict) -> str:
        """Call a tool and return the text result."""
        result = await self._send_request("tools/call", {"name": name, "arguments": args})
        if isinstance(result, dict) and isinstance(result.get("content"), list):
            return "\n".join(
                c["text"] for c in result["content"] if c.get("type") == "text"
            )
        return json.dumps(result)

    async def close(self) -> None:
        """Stop the server and finish releasing its task and stdio pipes."""
        reader = self._reader_task
        process = self._process
        if self._reader_task:
            self._reader_task.cancel()
            self._reader_task = None
        if self._process:
            try:
                self._process.kill()
            except ProcessLookupError:
                pass
            self._process = None
        # Reject pending requests
        for fut in self._pending.values():
            if not fut.done():
                fut.set_exception(RuntimeError(f"MCP server '{self.server_name}' closed"))
        self._pending.clear()
        if reader:
            await asyncio.gather(reader, return_exceptions=True)
        if process:
            await process.communicate()


# ─── MCP Manager ─────────────────────────────────────────────


class McpManager:
    """Manages all MCP server connections. Call load_and_connect() once, then
    use get_tool_definitions() and call_tool() to integrate with the agent."""

    def __init__(self):
        self._connections: dict[str, McpConnection] = {}
        self._tools: list[dict] = []
        self._connected = False

    async def load_and_connect(self) -> None:
        """Read settings, connect to all configured MCP servers, discover tools."""
        if self._connected:
            return
        self._connected = True

        configs = self._load_configs()
        if not configs:
            return

        timeout = 15.0

        for name, cfg in configs.items():
            conn = McpConnection(
                name,
                cfg["command"],
                cfg.get("args"),
                cfg.get("env"),
            )
            try:
                await conn.connect()
                await asyncio.wait_for(conn.initialize(), timeout=timeout)
                server_tools = await asyncio.wait_for(conn.list_tools(), timeout=timeout)
                self._connections[name] = conn
                self._tools.extend(server_tools)
                print(f"[mcp] Connected to '{name}' — {len(server_tools)} tools", flush=True)
            except Exception as e:
                print(f"[mcp] Failed to connect to '{name}': {e}", flush=True)
                await conn.close()

    def get_tool_definitions(self) -> list[dict]:
        """Return tool definitions in Anthropic API format with mcp__ prefix."""
        return [
            {
                "name": f"mcp__{t['serverName']}__{t['name']}",
                "description": t.get("description") or f"MCP tool {t['name']} from {t['serverName']}",
                "input_schema": t.get("inputSchema") or {"type": "object", "properties": {}},
            }
            for t in self._tools
        ]

    def is_mcp_tool(self, name: str) -> bool:
        """Check if a tool name is an MCP-prefixed tool."""
        return name.startswith("mcp__")

    async def call_tool(self, prefixed_name: str, args: dict) -> str:
        """Route a prefixed tool call to the correct server."""
        parts = prefixed_name.split("__")
        if len(parts) < 3:
            raise ValueError(f"Invalid MCP tool name: {prefixed_name}")
        server_name = parts[1]
        tool_name = "__".join(parts[2:])  # tool name might contain __
        conn = self._connections.get(server_name)
        if not conn:
            raise RuntimeError(f"MCP server '{server_name}' not connected")
        return await conn.call_tool(tool_name, args)

    async def disconnect_all(self) -> None:
        """Disconnect all servers."""
        for conn in self._connections.values():
            await conn.close()
        self._connections.clear()
        self._tools.clear()
        self._connected = False

    # ─── Config loading ──────────────────────────────────────

    def _load_configs(self) -> dict[str, dict]:
        merged: dict[str, dict] = {}

        # 1. Global: ~/.claude/settings.json
        global_path = Path.home() / ".claude" / "settings.json"
        self._merge_config_file(global_path, merged)

        # 2. Project: .claude/settings.json (cwd)
        project_path = Path.cwd() / ".claude" / "settings.json"
        self._merge_config_file(project_path, merged)

        # 3. Also check .mcp.json (Claude Code convention)
        mcp_json_path = Path.cwd() / ".mcp.json"
        self._merge_config_file(mcp_json_path, merged)

        return merged

    def _merge_config_file(self, path: Path, target: dict[str, dict]) -> None:
        if not path.exists():
            return
        try:
            raw = json.loads(path.read_text())
            servers = raw.get("mcpServers", raw)
            for name, config in servers.items():
                if isinstance(config, dict) and "command" in config:
                    target[name] = config
        except Exception:
            pass  # skip malformed config
