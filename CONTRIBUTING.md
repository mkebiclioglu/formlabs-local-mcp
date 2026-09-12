# Contributing

Bug reports and small PRs are welcome. Larger changes are best discussed in an
issue first.

## Setup

```bash
npm install
npm test
npm run typecheck && npm run lint
```

`npm run smoke` exercises a real PreFormServer (auto-detected, or set
`PREFORM_SERVER_PATH`). Run it before opening a PR that touches request bodies.
The "Integration" workflow does the same on macOS and Windows runners, plus the
Wine experiment on Linux; trigger it from the Actions tab.

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

## Releasing

Bump `version` in `package.json`, merge, then tag `vX.Y.Z`. The release workflow
runs the tests, packs the tarball, and attaches it to the GitHub release. The
plugin in formlabs-claude-skills pins that tarball URL.
