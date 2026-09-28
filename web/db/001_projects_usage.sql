-- The web app's tables: a project per mock, and a row per model call.
--
-- The app's server reaches them only through the ms_* functions below, each of which first checks
-- the server's key: the database keeps the key's SHA-256 (private.keys, written apart from this
-- file), never the key. Row-level security is on everywhere; a signed-in person may read their own
-- projects directly, and nothing else is readable or writable from outside.

create schema if not exists private;
revoke all on schema private from public, anon, authenticated;

create table if not exists private.keys (name text primary key, sha256 text not null);

create or replace function private.allow(k text) returns void
language plpgsql security definer set search_path = '' as $$
begin
  if k is null or not exists (
    select 1 from private.keys where name = 'server' and sha256 = encode(pg_catalog.sha256(convert_to(k, 'UTF8')), 'hex')
  ) then
    raise exception 'not allowed' using errcode = '42501';
  end if;
end $$;

-- A project: its mock and everything that goes with it (trial/engine.mjs save()), whose it is, and
-- `rev`, which every save moves on by one, so two saves from the same state cannot both land.
-- `anon` is the browser that made it before anyone signed in; `claim_email` the address a sign-in
-- link was sent to from that browser, so the link claims the project even opened elsewhere.
-- `ip` (a hash) and `built_at` count the builds made without an account.
create table if not exists public.projects (
  id text primary key check (id ~ '^[a-z0-9]{8,40}$'),
  owner uuid,
  anon text,
  claim_email text,
  ip text,
  title text not null default '',
  screens int not null default 0,
  state jsonb not null,
  rev int not null default 1,
  built_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists projects_owner on public.projects (owner, updated_at desc);
create index if not exists projects_anon on public.projects (anon) where owner is null;
create index if not exists projects_ip on public.projects (ip, built_at);
alter table public.projects enable row level security;
drop policy if exists "own projects" on public.projects;
create policy "own projects" on public.projects for select to authenticated using (owner = (select auth.uid()));

-- One row per model call: the writer's (Anthropic, or OpenRouter through the provider switch) and
-- Jev's (TypeSafe). `input_tokens` is what was billed at the full input rate; cache reads and
-- writes are apart, as the API reports them. `sentence` groups the calls one request made.
create table if not exists public.usage_events (
  id bigint generated always as identity primary key,
  created_at timestamptz not null default now(),
  user_id uuid,
  anon text,
  project text,
  sentence text,
  provider text not null,
  model text not null,
  purpose text not null,
  input_tokens int not null default 0,
  output_tokens int not null default 0,
  cache_read_tokens int not null default 0,
  cache_write_tokens int not null default 0,
  jev_questions int,
  ms int,
  first_line_ms int,
  status text not null,
  cost_usd numeric(14, 8)
);
create index if not exists usage_events_at on public.usage_events (created_at);
alter table public.usage_events enable row level security;

-- ---- the server's functions -------------------------------------------------------------------

create or replace function public.ms_get(k text, p_id text) returns setof public.projects
language plpgsql security definer set search_path = '' as $$
begin
  perform private.allow(k);
  return query select * from public.projects where id = p_id;
end $$;

create or replace function public.ms_create(k text, p_id text, p_owner uuid, p_anon text, p_ip text, p_state jsonb) returns setof public.projects
language plpgsql security definer set search_path = '' as $$
begin
  perform private.allow(k);
  return query insert into public.projects (id, owner, anon, ip, state) values (p_id, p_owner, p_anon, p_ip, p_state) returning *;
end $$;

-- Saved only over the state it was opened from: the new rev, or 0 when another save got there first.
create or replace function public.ms_save(k text, p_id text, p_rev int, p_state jsonb, p_title text, p_screens int) returns int
language plpgsql security definer set search_path = '' as $$
declare r int;
begin
  perform private.allow(k);
  update public.projects
     set state = p_state, title = p_title, screens = p_screens, rev = rev + 1, updated_at = now(),
         built_at = case when built_at is null and p_screens > 0 then now() else built_at end
   where id = p_id and rev = p_rev
  returning rev into r;
  return coalesce(r, 0);
end $$;

create or replace function public.ms_list(k text, p_owner uuid) returns table (id text, title text, screens int, created_at timestamptz, updated_at timestamptz)
language plpgsql security definer set search_path = '' as $$
begin
  perform private.allow(k);
  return query select p.id, p.title, p.screens, p.created_at, p.updated_at from public.projects p where p.owner = p_owner order by p.updated_at desc;
end $$;

create or replace function public.ms_delete(k text, p_id text, p_owner uuid) returns int
language plpgsql security definer set search_path = '' as $$
declare n int;
begin
  perform private.allow(k);
  delete from public.projects where id = p_id and owner = p_owner;
  get diagnostics n = row_count;
  return n;
end $$;

-- A sign-in link sent from a browser: that browser's projects wait for the address it went to.
create or replace function public.ms_expect(k text, p_anon text, p_email text) returns int
language plpgsql security definer set search_path = '' as $$
declare n int;
begin
  perform private.allow(k);
  update public.projects set claim_email = lower(p_email) where anon = p_anon and owner is null;
  get diagnostics n = row_count;
  return n;
end $$;

-- Signed in: this browser's projects, and those waiting for this address from the last day, are the
-- person's now.
create or replace function public.ms_claim(k text, p_owner uuid, p_anon text, p_email text) returns int
language plpgsql security definer set search_path = '' as $$
declare n int;
begin
  perform private.allow(k);
  update public.projects set owner = p_owner, anon = null, claim_email = null
   where owner is null
     and ((p_anon is not null and anon = p_anon)
       or (p_email is not null and claim_email = lower(p_email) and updated_at > now() - interval '1 day'));
  get diagnostics n = row_count;
  return n;
end $$;

-- Builds made without an account from one address (hashed) in the last day.
create or replace function public.ms_anon_builds(k text, p_ip text) returns int
language plpgsql security definer set search_path = '' as $$
begin
  perform private.allow(k);
  return (select count(*) from public.projects where ip = p_ip and built_at > now() - interval '1 day');
end $$;

create or replace function public.ms_use(k text, p_rows jsonb) returns int
language plpgsql security definer set search_path = '' as $$
declare n int;
begin
  perform private.allow(k);
  insert into public.usage_events (user_id, anon, project, sentence, provider, model, purpose, input_tokens, output_tokens,
                                   cache_read_tokens, cache_write_tokens, jev_questions, ms, first_line_ms, status, cost_usd)
  select user_id, anon, project, sentence, provider, model, purpose, coalesce(input_tokens, 0), coalesce(output_tokens, 0),
         coalesce(cache_read_tokens, 0), coalesce(cache_write_tokens, 0), jev_questions, ms, first_line_ms, status, cost_usd
    from jsonb_to_recordset(p_rows) as x(user_id uuid, anon text, project text, sentence text, provider text, model text, purpose text,
                                          input_tokens int, output_tokens int, cache_read_tokens int, cache_write_tokens int,
                                          jev_questions int, ms int, first_line_ms int, status text, cost_usd numeric);
  get diagnostics n = row_count;
  return n;
end $$;

-- The admin page's rows: every call since a time, with the address of whoever made it.
create or replace function public.ms_usage(k text, p_since timestamptz) returns table (
  created_at timestamptz, user_id uuid, email text, anon text, project text, sentence text, provider text, model text, purpose text,
  input_tokens int, output_tokens int, cache_read_tokens int, cache_write_tokens int, jev_questions int, ms int, status text, cost_usd numeric)
language plpgsql security definer set search_path = '' as $$
begin
  perform private.allow(k);
  return query
    select u.created_at, u.user_id, a.email::text, u.anon, u.project, u.sentence, u.provider, u.model, u.purpose,
           u.input_tokens, u.output_tokens, u.cache_read_tokens, u.cache_write_tokens, u.jev_questions, u.ms, u.status, u.cost_usd
      from public.usage_events u left join auth.users a on a.id = u.user_id
     where u.created_at >= p_since
     order by u.created_at;
end $$;

-- The server calls these with the project's publishable key, as the anon role, and each checks the
-- server key before anything else; a signed-in person's token has no use for them. The private
-- helper is not callable from outside at all. (Supabase's advisor lists every ms_* function as
-- "public can execute SECURITY DEFINER": that is this, by design.)
revoke all on function private.allow(text) from public, anon, authenticated;
grant usage on schema private to postgres;
do $$
declare f record;
begin
  for f in select p.oid::regprocedure as sig from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'public' and p.proname like 'ms\_%' loop
    execute format('revoke execute on function %s from public, authenticated', f.sig);
    execute format('grant execute on function %s to anon, service_role', f.sig);
  end loop;
end $$;
