-- Returns the server time. Called on a schedule so the free project is never
-- paused for inactivity. It reads no tables and reveals nothing.
create or replace function public.ping()
returns timestamptz
language sql
stable
set search_path = ''
as $$ select now() $$;

revoke all on function public.ping() from public;
grant execute on function public.ping() to anon, authenticated;
