# Opt-in Parallel web search

This example adds `web_search` and `web_fetch` to Mini Claude through its existing
stdio MCP client. The [Parallel Search MCP](https://docs.parallel.ai/integrations/mcp/search-mcp)
is free and requires no Parallel API key. The pinned `mcp-remote` bridge connects
the stdio client to `https://search.parallel.ai/mcp` using Streamable HTTP. Your
configured model provider still needs its usual credentials.

Requires Node.js 22 or newer and npm, including when running the Python client.
Install the project as described in the root README, then install the bridge:

```sh
npm install --global mcp-remote@0.14.3
```

The `mcp-remote` executable must be on your PATH. Installing it before starting
the client keeps downloads out of the 15-second MCP initialization timeout and
lets the client manage the bridge process directly.

From the repository root, run the example in its own directory:

```sh
cd examples/parallel-search
node ../../dist/cli.js "Use Parallel web_search to find the official MCP introduction, then web_fetch to explain it with a source URL."
# Alternatively, with the Python package installed in your active environment:
mini-claude-py "Use Parallel web_search to find the official MCP introduction, then web_fetch to explain it with a source URL."
```

The client reads `.mcp.json` from the current working directory. The tools are
named `mcp__parallel-search__web_search` and `mcp__parallel-search__web_fetch`.
To enable them in another project, merge the `parallel-search` entry from this
example into that project's `.mcp.json` under `mcpServers`. Keep the other entries.
User settings, project settings, and `.mcp.json` retain their existing precedence.
The example sends `User-Agent: claude-code-from-scratch/1.0.0` on MCP discovery
and tool requests. If your network requires an HTTP proxy, add `--enable-proxy`
to the bridge arguments and configure `HTTPS_PROXY` and `NO_PROXY` as described
in the [bridge documentation](https://github.com/punkpeye/mcp-remote#usage).

This configuration is opt-in. It does not edit the repository's root `.mcp.json`,
change model selection, or supply authentication headers. Search queries and
fetched URLs go to Parallel; tool results go to your configured model provider.
Free use is rate limited. If tools fail to load, check network access and that
`mcp-remote` is on PATH before restarting. Existing timeout and failure handling still apply.

## Validation

After `npm ci`, `npm run build`, and installing the Python package into your
active Python environment, run:

```sh
node --test examples/parallel-search/test.mjs
```

Set `INTEG_PYTHON` to a Python executable if needed, for example
`INTEG_PYTHON="$PWD/.venv/bin/python"`. The test uses both real CLIs with isolated
settings and a scripted model, the pinned bridge, and a local HTTP MCP fixture.
It checks discovery, search and fetch execution, actual tool results reaching the
model, a final response, the User-Agent, and absence of authentication headers.
Install the documented bridge version before running the tests.

To additionally send real, keyless search and fetch requests to Parallel:

```sh
PARALLEL_MCP_LIVE=1 node --test examples/parallel-search/test.mjs
```

This optional check forwards requests through a local recording proxy. It uses a
scripted model, so it validates tool routing and results rather than answer quality
from a live model. It requires `curl` and network access and is subject to free-tier limits.
Neither check reads a project `.env` or the user's saved MCP settings.

## 中文说明

此示例通过现有的 stdio MCP 客户端和固定版本的 `mcp-remote` 桥接程序，
按需启用 Parallel 网页搜索和内容提取。Parallel Search MCP 免费且无需
Parallel API Key，模型后端仍需使用原有凭据。Python 版本也需要 Node.js 22+
和 npm。先安装上面的桥接程序，再进入本目录运行 TypeScript 或 Python
客户端；工具名称为 `mcp__parallel-search__web_search` 和
`mcp__parallel-search__web_fetch`。

如需在其他项目使用，请将本示例的 `parallel-search` 配置合并到该项目的
`.mcp.json` 中，保留其他服务器条目。搜索词和待提取的 URL 会发送给 Parallel，
返回内容会发送给已配置的模型后端。现有配置优先级、模型选择及超时处理不变。
上述测试通过两个真实 CLI 验证工具发现和调用；在线测试需显式设置
`PARALLEL_MCP_LIVE=1`，可能受免费额度限制。
