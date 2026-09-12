# Security

## Reporting a vulnerability

Please do not open a public issue for security problems. Use GitHub's private
reporting instead: **Security → Report a vulnerability** on this repository
(https://github.com/mkebiclioglu/formlabs-local-mcp/security/advisories/new).
You will get a reply within a few days. Once a fix is released the report is
credited in the release notes unless you ask otherwise.

In scope: anything in this package (the MCP server, the `install-preform` and
`doctor` commands, remote mode) that lets a prompt, a model file, a network peer
or a downloaded artifact do something the README says it cannot. Bugs in
PreFormServer itself belong to Formlabs (https://formlabs.com/security/).

## Supported versions

Only the latest release on npm receives fixes. Pin an exact version in your MCP
client config and bump it when a new release appears.

## Verifying what you install

Every release is published from GitHub Actions with
[npm provenance](https://docs.npmjs.com/generating-provenance-statements), so
the tarball on npm is traceable to a tagged commit in this repository:

```bash
npm audit signatures            # in a project that depends on formlabs-local-mcp
npm view formlabs-local-mcp dist.attestations
```

Publishing to npm requires 2FA and goes through trusted publishing (OIDC); there
is no long-lived npm token anywhere. The package has two runtime dependencies,
ships a lockfile, and every GitHub Action it uses is pinned to a commit SHA.

## What the server does to protect you

The short version, with details in the README's Security section:

- File paths must be absolute, resolve under `FORMLABS_ALLOWED_PATHS` (your home
  directory by default), avoid hidden directories, and have the right extension.
- `install_preform_server` downloads only from `downloads.formlabs.com` over
  HTTPS and verifies Formlabs' code signature before anything is moved into place.
- `login` reads credentials from the environment and never returns tokens to the
  model. It refuses non-loopback servers unless you opt in.
- PreFormServer runs only while an MCP client is connected, with telemetry off.

One limitation to know: PreFormServer listens on all network interfaces on port
44388 and has no option to bind loopback only. Keep your OS firewall on when you
are on a network you do not trust.
