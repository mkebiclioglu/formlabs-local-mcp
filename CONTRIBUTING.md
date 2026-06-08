# Contributing

Thanks for your interest! This project is in early alpha — bug reports and
small PRs are very welcome, larger changes are best discussed first.

## Quick setup

```bash
git clone https://github.com/mkebiclioglu/formlabs-local-mcp.git
cd formlabs-local-mcp
python -m venv .venv
source .venv/bin/activate
pip install -e ".[dev]"
pytest
```

## Running against a real PreFormServer

The unit tests use `respx` to mock the HTTP layer, so they don't need
PreFormServer. There's also an end-to-end smoke test in `tests/smoke_e2e.py`
that drives a real PreFormServer:

```bash
PREFORM_SERVER_PATH=/path/to/PreFormServer \
PREFORM_SERVER_PORT=44399 \
python tests/smoke_e2e.py
```

Override the test STL with `FORMLABS_TEST_STL=/abs/path/to/your.stl`.

## What's helpful

- **Hardware validation.** Several tools (`print_to_printer`, firmware ops,
  remote/Fleet Control flows) are spec-driven and have never been validated
  against a real printer. If you have a Formlabs printer and can verify a
  tool actually does what its docstring claims, that's gold.
- **OS coverage.** Development and smoke testing happen on macOS.
  PreFormServer also runs on Windows; reports about Windows quirks are very
  welcome.
- **Niche endpoints.** Some Local API endpoints aren't wrapped yet
  (`label_part`, `scan_to_model`, `detect_thin_walls`, `interferences`,
  `save_fps_file`, `upload_firmware`). PRs adding any of these with a test
  are welcome.

## Style

- Match what's there: type hints, async functions, short docstrings that
  explain the *why* and the surprising defaults (e.g. `REPAIR` for imports).
- Don't add comments that just restate the code.
- New tools go in `src/formlabs_local_mcp/server.py` next to similar ones.

## Questions vs. bug reports

- Open a [Discussion](https://github.com/mkebiclioglu/formlabs-local-mcp/discussions)
  for questions, "I tried it and...", or design ideas.
- Open an [Issue](https://github.com/mkebiclioglu/formlabs-local-mcp/issues)
  for reproducible bugs (with the issue template filled out) or scoped
  feature requests.
