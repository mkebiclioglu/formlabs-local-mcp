# formlabs-local-mcp

An [MCP](https://modelcontextprotocol.io) server for the Formlabs Local API. It lets
Claude Code, Claude Desktop, Cursor and any other MCP client drive PreForm from a
chat prompt:

> "Import `~/parts/bracket.stl`, orient and support it for the Form 4 in Black V5,
> estimate the print time, then save it as `~/jobs/bracket.form`."

**Full documentation, including the one-command Claude Code install:**
https://mkebiclioglu.github.io/formlabs-claude-skills/

## What you need

1. **PreFormServer**, Formlabs' headless PreForm. Download the zip for your OS from
   the [Formlabs API downloads page](https://formlabs.com/support/Formlabs-API-downloads-and-release-notes),
   unzip it and drag `PreFormServer.app` into `/Applications` (macOS). The server
   finds it there automatically and starts and stops it for you.
2. **uv**, which runs the server without any Python setup:
   `brew install uv` or `curl -LsSf https://astral.sh/uv/install.sh | sh`
   (Windows: `winget install astral-sh.uv`).

## Install

### Claude Code (recommended: the plugin)

The [formlabs-claude-skills](https://github.com/mkebiclioglu/formlabs-claude-skills)
plugin bundles this server plus print-prep skills. Inside Claude Code:

```
/plugin marketplace add mkebiclioglu/formlabs-claude-skills
/plugin install formlabs@formlabs-claude-skills
```

### Claude Code (server only)

```bash
claude mcp add --scope user formlabs -- \
  uvx --from git+https://github.com/mkebiclioglu/formlabs-local-mcp@v0.2.0 formlabs-local-mcp
```

### Claude Desktop, Cursor, VS Code and others

Add this to the client's MCP config (`claude_desktop_config.json`, `.cursor/mcp.json`, ...):

```json
{
  "mcpServers": {
    "formlabs": {
      "command": "uvx",
      "args": [
        "--from",
        "git+https://github.com/mkebiclioglu/formlabs-local-mcp@v0.2.0",
        "formlabs-local-mcp"
      ]
    }
  }
}
```

The first start downloads and builds the server (about a minute). Later starts use
uv's cache.

## Configuration

Nothing is required when PreFormServer is in `/Applications`. Everything else is
an environment variable on the MCP server entry:

| Variable | Default | Purpose |
|---|---|---|
| `PREFORM_SERVER_PATH` | auto-detected | Path to the PreFormServer executable if it is somewhere unusual. |
| `PREFORM_SERVER_PORT` | `44388` | Port PreFormServer listens on. |
| `PREFORM_SERVER_URL` | `http://127.0.0.1:<port>` | Talk to a PreFormServer you run yourself (disables spawning). |
| `PREFORM_SPAWN` | `1` | Set to `0` to never start PreFormServer, only connect to it. |
| `PREFORM_STARTUP_TIMEOUT` | `120` | Seconds to wait for PreFormServer to come up. |
| `PREFORM_POLL_TIMEOUT` | `600` | Max seconds for one long operation (supports, packing, upload). |
| `PREFORM_TELEMETRY` | `0` | PreFormServer telemetry is off when spawned; set `1` to allow it. |
| `FORMLABS_ALLOWED_PATHS` | your home directory | Directories the model may read from and write to, separated by `:` (`;` on Windows). |
| `FORMLABS_ALLOW_HIDDEN_PATHS` | `0` | Allow paths through dot-directories such as `~/.ssh`. |
| `FORMLABS_USERNAME` / `FORMLABS_PASSWORD` | unset | Formlabs account for `login` (remote printing, Fleet Control). `FORMLABS_ACCESS_TOKEN` works too. |
| `FORMLABS_ALLOW_REMOTE_LOGIN` | `0` | Permit `login` against a non-loopback `PREFORM_SERVER_URL`. |

## Tools

| Area | Tools |
|---|---|
| Health | `health_check`, `get_user` |
| Scenes | `create_scene`, `list_scenes`, `get_scene`, `update_scene`, `delete_scene`, `load_form` |
| Models | `import_model`, `get_model`, `update_model`, `duplicate_model`, `replace_model`, `delete_model` |
| Prep | `auto_orient`, `auto_support`, `auto_layout`, `fill_build_platform` (SLA), `auto_pack`, `fill_build_chamber`, `pack_and_cage` (SLS), `hollow_model`, `label_model` |
| Drain holes | `auto_add_drain_holes`, `add_drain_holes` |
| Analysis | `get_print_validation`, `detect_cups`, `detect_minima`, `detect_supportedness`, `detect_thin_walls`, `get_interferences`, `estimate_print_time` |
| Export | `save_form`, `save_screenshot`, `save_fps_file` |
| Printers | `list_devices`, `get_device`, `discover_devices`, `print_to_printer` |
| Materials | `list_printer_types`, `list_materials` |
| Account | `login`, `logout` |

Tools carry MCP annotations (`readOnlyHint`, `destructiveHint`) so clients can ask
for confirmation before `print_to_printer`, `save_form` or any delete.

Tracks Formlabs Local API **0.9.29** (PreFormServer 3.62.1).

## Security

PreFormServer is a plain-HTTP server with no authentication that reads and writes
files as you. This server keeps that surface small:

- **Path guard rails.** Every file path a tool receives must be absolute, resolve
  (symlinks included) to somewhere under `FORMLABS_ALLOWED_PATHS` (default: your
  home directory), avoid hidden directories, and carry the right extension
  (`.stl`/`.obj`/`.3mf`/`.step` in, `.form`/`.png`/`.fps` out).
- **Credentials stay out of the chat.** `login` takes no arguments; it reads
  `FORMLABS_USERNAME` / `FORMLABS_PASSWORD` from the environment and never returns
  tokens to the model.
- **Loopback only by default.** `login` refuses to send credentials to a
  non-loopback PreFormServer.
- **Short-lived server.** In the default spawn mode PreFormServer runs only while an
  MCP client is connected and is stopped on exit. Telemetry is disabled.
- **Pinned dependencies** with upper bounds and Dependabot updates.

One thing this server cannot change: PreFormServer binds to **all network
interfaces** (`*:44388`), not just loopback, and it has no `--host` option. On a
shared or untrusted network keep your OS firewall on (macOS: System Settings,
Network, Firewall) so other machines cannot reach that port.

## Development

```bash
git clone https://github.com/mkebiclioglu/formlabs-local-mcp.git
cd formlabs-local-mcp
uv sync --extra dev
uv run pytest            # unit tests, no PreFormServer needed
uv run ruff check .
uv run python tests/smoke_e2e.py   # end-to-end against a real PreFormServer
```

To run the server by hand: `uv run formlabs-local-mcp` (it speaks MCP over stdio).

## License

MIT. The Formlabs API itself is covered by the
[Formlabs API License Agreement](https://formlabs.com/legal/formlabs-api-license-agreement/);
this project only makes HTTP calls to PreFormServer and ships no Formlabs code.
Not affiliated with or endorsed by Formlabs Inc.
