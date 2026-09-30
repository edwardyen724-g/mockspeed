-- What each account may do in a day, and what it has paid for.
--
-- A change is one sentence said to a mock — typed in the editor or the chat's panel, or sent by the
-- person's own AI with `say` — and each is kept as a usage row of its own (provider 'mockspeed',
-- purpose 'change'), with where it came from (`via`: editor, panel or ai). Toolbar edits, undo,
-- offers taken and answers are not changes: they carry on one already counted. The count starts
-- again at midnight UTC.
--
-- `accounts` holds what a person has paid for: 'paid' while their Stripe subscription is active.
-- An account with no row is on the free plan.

alter table public.usage_events add column if not exists via text;

create table if not exists public.accounts (
  user_id uuid primary key,
  plan text not null default 'free' check (plan in ('free', 'paid')),
  stripe_customer text,
  stripe_subscription text,
  stripe_status text,
  updated_at timestamptz not null default now()
);
alter table public.accounts enable row level security;

create or replace function public.ms_use(k text, p_rows jsonb) returns int
language plpgsql security definer set search_path = '' as $$
declare n int;
begin
  perform private.allow(k);
  insert into public.usage_events (user_id, anon, project, sentence, provider, model, purpose, input_tokens, output_tokens,
                                   cache_read_tokens, cache_write_tokens, jev_questions, ms, first_line_ms, status, cost_usd, origin, via)
  select user_id, anon, project, sentence, provider, model, purpose, coalesce(input_tokens, 0), coalesce(output_tokens, 0),
         coalesce(cache_read_tokens, 0), coalesce(cache_write_tokens, 0), jev_questions, ms, first_line_ms, status, cost_usd, origin, via
    from jsonb_to_recordset(p_rows) as x(user_id uuid, anon text, project text, sentence text, provider text, model text, purpose text,
                                          input_tokens int, output_tokens int, cache_read_tokens int, cache_write_tokens int,
                                          jev_questions int, ms int, first_line_ms int, status text, cost_usd numeric, origin text, via text);
  get diagnostics n = row_count;
  return n;
end $$;

drop function if exists public.ms_usage(text, timestamptz);
create function public.ms_usage(k text, p_since timestamptz) returns table (
  created_at timestamptz, user_id uuid, email text, anon text, project text, sentence text, provider text, model text, purpose text,
  input_tokens int, output_tokens int, cache_read_tokens int, cache_write_tokens int, jev_questions int, ms int, status text, cost_usd numeric,
  origin text, via text)
language plpgsql security definer set search_path = '' as $$
begin
  perform private.allow(k);
  return query
    select u.created_at, u.user_id, a.email::text, u.anon, u.project, u.sentence, u.provider, u.model, u.purpose,
           u.input_tokens, u.output_tokens, u.cache_read_tokens, u.cache_write_tokens, u.jev_questions, u.ms, u.status, u.cost_usd,
           u.origin, u.via
      from public.usage_events u left join auth.users a on a.id = u.user_id
     where u.created_at >= p_since
     order by u.created_at;
end $$;

create index if not exists usage_events_changes on public.usage_events (user_id, created_at) where purpose = 'change';

-- Before a change: the account's plan, its changes since midnight UTC, and what every model call
-- since then has cost, all accounts together (the daily spend cap). One call, so a change waits on
-- the store once.
create or replace function public.ms_gate(k text, p_user uuid) returns table (plan text, changes int, spend numeric)
language plpgsql security definer set search_path = '' as $$
declare midnight timestamptz := date_trunc('day', now() at time zone 'utc') at time zone 'utc';
begin
  perform private.allow(k);
  return query select
    coalesce((select a.plan from public.accounts a where a.user_id = p_user), 'free'),
    (select count(*)::int from public.usage_events u where p_user is not null and u.user_id = p_user and u.purpose = 'change' and u.created_at >= midnight),
    (select coalesce(sum(u.cost_usd), 0) from public.usage_events u where u.created_at >= midnight);
end $$;

-- What Stripe says of an account's subscription: paid while it is active (or trialing, or past due
-- while Stripe retries the card).
create or replace function public.ms_set_plan(k text, p_user uuid, p_customer text, p_subscription text, p_status text) returns text
language plpgsql security definer set search_path = '' as $$
declare pl text := case when p_status in ('active', 'trialing', 'past_due') then 'paid' else 'free' end;
begin
  perform private.allow(k);
  insert into public.accounts (user_id, plan, stripe_customer, stripe_subscription, stripe_status, updated_at)
  values (p_user, pl, p_customer, p_subscription, p_status, now())
  on conflict (user_id) do update
     set plan = excluded.plan,
         stripe_customer = coalesce(excluded.stripe_customer, public.accounts.stripe_customer),
         stripe_subscription = coalesce(excluded.stripe_subscription, public.accounts.stripe_subscription),
         stripe_status = excluded.stripe_status, updated_at = now();
  return pl;
end $$;

create or replace function public.ms_account(k text, p_user uuid) returns setof public.accounts
language plpgsql security definer set search_path = '' as $$
begin
  perform private.allow(k);
  return query select * from public.accounts where user_id = p_user;
end $$;

-- A subscription Stripe tells us about by its id alone (renewed, cancelled): whose it is.
create or replace function public.ms_subscriber(k text, p_subscription text) returns uuid
language plpgsql security definer set search_path = '' as $$
begin
  perform private.allow(k);
  return (select user_id from public.accounts where stripe_subscription = p_subscription limit 1);
end $$;

do $$
declare f record;
begin
  for f in select p.oid::regprocedure as sig from pg_proc p join pg_namespace n on n.oid = p.pronamespace
            where n.nspname = 'public' and p.proname in ('ms_use', 'ms_usage', 'ms_gate', 'ms_set_plan', 'ms_account', 'ms_subscriber') loop
    execute format('revoke execute on function %s from public, authenticated', f.sig);
    execute format('grant execute on function %s to anon, service_role', f.sig);
  end loop;
end $$;
