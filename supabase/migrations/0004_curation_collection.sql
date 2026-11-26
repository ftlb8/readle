-- Weekly suggestions, phase 1: collecting candidate articles.
-- A daily job reads the feeds of the chosen publications and curators and
-- records what is new. Only card-level details are stored (title, short
-- excerpt, link); the article text itself is never kept here.

-- The person who runs the curation. Others only ever see the finished picks.
create table public.admins (
  user_id uuid primary key references auth.users(id) on delete cascade
);
alter table public.admins enable row level security;
revoke all on public.admins from anon, authenticated;

insert into public.admins (user_id)
select id from auth.users order by created_at limit 1;

create or replace function public.is_admin()
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (select 1 from public.admins where user_id = (select auth.uid()));
$$;
revoke all on function public.is_admin() from public, anon;
grant execute on function public.is_admin() to authenticated;

-- Private settings for the curation jobs (never readable through the API).
-- Holds 'collector_token_hash': the SHA-256 of the collector's secret token.
create table public.curation_config (
  key text primary key,
  value text not null
);
alter table public.curation_config enable row level security;
revoke all on public.curation_config from anon, authenticated;

-- Where candidates come from. 'publication': its own articles.
-- 'curator': the outside articles it recommends.
create table public.sources (
  key text primary key,
  name text not null,
  kind text not null check (kind in ('publication', 'curator')),
  feed_url text not null,
  language text not null default 'en',
  active boolean not null default true,
  config jsonb not null default '{}',
  updated_at timestamptz not null default now()
);
alter table public.sources enable row level security;
revoke all on public.sources from anon;
create policy "admin can read sources" on public.sources
  for select to authenticated using ((select public.is_admin()));

create table public.candidates (
  id uuid primary key default gen_random_uuid(),
  url text not null unique,
  title text,
  excerpt text,
  source_key text not null references public.sources(key),
  origin text not null check (origin in ('publication', 'curator')),
  via text[] not null default '{}',          -- curators that recommended it
  published_at timestamptz,
  first_seen_at timestamptz not null default now(),
  feed_chars integer,                         -- length of the full text, when the feed carries it
  language text not null default 'en'
);
create index candidates_first_seen_idx on public.candidates (first_seen_at);
alter table public.candidates enable row level security;
revoke all on public.candidates from anon;
create policy "admin can read candidates" on public.candidates
  for select to authenticated using ((select public.is_admin()));

-- The collector's only way in. It must present a secret token; it can add
-- sources and candidates and nothing else, and it cannot read anyone's data.
create or replace function public.curation_ingest(p_token text, p_sources jsonb, p_items jsonb)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  expected text;
  it jsonb;
  was_new boolean;
  n_new integer := 0;
  n_merged integer := 0;
begin
  select value into expected from public.curation_config where key = 'collector_token_hash';
  if expected is null
     or encode(sha256(convert_to(coalesce(p_token, ''), 'UTF8')), 'hex') <> expected then
    raise exception 'not authorised' using errcode = '42501';
  end if;

  if p_sources is not null then
    insert into public.sources (key, name, kind, feed_url, language, active, config, updated_at)
    select s->>'key', s->>'name', s->>'kind', s->>'feed_url',
           coalesce(s->>'language', 'en'),
           coalesce((s->>'active')::boolean, true),
           coalesce(s->'config', '{}'::jsonb),
           now()
    from jsonb_array_elements(p_sources) s
    on conflict (key) do update set
      name = excluded.name, kind = excluded.kind, feed_url = excluded.feed_url,
      language = excluded.language, active = excluded.active,
      config = excluded.config, updated_at = now();
  end if;

  for it in select * from jsonb_array_elements(coalesce(p_items, '[]'::jsonb)) loop
    insert into public.candidates as c
      (url, title, excerpt, source_key, origin, via, published_at, feed_chars, language)
    values (
      it->>'url', it->>'title', it->>'excerpt', it->>'source_key', it->>'origin',
      array(select jsonb_array_elements_text(coalesce(it->'via', '[]'::jsonb))),
      (it->>'published_at')::timestamptz,
      (it->>'feed_chars')::integer,
      coalesce(it->>'language', 'en')
    )
    on conflict (url) do update set
      -- Remember every curator that recommended it.
      via = (select coalesce(array_agg(distinct v), '{}') from unnest(c.via || excluded.via) v),
      -- The publication's own entry is the better record than a curator's mention.
      origin = case when excluded.origin = 'publication' then 'publication' else c.origin end,
      source_key = case when excluded.origin = 'publication' and c.origin = 'curator'
                        then excluded.source_key else c.source_key end,
      title = case when excluded.origin = 'publication' and c.origin = 'curator'
                   then coalesce(excluded.title, c.title) else coalesce(c.title, excluded.title) end,
      excerpt = coalesce(c.excerpt, excluded.excerpt),
      published_at = coalesce(c.published_at, excluded.published_at),
      feed_chars = coalesce(c.feed_chars, excluded.feed_chars)
    returning (xmax = 0) into was_new;

    if was_new then n_new := n_new + 1; else n_merged := n_merged + 1; end if;
  end loop;

  return jsonb_build_object('new', n_new, 'merged', n_merged);
end;
$$;
revoke all on function public.curation_ingest(text, jsonb, jsonb) from public;
grant execute on function public.curation_ingest(text, jsonb, jsonb) to anon, authenticated;
