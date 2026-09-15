# Formbridge (cloud/)

The hosted, permissioned version of `formlabs-local-mcp`: a web app where you sign
up, get a simulated Formlabs print farm, create an MCP token, and point Claude
Code, Codex, Cursor or any Streamable-HTTP MCP client at one URL. Sensitive tools
(`print_to_printer`, `install_preform_server`, `login`) wait for human approval in
the dashboard; every call is logged. A one-command connector (`formlabs-local-mcp
connect`) links a real PreForm machine, and agents use exactly the same tools.

Not affiliated with or endorsed by Formlabs Inc.

## Layout

```
app/                      Next.js 16 app router
  api/mcp/route.ts        the hosted MCP endpoint (bearer token, per-environment tools)
  api/connector/[action]  hello / poll / result / progress / heartbeat used by the connector
  app/                    dashboard: overview, environments, approvals, activity, audit, tokens, connect
  auth-actions.ts         sign up / sign in / sign out (Supabase auth)
lib/mcp/catalog.ts        tool names, schemas, annotations and default policies (mirrors ../src/tools.ts)
lib/mcp/execute.ts        policy gate, approvals, dispatch to simulator or connector relay, activity log
lib/sim/                  the simulator: catalog (printers, materials), parts (sample library, STL measuring),
                          engine (scenes, estimates, printer state machine), store (Postgres), tools (MCP impl)
lib/relay.ts              forwards calls to the connector via relay_requests
supabase/migrations/      schema with row level security
test/                     vitest: simulator engine + tool parity with the local server
```

## How the simulator behaves

- Six seeded printers per demo farm (Form 4 x3, Form 4L, Form 3+, Fuse 1+ 30W) with
  tanks, cartridges or powder, firmware, IPs, print history and one print in progress.
- Time is virtual: `sim_speed` simulated seconds per real second (default 30x).
  Printers are advanced lazily on every read, so no worker or cron is needed.
- Jobs go queued -> printing -> finished (or failed at a rolled fraction with a
  PreForm-style error: PART_DETACHED, SUPPORT_FAILURE, TANK_FILM_DAMAGED, ...).
  Cartridges deplete and pause the printer with CARTRIDGE_EMPTY when dry; Fuse jobs
  show PREHEATING / PRINTING / COOLING. Finished platforms auto-clear after 20
  simulated minutes or when you click "Remove part".
- Prep tools mutate scene state the way PreForm does: orientation invalidates
  supports, validation reports cups and unsupported minima until you orient,
  support and add drain holes, layouts refuse parts that do not fit, SLS scenes
  refuse SLA-only tools.
- `import_model` accepts `sample:<name>`, an https STL URL (downloaded and
  measured: bounding box, volume, triangle count) or any file name (deterministic
  derived geometry).

## Running locally

```bash
cd cloud
cp .env.local.example .env.local   # fill in Supabase URL/anon key and the service account
npm install
npm test
npm run dev
```

Environment variables:

| Variable | Purpose |
|---|---|
| `NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_ANON_KEY` | Supabase project |
| `FORMBRIDGE_SERVICE_EMAIL`, `FORMBRIDGE_SERVICE_PASSWORD` | Service account listed in `public.service_accounts`; the MCP endpoint and connector API act as this user (RLS grants it access through `is_service()`), because no service-role key is used. |
| `NEXT_PUBLIC_APP_URL` | Public URL (falls back to Vercel's project URL) |

Apply `supabase/migrations/*.sql` in order, sign up the service account once
(`supabase.auth.signUp`), confirm it and insert its id into `public.service_accounts`.
