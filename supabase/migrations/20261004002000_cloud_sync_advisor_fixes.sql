-- Apply advisor-recommended query and policy hardening to cloud-sync objects
-- while preserving the existing access rules and snapshot model.
create policy "no direct access to allowed account hashes"
on private.allowed_account_hashes
as restrictive
for all
to public
using (false)
with check (false);

drop policy if exists "approved account reads own pantry snapshot" on public.pantry_snapshots;
drop policy if exists "approved account creates own pantry snapshot" on public.pantry_snapshots;
drop policy if exists "approved account updates own pantry snapshot" on public.pantry_snapshots;

revoke all on function public.is_allowed_account() from public, anon, authenticated;
drop function public.is_allowed_account();

create or replace function private.is_allowed_account()
returns boolean
language sql
stable
security definer
set search_path = ''
as $function$
  select exists (
    select 1
      from private.allowed_account_hashes
     where email_sha256 = encode(
       extensions.digest(lower(coalesce(auth.jwt() ->> 'email', '')), 'sha256'),
       'hex'
     )
  );
$function$;

revoke all on function private.is_allowed_account() from public, anon;
grant usage on schema private to authenticated;
grant execute on function private.is_allowed_account() to authenticated;

create policy "approved account reads own pantry snapshot"
on public.pantry_snapshots
for select
to authenticated
using (
  (select auth.uid()) = user_id
  and (select private.is_allowed_account())
);

create policy "approved account creates own pantry snapshot"
on public.pantry_snapshots
for insert
to authenticated
with check (
  (select auth.uid()) = user_id
  and (select private.is_allowed_account())
);

create policy "approved account updates own pantry snapshot"
on public.pantry_snapshots
for update
to authenticated
using (
  (select auth.uid()) = user_id
  and (select private.is_allowed_account())
)
with check (
  (select auth.uid()) = user_id
  and (select private.is_allowed_account())
);

