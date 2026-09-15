-- Formbridge: hosted MCP access layer for Formlabs workflows.
-- All tables are owned by a user through environments.user_id. Row level
-- security lets the dashboard read with the user's own session, while the
-- MCP endpoint and connector API act through a dedicated service account
-- (public.service_accounts) because this deployment has no service-role key.

create extension if not exists pgcrypto;

-- ---------------------------------------------------------------------------
-- Service account + helpers
-- ---------------------------------------------------------------------------
create table public.service_accounts (
  user_id uuid primary key references auth.users(id) on delete cascade,
  created_at timestamptz not null default now()
);
alter table public.service_accounts enable row level security;
-- no policies: only reachable through security definer functions.

create or replace function public.is_service() returns boolean
language sql stable security definer set search_path = public as $$
  select exists (select 1 from public.service_accounts where user_id = auth.uid());
$$;

-- ---------------------------------------------------------------------------
-- Profiles
-- ---------------------------------------------------------------------------
create table public.profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  email text,
  display_name text,
  created_at timestamptz not null default now()
);
alter table public.profiles enable row level security;
create policy "profiles: own or service" on public.profiles
  for all using (id = auth.uid() or public.is_service()) with check (id = auth.uid() or public.is_service());

-- ---------------------------------------------------------------------------
-- Environments (a simulated demo farm or a connected real PreForm machine)
-- ---------------------------------------------------------------------------
create table public.environments (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  name text not null,
  kind text not null check (kind in ('simulated', 'connected')),
  sim_speed numeric not null default 60,          -- simulated seconds per real second
  auto_start_queued boolean not null default true,
  failure_rate numeric not null default 0.08,     -- chance a simulated job fails
  connector_last_seen_at timestamptz,
  connector_info jsonb,                            -- {version, hostname, platform, preform}
  devices_snapshot jsonb,                          -- last list_devices from the connector
  created_at timestamptz not null default now()
);
create index environments_user_idx on public.environments(user_id);
alter table public.environments enable row level security;
create policy "environments: owner or service" on public.environments
  for all using (user_id = auth.uid() or public.is_service()) with check (user_id = auth.uid() or public.is_service());

create or replace function public.owns_environment(env uuid) returns boolean
language sql stable security definer set search_path = public as $$
  select exists (select 1 from public.environments e where e.id = env and e.user_id = auth.uid());
$$;


-- ---------------------------------------------------------------------------
-- API tokens: 'mcp' tokens are used by MCP clients, 'connector' tokens by the
-- local connector. Only a SHA-256 hash is stored.
-- ---------------------------------------------------------------------------
create table public.api_tokens (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  environment_id uuid not null references public.environments(id) on delete cascade,
  kind text not null check (kind in ('mcp', 'connector')),
  name text not null,
  token_hash text not null unique,
  token_prefix text not null,
  last_used_at timestamptz,
  revoked_at timestamptz,
  created_at timestamptz not null default now()
);
create index api_tokens_env_idx on public.api_tokens(environment_id);
alter table public.api_tokens enable row level security;
create policy "api_tokens: owner or service" on public.api_tokens
  for all using (user_id = auth.uid() or public.is_service()) with check (user_id = auth.uid() or public.is_service());

-- ---------------------------------------------------------------------------
-- Tool policies: per environment, per tool. Missing rows fall back to defaults.
-- ---------------------------------------------------------------------------
create table public.tool_policies (
  environment_id uuid not null references public.environments(id) on delete cascade,
  tool text not null,
  mode text not null check (mode in ('allow', 'approve', 'deny')),
  updated_at timestamptz not null default now(),
  primary key (environment_id, tool)
);
alter table public.tool_policies enable row level security;
create policy "tool_policies: owner or service" on public.tool_policies
  for all using (public.owns_environment(environment_id) or public.is_service())
  with check (public.owns_environment(environment_id) or public.is_service());

-- ---------------------------------------------------------------------------
-- Approvals: a gated tool call waiting for a human decision.
-- ---------------------------------------------------------------------------
create table public.approvals (
  id uuid primary key default gen_random_uuid(),
  environment_id uuid not null references public.environments(id) on delete cascade,
  token_id uuid references public.api_tokens(id) on delete set null,
  tool text not null,
  args jsonb not null default '{}'::jsonb,
  summary text not null,
  status text not null default 'pending' check (status in ('pending', 'approved', 'denied', 'expired', 'executed', 'failed')),
  result jsonb,
  error text,
  requested_at timestamptz not null default now(),
  decided_at timestamptz,
  decided_by uuid references auth.users(id) on delete set null,
  expires_at timestamptz not null default now() + interval '24 hours'
);
create index approvals_env_status_idx on public.approvals(environment_id, status, requested_at desc);
alter table public.approvals enable row level security;
create policy "approvals: owner or service" on public.approvals
  for all using (public.owns_environment(environment_id) or public.is_service())
  with check (public.owns_environment(environment_id) or public.is_service());

-- ---------------------------------------------------------------------------
-- MCP activity: one row per tool call through the hosted endpoint.
-- ---------------------------------------------------------------------------
create table public.mcp_activity (
  id uuid primary key default gen_random_uuid(),
  environment_id uuid not null references public.environments(id) on delete cascade,
  token_id uuid references public.api_tokens(id) on delete set null,
  tool text not null,
  args jsonb,
  status text not null check (status in ('ok', 'error', 'denied', 'pending_approval', 'running')),
  duration_ms integer,
  error text,
  result_summary text,
  client_name text,
  approval_id uuid references public.approvals(id) on delete set null,
  created_at timestamptz not null default now()
);
create index mcp_activity_env_idx on public.mcp_activity(environment_id, created_at desc);
alter table public.mcp_activity enable row level security;
create policy "mcp_activity: owner or service" on public.mcp_activity
  for all using (public.owns_environment(environment_id) or public.is_service())
  with check (public.owns_environment(environment_id) or public.is_service());

-- ---------------------------------------------------------------------------
-- Audit log: security-relevant events by humans, agents, connectors, system.
-- ---------------------------------------------------------------------------
create table public.audit_log (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  environment_id uuid references public.environments(id) on delete cascade,
  actor text not null check (actor in ('user', 'agent', 'connector', 'system')),
  action text not null,
  target text,
  details jsonb,
  created_at timestamptz not null default now()
);
create index audit_log_user_idx on public.audit_log(user_id, created_at desc);
alter table public.audit_log enable row level security;
create policy "audit_log: owner or service" on public.audit_log
  for all using (user_id = auth.uid() or public.is_service()) with check (user_id = auth.uid() or public.is_service());

-- ---------------------------------------------------------------------------
-- Relay: tool calls forwarded to the local connector of a connected environment.
-- ---------------------------------------------------------------------------
create table public.relay_requests (
  id uuid primary key default gen_random_uuid(),
  environment_id uuid not null references public.environments(id) on delete cascade,
  tool text not null,
  args jsonb not null default '{}'::jsonb,
  status text not null default 'pending' check (status in ('pending', 'running', 'done', 'failed', 'expired')),
  progress numeric,
  progress_message text,
  result jsonb,
  error text,
  created_at timestamptz not null default now(),
  claimed_at timestamptz,
  finished_at timestamptz
);
create index relay_requests_env_status_idx on public.relay_requests(environment_id, status, created_at);
alter table public.relay_requests enable row level security;
create policy "relay_requests: owner or service" on public.relay_requests
  for all using (public.owns_environment(environment_id) or public.is_service())
  with check (public.owns_environment(environment_id) or public.is_service());

-- Atomic claim used by the connector poll endpoint.
create or replace function public.claim_relay_request(env uuid) returns setof public.relay_requests
language plpgsql security definer set search_path = public as $$
begin
  if not public.is_service() then
    raise exception 'not allowed';
  end if;
  return query
    update public.relay_requests r
       set status = 'running', claimed_at = now()
     where r.id = (
       select id from public.relay_requests
        where environment_id = env and status = 'pending'
        order by created_at
        for update skip locked
        limit 1)
    returning r.*;
end;
$$;

-- ---------------------------------------------------------------------------
-- Simulated printers, scenes, jobs, artifacts
-- ---------------------------------------------------------------------------
create table public.sim_printers (
  id uuid primary key default gen_random_uuid(),
  environment_id uuid not null references public.environments(id) on delete cascade,
  serial text not null,                 -- e.g. Form4-BrightOtter
  alias text,
  machine_type text not null,           -- FORM-4-0, FS30-1-0 ...
  product_name text not null,           -- Form 4, Fuse 1+ 30W
  technology text not null check (technology in ('SLA', 'SLS')),
  status text not null default 'IDLE',  -- IDLE, PRINTING, PAUSED, FINISHED, ERROR, OFFLINE, PREHEATING, COOLING
  online boolean not null default true,
  ip_address text,
  firmware_version text,
  tank jsonb,                            -- {material_code, installed_at, ml_printed, max_ml}
  cartridge jsonb,                       -- {material_code, remaining_ml, capacity_ml}
  powder jsonb,                          -- SLS: {material_code, hopper_kg, capacity_kg, refresh_rate}
  current_job_id uuid,
  error jsonb,                           -- {code, message, since}
  quirks jsonb not null default '{}'::jsonb,
  print_count integer not null default 0,
  print_hours numeric not null default 0,
  state_changed_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  unique (environment_id, serial)
);
create index sim_printers_env_idx on public.sim_printers(environment_id);
alter table public.sim_printers enable row level security;
create policy "sim_printers: owner or service" on public.sim_printers
  for all using (public.owns_environment(environment_id) or public.is_service())
  with check (public.owns_environment(environment_id) or public.is_service());

create table public.sim_scenes (
  id uuid primary key default gen_random_uuid(),
  environment_id uuid not null references public.environments(id) on delete cascade,
  scene_key text not null,               -- the id MCP clients use ("default" or generated)
  machine_type text not null,
  material_code text not null,
  layer_thickness_mm text not null,      -- number or ADAPTIVE, stored as text
  print_setting text not null default 'DEFAULT',
  models jsonb not null default '[]'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (environment_id, scene_key)
);
alter table public.sim_scenes enable row level security;
create policy "sim_scenes: owner or service" on public.sim_scenes
  for all using (public.owns_environment(environment_id) or public.is_service())
  with check (public.owns_environment(environment_id) or public.is_service());

create table public.print_jobs (
  id uuid primary key default gen_random_uuid(),
  environment_id uuid not null references public.environments(id) on delete cascade,
  printer_id uuid references public.sim_printers(id) on delete set null,
  printer_serial text not null,
  name text not null,
  status text not null default 'queued' check (status in ('queued', 'printing', 'paused', 'finished', 'failed', 'aborted', 'submitted')),
  source text not null default 'mcp' check (source in ('mcp', 'dashboard', 'seed', 'connector')),
  token_id uuid references public.api_tokens(id) on delete set null,
  machine_type text,
  material_code text,
  layer_thickness_mm text,
  model_count integer not null default 0,
  volume_ml numeric,
  layer_count integer,
  height_mm numeric,
  estimated_seconds integer,
  scene_snapshot jsonb,
  fail_at_fraction numeric,             -- simulated: the job fails when progress reaches this fraction
  failure jsonb,                        -- {code, message}
  progress numeric not null default 0,
  queued_at timestamptz not null default now(),
  started_at timestamptz,
  finished_at timestamptz,
  external_job_id text                  -- real environments: the job id PreForm returned
);
create index print_jobs_env_idx on public.print_jobs(environment_id, queued_at desc);
create index print_jobs_printer_idx on public.print_jobs(printer_id, status);
alter table public.print_jobs enable row level security;
create policy "print_jobs: owner or service" on public.print_jobs
  for all using (public.owns_environment(environment_id) or public.is_service())
  with check (public.owns_environment(environment_id) or public.is_service());

create table public.sim_artifacts (
  id uuid primary key default gen_random_uuid(),
  environment_id uuid not null references public.environments(id) on delete cascade,
  path text not null,
  kind text not null check (kind in ('form', 'png', 'webp', 'fps')),
  scene_snapshot jsonb,
  created_at timestamptz not null default now()
);
alter table public.sim_artifacts enable row level security;
create policy "sim_artifacts: owner or service" on public.sim_artifacts
  for all using (public.owns_environment(environment_id) or public.is_service())
  with check (public.owns_environment(environment_id) or public.is_service());

-- ---------------------------------------------------------------------------
-- Signup helper: confirm a freshly created user's email so that password
-- login works even when the project requires email confirmation. Only the
-- service account may call it, and only within a minute of signup.
-- ---------------------------------------------------------------------------
create or replace function public.confirm_new_user(uid uuid) returns void
language plpgsql security definer set search_path = public, auth as $$
begin
  if not public.is_service() then
    raise exception 'not allowed';
  end if;
  update auth.users
     set email_confirmed_at = coalesce(email_confirmed_at, now())
   where id = uid and created_at > now() - interval '1 minute';
end;
$$;

-- ---------------------------------------------------------------------------
-- Profile row on signup
-- ---------------------------------------------------------------------------
create or replace function public.handle_new_user() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  insert into public.profiles (id, email) values (new.id, new.email) on conflict (id) do nothing;
  return new;
end;
$$;
create trigger on_auth_user_created after insert on auth.users
  for each row execute procedure public.handle_new_user();

revoke all on function public.claim_relay_request(uuid) from public;
grant execute on function public.claim_relay_request(uuid) to authenticated;
revoke all on function public.confirm_new_user(uuid) from public;
grant execute on function public.confirm_new_user(uuid) to authenticated;
