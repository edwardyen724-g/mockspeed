-- Which site a usage row was made on: the deployed app, or a local run against the same store,
-- which may use a different model key. The admin page's Anthropic table is split by it, so each
-- part can be set beside the console's count for its own key.

alter table public.usage_events add column if not exists origin text;

create or replace function public.ms_use(k text, p_rows jsonb) returns int
language plpgsql security definer set search_path = '' as $$
declare n int;
begin
  perform private.allow(k);
  insert into public.usage_events (user_id, anon, project, sentence, provider, model, purpose, input_tokens, output_tokens,
                                   cache_read_tokens, cache_write_tokens, jev_questions, ms, first_line_ms, status, cost_usd, origin)
  select user_id, anon, project, sentence, provider, model, purpose, coalesce(input_tokens, 0), coalesce(output_tokens, 0),
         coalesce(cache_read_tokens, 0), coalesce(cache_write_tokens, 0), jev_questions, ms, first_line_ms, status, cost_usd, origin
    from jsonb_to_recordset(p_rows) as x(user_id uuid, anon text, project text, sentence text, provider text, model text, purpose text,
                                          input_tokens int, output_tokens int, cache_read_tokens int, cache_write_tokens int,
                                          jev_questions int, ms int, first_line_ms int, status text, cost_usd numeric, origin text);
  get diagnostics n = row_count;
  return n;
end $$;

drop function if exists public.ms_usage(text, timestamptz);
create function public.ms_usage(k text, p_since timestamptz) returns table (
  created_at timestamptz, user_id uuid, email text, anon text, project text, sentence text, provider text, model text, purpose text,
  input_tokens int, output_tokens int, cache_read_tokens int, cache_write_tokens int, jev_questions int, ms int, status text, cost_usd numeric, origin text)
language plpgsql security definer set search_path = '' as $$
begin
  perform private.allow(k);
  return query
    select u.created_at, u.user_id, a.email::text, u.anon, u.project, u.sentence, u.provider, u.model, u.purpose,
           u.input_tokens, u.output_tokens, u.cache_read_tokens, u.cache_write_tokens, u.jev_questions, u.ms, u.status, u.cost_usd, u.origin
      from public.usage_events u left join auth.users a on a.id = u.user_id
     where u.created_at >= p_since
     order by u.created_at;
end $$;
revoke execute on function public.ms_usage(text, timestamptz) from public, authenticated;
grant execute on function public.ms_usage(text, timestamptz) to anon, service_role;
revoke execute on function public.ms_use(text, jsonb) from public, authenticated;
grant execute on function public.ms_use(text, jsonb) to anon, service_role;
