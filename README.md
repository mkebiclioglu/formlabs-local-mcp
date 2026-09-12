# formlabs-local-mcp

An [MCP](https://modelcontextprotocol.io) server for the Formlabs Local API. It lets
Claude Code, Claude Desktop, Cursor and any other MCP client drive PreForm from a
chat prompt:

> "Import `~/parts/bracket.stl`, orient and support it for the Form 4 in Black V5,
> estimate the print time, then save it as `~/jobs/bracket.form`."

**Docs and the Claude Code plugin:** https://mkebiclioglu.github.io/formlabs-claude-skills/

## Install

Needs Node.js 20 or newer. Nothing else.

```bash
claude mcp add --scope user formlabs -- npx -y https://github.com/mkebiclioglu/formlabs-local-mcp/releases/download/v1.0.0/formlabs-local-mcp-1.0.0.tgz
```

For other MCP clients, put the same command in their config:

```json
{
  "mcpServers": {
    "formlabs": {
      "command": "npx",
      "args": ["-y", "https://github.com/mkebiclioglu/formlabs-local-mcp/releases/download/v1.0.0/formlabs-local-mcp-1.0.0.tgz"]
    }
  }
}
```

Then ask Claude to run `health_check`. If PreFormServer (Formlabs' headless PreForm)
is not installed yet, the server says so and offers the `install_preform_server`
tool, which downloads the current release from Formlabs, verifies Formlabs' code
signature, and installs it into a folder you own. From a shell the same thing is:

```bash
npx -y https://github.com/mkebiclioglu/formlabs-local-mcp/releases/download/v1.0.0/formlabs-local-mcp-1.0.0.tgz install-preform
```

If you already have `PreFormServer.app` in `/Applications`, it is picked up as is.

## Commands

| Command | What it does |
|---|---|
| `formlabs-local-mcp` | Serve MCP over stdio (what MCP clients run). |
| `formlabs-local-mcp install-preform` | Download, verify and install the latest PreFormServer. No-op when up to date; `--force` reinstalls. |
| `formlabs-local-mcp doctor` | Show what is installed, which mode is active, and whether Formlabs has a newer release. |

## Tools

| Area | Tools |
|---|---|
| Setup | `preform_status`, `install_preform_server`, `health_check` |
| Scenes | `create_scene`, `list_scenes`, `get_scene`, `update_scene`, `delete_scene`, `load_form` |
| Models | `import_model`, `get_model`, `update_model`, `duplicate_model`, `replace_model`, `delete_model` |
| Prep | `auto_orient`, `auto_support`, `auto_layout`, `fill_build_platform` (SLA), `auto_pack`, `fill_build_chamber`, `pack_and_cage` (SLS), `hollow_model`, `label_model` |
| Drain holes | `auto_add_drain_holes`, `add_drain_holes` |
| Analysis | `get_print_validation`, `detect_cups`, `detect_minima`, `detect_supportedness`, `detect_thin_walls`, `get_interferences`, `estimate_print_time` |
| Export | `save_form`, `save_screenshot`, `save_fps_file` |
| Printers | `list_devices`, `get_device`, `discover_devices`, `print_to_printer` |
| Materials | `list_printer_types`, `list_materials` |
| Account | `login`, `logout`, `get_user` |

Tools carry MCP annotations (`readOnlyHint`, `destructiveHint`) so clients can ask
before `print_to_printer`, `save_form`, `install_preform_server` or any delete.
Tracks Formlabs Local API **0.9.29** (PreFormServer 3.62.1).

## Configuration

None needed in the common case. Everything is an environment variable on the MCP
server entry (or in the `env` block of `~/.claude/settings.json` for Claude Code).

| Variable | Default | Purpose |
|---|---|---|
| `PREFORM_SERVER_PATH` | auto-detected | PreFormServer executable if it lives somewhere unusual. |
| `PREFORM_SERVER_PORT` | `44388` | Port PreFormServer listens on (local port of the tunnel in remote mode). |
| `PREFORM_SERVER_URL` | `http://127.0.0.1:<port>` | Connect to a PreFormServer you run yourself (disables spawning). |
| `PREFORM_SPAWN` | `1` | `0` never starts PreFormServer, only connects. |
| `PREFORM_STARTUP_TIMEOUT` | `120` | Seconds to wait for PreFormServer to come up. |
| `PREFORM_POLL_TIMEOUT` | `600` | Longest one operation (supports, packing, upload) may take. |
| `PREFORM_TELEMETRY` | `0` | PreFormServer telemetry is off when spawned; `1` allows it. |
| `PREFORM_LAUNCHER` | `wine` on Linux | Command prefix used to start PreFormServer, e.g. `xvfb-run -a wine`. |
| `FORMLABS_ALLOWED_PATHS` | home directory | Directories the model may read from and write to. `:`-separated (`;` on Windows). |
| `FORMLABS_ALLOW_HIDDEN_PATHS` | `0` | Allow paths through dot-directories such as `~/.cache`. |
| `FORMLABS_USERNAME`, `FORMLABS_PASSWORD` | unset | Formlabs account for `login` (remote printing, Fleet Control). `FORMLABS_ACCESS_TOKEN` works too. |
| `FORMLABS_ALLOW_REMOTE_LOGIN` | `0` | Permit `login` against a non-loopback `PREFORM_SERVER_URL`. |
| `PREFORM_REMOTE_HOST` | unset | Run PreFormServer on another machine over ssh (see below). |
| `PREFORM_REMOTE_PORT` | `22` | ssh port for the remote host. |
| `PREFORM_REMOTE_SERVER_PATH` | well-known paths | PreFormServer executable on the remote host. |
| `PREFORM_REMOTE_SPAWN` | `1` | `0` only tunnels to a PreFormServer already running remotely. |
| `PREFORM_INSTALL_UNVERIFIED` | `0` | Linux only: accept a download whose Authenticode signature cannot be checked (install `osslsigncode` instead). |

## Linux and remote mode

Formlabs ships PreFormServer for macOS and Windows only. Two ways to use it from Linux:

**Remote mode.** Run PreFormServer on any Mac or Windows box on your network and let
the MCP server on Linux drive it over ssh:

```
PREFORM_REMOTE_HOST=me@studio-mac.local
```

One ssh session (keys only, `BatchMode`) forwards a loopback port and starts
PreFormServer on the remote machine, so it stops when the MCP server does. Input
files are copied over with `scp` into a per-session staging folder under the remote
user's home; `.form` files and screenshots are copied back. The remote host needs
PreFormServer installed (run `install-preform` there) and a POSIX shell over ssh
(macOS, Linux). For a Windows remote host set `PREFORM_REMOTE_SPAWN=0` and start
PreFormServer yourself.

**Wine (experimental).** `install-preform` on Linux fetches the Windows build,
verifies it with `osslsigncode`, and the server launches it with `wine`. Set
`PREFORM_LAUNCHER="xvfb-run -a wine"` if it needs a display. A weekly CI job runs
this path; see the Actions tab for whether it currently works.

## Security

PreFormServer is a plain-HTTP server with no authentication that reads and writes
files as you. This server keeps that surface small:

- **Path guard rails.** Every file path a tool receives must be absolute, resolve
  (symlinks included) to somewhere under `FORMLABS_ALLOWED_PATHS` (default: your
  home directory), avoid hidden directories, and carry the right extension
  (models in, `.form`/`.png`/`.webp`/`.fps` out).
- **Verified installs.** `install_preform_server` only downloads over HTTPS from
  `downloads.formlabs.com` with Formlabs' release path layout, scans the archive
  for path traversal before extracting, and checks the code signature before
  moving anything into place: Developer ID team `KVPE3R79SR` plus notarization on
  macOS, a valid Authenticode signature from Formlabs on Windows, `osslsigncode` on
  Linux. A failed check leaves the previous install untouched.
- **Credentials stay out of the chat.** `login` takes no arguments; it reads
  `FORMLABS_USERNAME` / `FORMLABS_PASSWORD` from the environment and never returns
  tokens to the model. It refuses non-loopback servers unless you opt in.
- **Short-lived server.** PreFormServer runs only while an MCP client is connected
  and is stopped on exit. Telemetry is disabled.
- **Remote mode** uses ssh keys only, validates the host string so it can never be
  parsed as an ssh option, binds the forward to 127.0.0.1, and sanitizes staged
  file names.
- **Supply chain.** Two runtime dependencies (`@modelcontextprotocol/server`, `zod`),
  a lockfile, SHA-pinned GitHub Actions, Dependabot.

One thing this server cannot change: PreFormServer binds to **all network
interfaces** (`*:44388`) and has no option to bind loopback only. On a shared or
untrusted network keep your OS firewall on so other machines cannot reach that port.

## Development

```bash
git clone https://github.com/mkebiclioglu/formlabs-local-mcp.git
cd formlabs-local-mcp
npm install
npm test              # unit tests, no PreFormServer needed
npm run typecheck && npm run lint
npm run build
npm run smoke         # end-to-end against a real PreFormServer
```

## License

MIT. The Formlabs API itself is covered by the
[Formlabs API License Agreement](https://formlabs.com/legal/formlabs-api-license-agreement/);
this project only makes HTTP calls to PreFormServer and ships no Formlabs code.
Not affiliated with or endorsed by Formlabs Inc.
