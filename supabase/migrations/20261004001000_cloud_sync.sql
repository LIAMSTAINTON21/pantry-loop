create extension if not exists pgcrypto with schema extensions;

create schema if not exists private;
revoke all on schema private from public, anon, authenticated;

create table if not exists private.allowed_account_hashes (
  email_sha256 text primary key check (email_sha256 ~ '^[0-9a-f]{64}$'),
  created_at timestamptz not null default now()
);

alter table private.allowed_account_hashes enable row level security;
revoke all on table private.allowed_account_hashes from public, anon, authenticated;

create or replace function public.is_allowed_account()
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

revoke all on function public.is_allowed_account() from public, anon;
grant execute on function public.is_allowed_account() to authenticated;

create table if not exists public.pantry_snapshots (
  user_id uuid primary key references auth.users(id) on delete cascade,
  snapshot jsonb not null,
  revision bigint not null default 1 check (revision > 0),
  updated_at timestamptz not null default now()
);

alter table public.pantry_snapshots enable row level security;
revoke all on table public.pantry_snapshots from public, anon;
grant select, insert, update on table public.pantry_snapshots to authenticated;

create policy "approved account reads own pantry snapshot"
on public.pantry_snapshots
for select
to authenticated
using (
  (select auth.uid()) = user_id
  and (select public.is_allowed_account())
);

create policy "approved account creates own pantry snapshot"
on public.pantry_snapshots
for insert
to authenticated
with check (
  (select auth.uid()) = user_id
  and (select public.is_allowed_account())
);

create policy "approved account updates own pantry snapshot"
on public.pantry_snapshots
for update
to authenticated
using (
  (select auth.uid()) = user_id
  and (select public.is_allowed_account())
)
with check (
  (select auth.uid()) = user_id
  and (select public.is_allowed_account())
);

create or replace function public.set_pantry_snapshot_updated_at()
returns trigger
language plpgsql
security invoker
set search_path = ''
as $function$
begin
  new.updated_at := now();
  return new;
end;
$function$;

revoke all on function public.set_pantry_snapshot_updated_at() from public, anon, authenticated;

drop trigger if exists set_pantry_snapshot_updated_at on public.pantry_snapshots;
create trigger set_pantry_snapshot_updated_at
before update on public.pantry_snapshots
for each row execute function public.set_pantry_snapshot_updated_at();

