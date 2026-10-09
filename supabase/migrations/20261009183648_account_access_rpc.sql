-- Expose only a boolean access check; the allowlist remains private.
create or replace function public.is_allowed_account()
returns boolean language sql stable security invoker set search_path = ''
as $$ select private.is_allowed_account(); $$;
revoke all on function public.is_allowed_account() from public, anon;
grant execute on function public.is_allowed_account() to authenticated;
