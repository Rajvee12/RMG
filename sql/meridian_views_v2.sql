-- Extra read-only views for the Meridian RMG Agent (run once in Supabase -> SQL editor).
-- They expose data the app now keeps that the first four views (employees, demand_positions,
-- ta_roles, ta_candidates) don't cover. Counts, roles and dates only: no contact or pay details.
-- Safe to run again: every view is "create or replace".

-- IndiGo recruiter roles, from the IndiGo tracker (TA Team Hiring Tracker - Raw Format).
-- status: Fulfilled = joined, Offer in Progress = offered, Closed = closed by IndiGo or another vendor.
create or replace view meridian.indigo_roles as
select
  r->>'title'                          as role,
  r->>'account'                        as client,
  coalesce((r->>'positions')::numeric, 1) as positions,
  r->>'recruiter'                      as recruiter,
  r->>'status'                         as status,
  case
    when r->>'status' ilike 'fulfil%'  then 'joined'
    when r->>'status' ilike 'offer%'   then 'offered'
    when r->>'status' ilike 'cancel%'  then 'cancelled'
    when r->>'status' ilike 'closed%'  then 'closed by IndiGo or other vendor'
    when r->>'status' ilike '%hold%'   then 'on hold'
    else 'open'
  end                                  as stage,
  nullif(r->>'posted','')::date        as date_posted,
  nullif(r->>'closed','')::date        as date_closed,
  r->>'billable'                       as billable,
  r->>'location'                       as location,
  r->>'update'                         as current_update
from public.ledger_docs d
cross join lateral jsonb_array_elements(coalesce(d.data->'roles','[]'::jsonb)) r
where d.path = 'ta/indigo';

-- Daily sourcing log from the Sourcing Activity tab of both trackers.
create or replace view meridian.sourcing_activity as
select
  case d.path when 'ta/indigo' then 'IndiGo TA' else 'AIONOS TA' end as team,
  nullif(a->>'date','')::date          as activity_date,
  a->>'recruiter'                      as recruiter,
  a->>'role'                           as role,
  a->>'channel'                        as channel,
  coalesce((a->>'reach')::numeric, 0)  as reach_outs,
  coalesce((a->>'resp')::numeric, 0)   as responses,
  coalesce((a->>'int')::numeric, 0)    as interested,
  coalesce((a->>'shared')::numeric, 0) as profiles_shared
from public.ledger_docs d
cross join lateral jsonb_array_elements(coalesce(d.data->'acts','[]'::jsonb)) a
where d.path in ('ta/latest', 'ta/indigo');

-- The counts-only leadership snapshot the app saves every few minutes (same as the Leadership view).
create or replace view meridian.leadership_snapshot as
select
  (d.data->>'at')::timestamptz         as as_of,
  d.data->'data'->'tiles'              as headline_tiles,
  d.data->'data'->'company'            as by_company,
  d.data->'data'->'pf'                 as demand_by_portfolio,
  d.data->'data'->'acc'                as bench_by_account
from public.ledger_docs d
where d.path = 'share/leadership';

-- SLA Watchdog counts (roll-offs, roles past SLA, long bench, stale feeds).
create or replace view meridian.sla_counts as
select
  (d.data->>'at')::timestamptz         as as_of,
  k.key                                as check_name,
  (k.value)::text::int                 as items
from public.ledger_docs d
cross join lateral jsonb_each(coalesce(d.data->'counts','{}'::jsonb)) k
where d.path = 'sla/digest';

grant select on meridian.indigo_roles, meridian.sourcing_activity, meridian.leadership_snapshot, meridian.sla_counts to meridian_reader;
