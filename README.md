# formlabs-local-mcp

A [Model Context Protocol](https://modelcontextprotocol.io) server that exposes the
[Formlabs Local API](https://formlabs.com/) to any MCP-compatible AI tool — Claude
Code, Claude Desktop, Cursor, VS Code, and others.

Drive your Formlabs printers from a chat prompt:

> "Import `~/parts/bracket.stl`, auto-orient it, generate supports, estimate the print
> time, then send it to my Form 4."

The MCP server wraps PreFormServer's HTTP API as a set of typed tools the model
can call directly.

## Status

Early alpha. The tool surface is complete for the common SLA/SLS preparation
workflow, but has only been tested against the API spec — not yet validated
against real hardware. PRs and bug reports welcome.

## Requirements

- Python ≥ 3.10
- The **PreFormServer** executable, downloaded from the [Formlabs API downloads page](https://support.formlabs.com/s/article/Formlabs-API-downloads-and-release-notes).
  PreFormServer is a headless build of PreForm; it must be running for the MCP
  server to do anything.

## Install

The easiest way is `uvx`, which downloads the package on demand into an
isolated environment:

```bash
uvx formlabs-local-mcp
```

Or install into your own environment:

```bash
pip install formlabs-local-mcp
```

## Configure your MCP client

### Claude Code

Add the server to your `.claude/mcp.json` (project) or `~/.claude/mcp.json` (global):

```json
{
  "mcpServers": {
    "formlabs": {
      "command": "uvx",
      "args": ["formlabs-local-mcp"],
      "env": {
        "PREFORM_SERVER_PATH": "/Applications/PreFormServer.app/Contents/MacOS/PreFormServer"
      }
    }
  }
}
```

### Claude Desktop

Add the same block to `~/Library/Application Support/Claude/claude_desktop_config.json`
(macOS) or `%APPDATA%\Claude\claude_desktop_config.json` (Windows).

## PreFormServer lifecycle

The MCP server has two modes for talking to PreFormServer:

1. **Spawn mode (recommended).** Set `PREFORM_SERVER_PATH` to the absolute path of
   the PreFormServer executable. The MCP server starts it on launch, waits for
   `READY FOR INPUT` on stdout, and shuts it down on exit.
2. **External mode.** If `PREFORM_SERVER_PATH` is unset, the MCP server assumes
   PreFormServer is already running on `localhost:44388` (or whatever
   `PREFORM_SERVER_PORT` / `PREFORM_SERVER_URL` you set).

## Environment variables

| Variable | Default | Purpose |
|---|---|---|
| `PREFORM_SERVER_PATH` | _(unset)_ | Absolute path to the PreFormServer executable. If set, the MCP server spawns and supervises it. |
| `PREFORM_SERVER_PORT` | `44388` | Port the PreFormServer listens on. |
| `PREFORM_SERVER_URL` | `http://localhost:$PORT` | Override the base URL entirely (e.g. for a PreFormServer on another machine). |
| `PREFORM_SPAWN` | `1` | Set to `0` to disable spawning even if `PREFORM_SERVER_PATH` is set. |
| `PREFORM_POLL_INTERVAL` | `2.0` | Seconds between operation status polls. |
| `PREFORM_POLL_TIMEOUT` | `600` | Maximum seconds to wait for any async operation. |

## Tools

The MCP server exposes ~25 tools across these categories:

| Category | Tools |
|---|---|
| Health | `health_check` |
| Scene | `create_scene`, `list_scenes`, `get_scene`, `delete_scene`, `load_form` |
| Models | `import_model`, `update_model`, `delete_model` |
| Auto-prep | `auto_orient`, `auto_support`, `auto_layout` (SLA), `auto_pack` (SLS) |
| Modify | `hollow_model`, `add_drain_holes` |
| Validate | `estimate_print_time`, `get_print_validation` |
| Export | `save_form`, `save_screenshot` |
| Devices | `list_devices`, `discover_devices` |
| Print | `print_to_printer` |
| Materials | `list_materials` |
| Auth | `login`, `logout` |

File path parameters must always be **absolute** — PreFormServer rejects
relative paths, environment variables, and URLs.

## Companion skills

For Claude Code, the [`formlabs-claude-skills`](https://github.com/mkebiclioglu/formlabs-claude-skills)
repo ships opinionated workflow skills (e.g. `/formlabs-print`) that orchestrate
these tools end to end.

## Development

```bash
git clone https://github.com/mkebiclioglu/formlabs-local-mcp
cd formlabs-local-mcp
python -m venv .venv
source .venv/bin/activate
pip install -e ".[dev]"
pytest
```

To run the server against a local PreFormServer:

```bash
PREFORM_SERVER_PATH=/path/to/PreFormServer formlabs-local-mcp
```

## License

MIT. The Formlabs API itself is governed by the
[Formlabs API License Agreement](https://formlabs.com/legal/formlabs-api-license-agreement/);
this MCP server only makes HTTP calls to it and does not redistribute any
Formlabs code.

## Disclaimer

This is an independent integration. It is not affiliated with, endorsed by, or
supported by Formlabs Inc.
