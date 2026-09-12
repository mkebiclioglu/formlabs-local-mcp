## What does this change?

<!-- One or two sentences. Link the issue if there is one: "Fixes #12". -->

## How was it tested?

- [ ] `npm test` passes
- [ ] `npm run typecheck && npm run lint` pass
- [ ] `npm run smoke` against a real PreFormServer (only needed if you changed a request body or a tool)

## Checklist

- [ ] New or changed tools have a test in `test/tools.test.ts`
- [ ] File-path parameters go through the path guards (`inputPath` / `outputPath`)
- [ ] README updated if a tool, command or environment variable changed
