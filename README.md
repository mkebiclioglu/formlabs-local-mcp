# formlabs-local-mcp

An [MCP](https://modelcontextprotocol.io) server for the Formlabs Local API. It lets
Claude Code, Claude Desktop, Cursor and any other MCP client drive PreForm from a
chat prompt:

> "Import `~/parts/bracket.stl`, orient and support it for the Form 4 in Black V5,
> estimate the print time, then save it as `~/jobs/bracket.form`."

**See it work:** https://mkebiclioglu.github.io/formlabs-claude-skills/ (a downloaded bracket to a validated Form 4 job in one prompt; spin the result, compare materials)

**Docs and the Claude Code plugin:** https://mkebiclioglu.github.io/formlabs-claude-skills/docs.html

[![A bracket oriented and supported for the Form 4](https://mkebiclioglu.github.io/formlabs-claude-skills/demo/x-end-idler.png)](https://mkebiclioglu.github.io/formlabs-claude-skills/)

## Install

Needs Node.js 20 or newer. Nothing else. Published on npm as
[`formlabs-local-mcp`](https://www.npmjs.com/package/formlabs-local-mcp) with build
provenance. Pin the version you tested with:

```bash
claude mcp add --scope user formlabs -- npx -y formlabs-local-mcp@1.0.9
```

Using Claude Code? The [plugin](https://mkebiclioglu.github.io/formlabs-claude-skills/)
installs this server plus print-prep skills in one line, so you do not need the
command above.

For other MCP clients, put the same command in their config:

```json
{
  "mcpServers": {
    "formlabs": {
      "command": "npx",
      "args": ["-y", "formlabs-local-mcp@1.0.9"]
    }
  }
}
```

Then ask Claude to run `health_check`. If PreFormServer (Formlabs' headless PreForm)
is not installed yet, the server says so and offers the `install_preform_server`
tool, which downloads the current release from Formlabs, verifies Formlabs' code
signature, and installs it into a folder you own. From a shell the same thing is:

```bash
npx -y formlabs-local-mcp@1.0.9 install-preform
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

Fuse X1: PreFormServer 3.63.0 prepares jobs for it (`machine_type` `FUSX-1-0`,
`material_code` `FLP12G01`, 0.11 mm, the one setting it ships) but leaves the
family out of `list-materials`; `list_printer_types` and `list_materials` add it
with an `unlisted` note until Formlabs lists it. No other material or layer
height, and no `auto_pack`, in this release.

No printer yet? PreFormServer ships a built-in virtual printer for every model
(`list_devices` shows them with `connection_type: VIRTUAL`), and
`print_to_printer` with `"Form 4"` runs the whole job upload against one, so a
pipeline can be rehearsed end to end before hardware arrives. The integration
tests do exactly that on macOS, Windows and Linux.
Tracks Formlabs Local API **0.9.30** (PreFormServer 3.63.0). The installer picks the Apple Silicon
build on arm64 Macs and the Intel build elsewhere, falling back to Intel for releases that only ship it.

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
| `PREFORM_SERVER_PATH_STYLE` | `auto` | `wine` writes file paths as Wine's `Z:/...` view of this host; `native` sends them as-is. Auto: `wine` when this server starts PreFormServer through Wine. |
| `PREFORM_PATH_MAP` | unset | `local=remote` pairs, comma separated, for a PreFormServer that mounts your directories elsewhere, e.g. `~/jobs=Z:/jobs` for the preform-linux container. |
| `FORMLABS_ALLOWED_PATHS` | home directory | Directories the model may read from and write to. `:`-separated (`;` on Windows). |
| `FORMLABS_ALLOW_HIDDEN_PATHS` | `0` | Allow paths through dot-directories such as `~/.cache`. |
| `FORMLABS_USERNAME`, `FORMLABS_PASSWORD` | unset | Formlabs account for `login` (remote printing, Fleet Control). `FORMLABS_ACCESS_TOKEN` works too. |
| `FORMLABS_ALLOW_REMOTE_LOGIN` | `0` | Permit `login` against a non-loopback `PREFORM_SERVER_URL`. |
| `PREFORM_REMOTE_HOST` | unset | Run PreFormServer on another machine over ssh (see below). |
| `PREFORM_REMOTE_PORT` | `22` | ssh port for the remote host. |
| `PREFORM_REMOTE_SERVER_PATH` | well-known paths | PreFormServer executable on the remote host. |
| `PREFORM_REMOTE_SPAWN` | `1` | `0` only tunnels to a PreFormServer already running remotely. |
| `PREFORM_INSTALL_UNVERIFIED` | `0` | Linux only: accept a download whose Authenticode signature cannot be checked (install `osslsigncode` instead). |

## Linux

Formlabs ships PreFormServer for macOS and Windows only. Three ways to use it from Linux,
in the order most people should try them:

**A container running PreFormServer under Wine (recommended for servers and
automation).** [preform-linux](https://github.com/mkebiclioglu/preform-linux) packages
the Windows build with Wine and Xvfb, headless, no GPU, signature-checked at first start,
with printers reached by IP or through a Formlabs account. Point this server at it:

```
PREFORM_SERVER_URL=http://127.0.0.1:44388
PREFORM_SERVER_PATH_STYLE=wine
PREFORM_PATH_MAP=/home/me/preform-linux/jobs=Z:/jobs
```

Files under the mapped directory are sent as `Z:/jobs/...`, which is how PreFormServer
inside the container sees them; everything else works exactly as on macOS.

**Wine on this machine.** `install-preform` fetches the Windows build and verifies its
Authenticode signature with `osslsigncode`; the server then starts it through `wine`
with headless defaults (`QT_OPENGL=software`, no Mono/Gecko prompts) and writes file
paths as `Z:/home/me/...` automatically. Needs Wine **11.5 or newer** from
[WineHQ](https://wiki.winehq.org/Ubuntu) (distro Wine 9.0 cannot load PreFormServer
3.63.0) and a display: `PREFORM_LAUNCHER="xvfb-run -a wine"` on a headless box. Wine
11.13+ runs it as is; 11.5 to 11.12 need preform-linux's small `dnsapi.dll` shim. LAN
printer discovery by mDNS does not work under Wine; pass a printer's IP to
`discover_devices` and `print_to_printer` instead, or `login` for Fleet Control. A weekly
[CI job](https://github.com/mkebiclioglu/formlabs-local-mcp/actions/workflows/integration.yml)
runs the smoke test this way.

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
  a lockfile, SHA-pinned GitHub Actions, Dependabot, CodeQL. Releases are published
  from CI with npm provenance and 2FA-only access, so `npm audit signatures` can
  check that what you installed came from a tagged commit here.

One thing this server cannot change: PreFormServer binds to **all network
interfaces** (`*:44388`) and has no option to bind loopback only. On a shared or
untrusted network keep your OS firewall on so other machines cannot reach that port.

## Contributing

```bash
git clone https://github.com/mkebiclioglu/formlabs-local-mcp.git
cd formlabs-local-mcp
npm install
npm test              # unit tests, no PreFormServer needed
npm run typecheck && npm run lint
npm run build
npm run smoke         # end-to-end against a real PreFormServer
```

Issues and PRs are welcome; see [CONTRIBUTING.md](CONTRIBUTING.md) for how to add
a tool and what CI checks. Questions and "here is what I printed" go in
[Discussions](https://github.com/mkebiclioglu/formlabs-local-mcp/discussions).
Security reports: [SECURITY.md](SECURITY.md).

## License

MIT. The Formlabs API itself is covered by the
[Formlabs API License Agreement](https://formlabs.com/legal/formlabs-api-license-agreement/);
this project only makes HTTP calls to PreFormServer and ships no Formlabs code.
Not affiliated with or endorsed by Formlabs Inc.
