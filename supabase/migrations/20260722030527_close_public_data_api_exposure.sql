-- Supabase migration version: 20260722030527.
-- meios accesses application data through the server-side service role, while
-- LiteLLM uses a direct Postgres connection. No unprotected public table is a
-- supported anon/authenticated Data API surface.
do $migration$
declare
  target record;
begin
  for target in
    select n.nspname as schema_name, c.relname as relation_name
    from pg_class c
    join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public'
      and c.relkind in ('r', 'p')
      and not c.relrowsecurity
  loop
    execute format(
      'alter table %I.%I enable row level security',
      target.schema_name,
      target.relation_name
    );
    execute format(
      'revoke all privileges on table %I.%I from anon, authenticated',
      target.schema_name,
      target.relation_name
    );
  end loop;
end
$migration$;

-- LiteLLM owns its generated schema as postgres. Prevent later releases from
-- silently exposing newly generated relations through PostgREST.
alter default privileges for role postgres in schema public
  revoke all privileges on tables from anon, authenticated;
alter default privileges for role postgres in schema public
  revoke all privileges on sequences from anon, authenticated;
alter default privileges for role postgres in schema public
  revoke execute on functions from anon, authenticated;

-- Views should never run with the creator's RLS privileges. Direct postgres
-- callers keep their existing access; Data API roles have no supported access.
do $migration$
declare
  target record;
begin
  for target in
    select n.nspname as schema_name, c.relname as relation_name
    from pg_class c
    join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public'
      and c.relkind = 'v'
  loop
    execute format(
      'alter view %I.%I set (security_invoker = true)',
      target.schema_name,
      target.relation_name
    );
    execute format(
      'revoke all privileges on table %I.%I from anon, authenticated',
      target.schema_name,
      target.relation_name
    );
  end loop;
end
$migration$;

-- These SECURITY DEFINER helpers are infrastructure operations, not public
-- RPCs. The gateway alone needs the JuiceFS provisioning helper.
revoke execute on function public.create_schema_if_not_exists(text)
from public, anon, authenticated;
revoke execute on function public.provision_juicefs_role(text, text, text)
from public, anon, authenticated;
grant execute on function public.provision_juicefs_role(text, text, text)
to service_role;
