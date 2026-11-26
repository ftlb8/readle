-- Readle: one row per saved link. Only the signed-in owner can read or write.
create table public.items (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null default auth.uid() references auth.users(id) on delete cascade,
  url text not null,
  kind text not null default 'article' check (kind in ('article','video','link')),
  status text not null default 'pending' check (status in ('pending','ready','failed')),
  title text,
  excerpt text,
  site_name text,
  author text,
  image_url text,
  content_html text,
  text_content text,
  word_count integer,
  video_embed_url text,
  tags text[] not null default '{}',
  is_archived boolean not null default false,
  is_favorite boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz,
  unique (user_id, url)
);

create index items_user_updated_idx on public.items (user_id, updated_at);

create or replace function public.set_updated_at()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

create trigger items_set_updated_at
before update on public.items
for each row execute function public.set_updated_at();

alter table public.items enable row level security;

create policy "owner can read" on public.items
  for select to authenticated using ((select auth.uid()) = user_id);
create policy "owner can insert" on public.items
  for insert to authenticated with check ((select auth.uid()) = user_id);
create policy "owner can update" on public.items
  for update to authenticated using ((select auth.uid()) = user_id) with check ((select auth.uid()) = user_id);
create policy "owner can delete" on public.items
  for delete to authenticated using ((select auth.uid()) = user_id);

revoke all on public.items from anon;
