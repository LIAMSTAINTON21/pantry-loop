-- Private, per-user quota state for the identify-product Edge Function.
-- Service-only RPCs reserve a conservative amount before provider work and
-- reconcile actual token cost afterward under daily and monthly ceilings.
create schema if not exists private;
revoke all on schema private from public, anon, authenticated;
grant usage on schema private to service_role;

create table if not exists private.product_scan_usage (
  user_id uuid primary key,
  usage_day date not null,
  scans_today smallint not null check (scans_today between 0 and 10),
  usage_month date not null,
  reserved_cost_gbp numeric(12, 6) not null check (reserved_cost_gbp between 0 and 2),
  updated_at timestamptz not null default now(),
  check (extract(day from usage_month) = 1)
);

alter table private.product_scan_usage enable row level security;
revoke all on table private.product_scan_usage from public, anon, authenticated, service_role;

create or replace function public.reserve_product_identification(p_user_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, private, pg_temp
as $function$
declare
  v_day date := (now() at time zone 'UTC')::date;
  v_month date := date_trunc('month', now() at time zone 'UTC')::date;
  v_scans smallint;
  v_reserved numeric(12, 6);
  v_scan_cost constant numeric(12, 6) := 0.25;
begin
  if p_user_id is null then
    raise exception 'p_user_id is required' using errcode = '22023';
  end if;

  -- Serialize reservations for this account, including the first insert.
  perform pg_advisory_xact_lock(hashtextextended(p_user_id::text, 0));

  insert into private.product_scan_usage (user_id, usage_day, scans_today, usage_month, reserved_cost_gbp)
  values (p_user_id, v_day, 0, v_month, 0)
  on conflict (user_id) do nothing;

  select scans_today, reserved_cost_gbp
    into v_scans, v_reserved
    from private.product_scan_usage
   where user_id = p_user_id
   for update;

  if (select usage_day from private.product_scan_usage where user_id = p_user_id) <> v_day then
    v_scans := 0;
  end if;
  if (select usage_month from private.product_scan_usage where user_id = p_user_id) <> v_month then
    v_reserved := 0;
  end if;

  if v_scans >= 10 then
    return jsonb_build_object('status', 'daily_limit');
  end if;
  if v_reserved + v_scan_cost > 2 then
    return jsonb_build_object('status', 'monthly_limit');
  end if;

  v_scans := v_scans + 1;
  v_reserved := v_reserved + v_scan_cost;
  update private.product_scan_usage
     set usage_day = v_day,
         scans_today = v_scans,
         usage_month = v_month,
         reserved_cost_gbp = v_reserved,
         updated_at = now()
   where user_id = p_user_id;

  return jsonb_build_object(
    'status', 'reserved',
    'scans_remaining', 10 - v_scans,
    'estimated_cost_gbp', v_reserved
  );
end;
$function$;

revoke all on function public.reserve_product_identification(uuid) from public, anon, authenticated;
grant execute on function public.reserve_product_identification(uuid) to service_role;

create or replace function public.settle_product_identification(p_user_id uuid, p_actual_cost_gbp numeric)
returns void
language plpgsql
security definer
set search_path = pg_catalog, private, pg_temp
as $function$
declare
  v_month date := date_trunc('month', now() at time zone 'UTC')::date;
  v_reserved numeric(12, 6);
begin
  if p_user_id is null or p_actual_cost_gbp is null or p_actual_cost_gbp < 0 or p_actual_cost_gbp > 0.25 then
    raise exception 'invalid product identification settlement' using errcode = '22023';
  end if;

  perform pg_advisory_xact_lock(hashtextextended(p_user_id::text, 0));
  select reserved_cost_gbp into v_reserved
    from private.product_scan_usage
   where user_id = p_user_id and usage_month = v_month
   for update;
  if not found or v_reserved < 0.25 then
    raise exception 'no matching product identification reservation' using errcode = 'P0002';
  end if;

  update private.product_scan_usage
     set reserved_cost_gbp = round(v_reserved - 0.25 + p_actual_cost_gbp, 6),
         updated_at = now()
   where user_id = p_user_id;
end;
$function$;

revoke all on function public.settle_product_identification(uuid, numeric) from public, anon, authenticated;
grant execute on function public.settle_product_identification(uuid, numeric) to service_role;
