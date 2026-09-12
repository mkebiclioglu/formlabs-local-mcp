# Contributing

Bug reports and small PRs are welcome. Larger changes are best discussed in an
issue first.

## Setup

```bash
uv sync --extra dev
uv run pytest
uv run ruff check . && uv run ruff format --check .
```

`tests/smoke_e2e.py` exercises a real PreFormServer (auto-detected from
`/Applications`, or set `PREFORM_SERVER_PATH`). Run it before opening a PR that
touches request bodies.

## Adding a tool

- Check the request and response shapes in the
  [Local API reference](https://formlabs.com/support/Formlabs-API-downloads-and-release-notes)
  for the version noted in the README.
- Any parameter that is a file path must go through `paths.input_path` or
  `paths.output_path`.
- Long-running endpoints use `post_async_operation` / `get_async_operation`.
- Pick the right `ToolAnnotations` constant (`READ_ONLY`, `MUTATING`, `DESTRUCTIVE`).
- Docstrings are what the model reads. Say when to use the tool and what the
  surprising defaults are; skip restating parameter names.

## Style

Type hints, async functions, ruff-formatted, 100 columns.
