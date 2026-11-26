-- Readler is shared by a small invited group on a free database, so each
-- person gets a cap on saved items. The default is 1000; a row in
-- user_limits overrides it for one person.
create table public.user_limits (
  user_id uuid primary key references auth.users(id) on delete cascade,
  max_items integer not null check (max_items >= 0)
);

-- No policies: only the project owner (dashboard / SQL editor) can see or change limits.
alter table public.user_limits enable row level security;
revoke all on public.user_limits from anon, authenticated;

create or replace function public.enforce_item_limit()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  allowed integer;
  used integer;
begin
  -- Saving a link that is already in the list updates it and never counts as new.
  if exists (select 1 from public.items where user_id = new.user_id and url = new.url) then
    return new;
  end if;

  select coalesce((select max_items from public.user_limits where user_id = new.user_id), 1000) into allowed;
  select count(*) into used from public.items where user_id = new.user_id and deleted_at is null;

  if used >= allowed then
    raise exception 'Your Readler list is full (% items). Delete some items to save more.', allowed;
  end if;
  return new;
end;
$$;

revoke all on function public.enforce_item_limit() from public, anon, authenticated;

create trigger items_enforce_limit
before insert on public.items
for each row execute function public.enforce_item_limit();

-- A deleted item keeps a small marker so other devices learn it is gone,
-- but its article text is dropped to free the space.
create or replace function public.clear_deleted_content()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if new.deleted_at is not null then
    new.content_html := null;
    new.text_content := null;
    new.excerpt := null;
    new.image_url := null;
  end if;
  return new;
end;
$$;

revoke all on function public.clear_deleted_content() from public, anon, authenticated;

create trigger items_clear_deleted
before update on public.items
for each row execute function public.clear_deleted_content();
