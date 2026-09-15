# Deploying to Vercel

The Vercel project `formbridge-mcp` is deployed with three files (package.json,
vercel.json, bootstrap.sh) uploaded through the Vercel MCP `deploy_to_vercel` tool.
`bootstrap.sh` runs as the install command: it clones the `cloud` branch of this
repository, copies `cloud/` into the build directory, writes
`lib/runtime-env.generated.ts` with the deployment's configuration (Supabase URL,
anon key, service-account credentials, public URL) and runs `npm ci`. `next build`
then runs as usual. Redeploying = re-uploading the same three files; the code
comes from git. Keep the real bootstrap (it contains the service password) out
of the repository; `bootstrap.example.sh` shows the shape.
