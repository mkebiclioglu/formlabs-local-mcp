# Contributing

Thanks for helping. Bug reports, docs fixes and small PRs are welcome any time.
For a larger change (a new tool family, a new mode) open an issue or a
[Discussion](https://github.com/mkebiclioglu/formlabs-local-mcp/discussions)
first so we can agree on the shape before you spend time on it.

## Ways to help that need no code

- Tell us what printer, material and OS you used it with, and what broke, in
  [Show and tell](https://github.com/mkebiclioglu/formlabs-local-mcp/discussions/categories/show-and-tell).
- Report a tool whose description confused the model (the docstrings are the
  prompt the model reads; better wording is a real fix).
- Try the `help wanted` and `good first issue` labels on the issue tracker.

## Setup

```bash
git clone https://github.com/mkebiclioglu/formlabs-local-mcp.git
cd formlabs-local-mcp
npm install
npm test                          # unit tests, no PreFormServer needed
npm run typecheck && npm run lint
npm run build
```

To try your build from a real MCP client, point it at the working tree:

```bash
claude mcp add --scope user formlabs-dev -- node /path/to/formlabs-local-mcp/dist/index.js
```

`npm run smoke` exercises a real PreFormServer (auto-detected, or set
`PREFORM_SERVER_PATH`). Run it before opening a PR that touches request bodies.
The "Integration" workflow does the same on macOS and Windows runners and on
Linux under Wine; a maintainer can trigger it from the Actions tab.

## Pull requests

1. Branch from `main`. Keep one change per PR.
2. Add or update a test. `npm test`, `npm run typecheck` and `npm run lint` must
   pass; CI runs them on Linux, macOS and Windows with Node 20 and 22.
3. Update the README if a tool, command or environment variable changed.
4. Fill in the PR template. Short commit messages are fine.

Every PR needs a passing CI run and a maintainer merge; `main` cannot be pushed
to directly.

## Adding a tool

- Check request and response shapes in the
  [Local API reference](https://formlabs.com/support/Formlabs-API-downloads-and-release-notes)
  for the version noted in the README.
- Add it to `src/tools.ts` next to similar tools. Any parameter that is a file
  path must go through `inputPath` / `outputPath` and the backend's
  `stageInput` / `outputPath` so remote mode keeps working.
- Long-running endpoints use `client.postAsync` / `client.getAsync`.
- Pick the right annotation constant (`READ_ONLY`, `MUTATING`, `DESTRUCTIVE`).
- Add a test in `test/tools.test.ts` against the fake PreFormServer.
- Docstrings are what the model reads: say when to use the tool and what the
  surprising defaults are.

## Security issues

See [SECURITY.md](SECURITY.md). Please report privately rather than in an issue.

## Releasing (maintainers)

1. Bump `version` in `package.json` and the pinned `formlabs-local-mcp@X.Y.Z`
   in the README on a branch (CI checks they agree), merge it.
2. Tag the merge commit `vX.Y.Z` and push the tag. The Release workflow runs the
   tests, packs the tarball, attaches it to a GitHub release, and publishes to
   npm through trusted publishing with provenance.
3. In [formlabs-claude-skills](https://github.com/mkebiclioglu/formlabs-claude-skills)
   update the pinned npm version (`.mcp.json`, `docs/install.sh`,
   `docs/install.ps1`, `docs/index.html`) and bump the plugin version.
