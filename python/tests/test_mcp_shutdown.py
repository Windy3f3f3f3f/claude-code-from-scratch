"""Real stdio MCP shutdown, without a model, SDK server, or user configuration."""
import asyncio
import json
import sys
import unittest
from pathlib import Path
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from mini_claude import mcp_client

SERVER = r'''
import json, sys
mode = sys.argv[1]
sys.stderr.write("synthetic MCP server\n")
sys.stderr.flush()
for line in sys.stdin:
    request = json.loads(line)
    if "id" not in request:
        continue
    method = request["method"]
    if method == "tools/call":
        continue
    reply = {"jsonrpc": "2.0", "id": request["id"], "result": {"tools": []}}
    if mode == "error" and method == "initialize":
        reply = {"jsonrpc": "2.0", "id": request["id"], "error": {"code": -32603, "message": "test initialization failure"}}
    print(json.dumps(reply), flush=True)
    if mode == "exit" and method == "tools/list":
        break
'''


class TestMcpShutdown(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.resources = []
        resources = self.resources
        original = mcp_client.McpConnection

        class Connection(original):
            async def connect(self):
                await super().connect()
                resources.append((self, self._process, self._reader_task))

        self.connection_patch = patch.object(mcp_client, "McpConnection", Connection)
        self.connection_patch.start()
        self.addCleanup(self.connection_patch.stop)

    async def asyncTearDown(self):
        # Even the failing baseline must not leak our synthetic child processes.
        for connection, process, reader in self.resources:
            reader.cancel()
            await asyncio.gather(reader, return_exceptions=True)
            if process.returncode is None:
                try:
                    process.kill()
                except ProcessLookupError:
                    pass
            await asyncio.wait_for(process.communicate(), timeout=5)

    async def manager(self, mode="normal", count=1):
        manager = mcp_client.McpManager()
        configs = {f"test{i}": {"command": sys.executable, "args": ["-u", "-c", SERVER, mode]}
                   for i in range(count)}
        with patch.object(manager, "_load_configs", return_value=configs):
            await asyncio.wait_for(manager.load_and_connect(), timeout=5)
        return manager

    def assert_released(self, resource):
        _, process, reader = resource
        self.assertIsNotNone(process.returncode, "disconnect returned before the server exited")
        self.assertTrue(reader.done(), "disconnect returned before its reader stopped")
        self.assertTrue(process.stdin.is_closing(), "stdin is still open")
        self.assertTrue(process.stdout.at_eof(), "stdout was not drained")
        self.assertTrue(process.stderr.at_eof(), "stderr was not drained")

    async def test_disconnect_reaps_server_and_all_pipes(self):
        manager = await self.manager()
        await manager.disconnect_all()
        self.assert_released(self.resources[0])

    async def test_disconnect_waits_for_cancelled_reader(self):
        manager = await self.manager()
        await manager.disconnect_all()
        self.assertTrue(self.resources[0][2].done())

    async def test_disconnect_is_repeatable(self):
        manager = await self.manager()
        await manager.disconnect_all()
        await manager.disconnect_all()
        self.assert_released(self.resources[0])

    async def test_disconnect_rejects_pending_tool_call_and_reaps_server(self):
        manager = await self.manager()
        connection = self.resources[0][0]
        pending = asyncio.create_task(connection.call_tool("waiting", {}))
        try:
            await asyncio.sleep(0)
            await manager.disconnect_all()
            with self.assertRaisesRegex(RuntimeError, "closed"):
                await pending
            self.assert_released(self.resources[0])
        finally:
            pending.cancel()
            await asyncio.gather(pending, return_exceptions=True)

    async def test_disconnect_reaps_every_server(self):
        manager = await self.manager(count=3)
        await manager.disconnect_all()
        self.assertEqual(len(self.resources), 3)
        for resource in self.resources:
            self.assert_released(resource)

    async def test_failed_initialization_finishes_cleanup_before_returning(self):
        manager = await self.manager(mode="error")
        self.assertEqual(manager.get_tool_definitions(), [])
        self.assert_released(self.resources[0])

    async def test_already_reaped_server_can_be_disconnected(self):
        manager = await self.manager(mode="exit")
        _, process, reader = self.resources[0]
        await asyncio.wait_for(process.wait(), timeout=5)
        await asyncio.gather(reader, return_exceptions=True)
        await process.communicate()
        await manager.disconnect_all()
        self.assert_released(self.resources[0])

    async def test_empty_manager_can_be_disconnected_repeatedly(self):
        manager = mcp_client.McpManager()
        await manager.disconnect_all()
        await manager.disconnect_all()
        self.assertEqual(manager.get_tool_definitions(), [])


if __name__ == "__main__":
    unittest.main()
