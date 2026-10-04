-- Applied through the SQL editor after enabling Supabase's automatic RLS option.
-- This dashboard-created event-trigger helper is not an application RPC.
-- Use only on projects where the automatic RLS helper exists.
revoke execute on function public.rls_auto_enable() from public, anon, authenticated;

select
  has_function_privilege('anon', 'public.rls_auto_enable()', 'EXECUTE') as anonymous_execute,
  has_function_privilege('authenticated', 'public.rls_auto_enable()', 'EXECUTE') as signed_in_execute;
-- Both results must be false.
