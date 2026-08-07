begin;

alter table public.learning_projects
  drop constraint learning_projects_escrow_budget_consistent,
  add column pricing_policy_version text check (
    pricing_policy_version is null or pricing_policy_version = 'work-unit-pricing-v1'
  ),
  add column pricing_root text check (
    pricing_root is null or pricing_root ~ '^0x[0-9a-f]{64}$'
  );

alter table public.learning_projects
  add constraint learning_projects_escrow_budget_consistent check (
    escrow_state = 'UNFUNDED'
    or (
      project_escrow_address is not null
      and sponsor_treasury_address is not null
      and escrow_total_budget_wei > 0
      and escrow_remaining_budget_wei between 0 and escrow_total_budget_wei
      and escrow_work_unit_count between 1 and 48
      and escrow_settled_work_unit_count between 0 and escrow_work_unit_count
      and escrow_funding_tx_hash is not null
      and escrow_funded_block is not null
      and (
        (pricing_policy_version is not null and pricing_root is not null)
        or (
          reward_per_work_unit_wei is not null
          and escrow_total_budget_wei = reward_per_work_unit_wei * escrow_work_unit_count
          and escrow_remaining_budget_wei = reward_per_work_unit_wei
            * (escrow_work_unit_count - escrow_settled_work_unit_count)
        )
      )
    )
  );

alter table public.work_units
  add column workload_score smallint check (
    workload_score is null or workload_score between 1 and 64
  ),
  add column reward_tier text check (
    reward_tier is null or reward_tier in ('S', 'M', 'L', 'XL')
  ),
  add column reward_amount_wei numeric(78, 0) check (
    reward_amount_wei is null or reward_amount_wei > 0
  ),
  add constraint work_units_pricing_consistent check (
    (workload_score is null and reward_tier is null and reward_amount_wei is null)
    or (workload_score is not null and reward_tier is not null and reward_amount_wei is not null)
  );

create function public.mark_project_escrow_funded_v2(
  p_project_id text,
  p_escrow_address text,
  p_sponsor_address text,
  p_pricing_policy_version text,
  p_pricing_root text,
  p_quotes jsonb,
  p_total_budget_wei numeric,
  p_remaining_budget_wei numeric,
  p_work_unit_count integer,
  p_settled_work_unit_count integer,
  p_funding_tx_hash text,
  p_funded_block bigint
)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare
  v_actual_work_unit_count integer;
  v_updated_work_unit_count integer;
  v_quoted_total numeric;
begin
  if lower(p_project_id) !~ '^0x[0-9a-f]{64}$'
    or lower(p_escrow_address) !~ '^0x[0-9a-f]{40}$'
    or lower(p_sponsor_address) !~ '^0x[0-9a-f]{40}$'
    or p_pricing_policy_version <> 'work-unit-pricing-v1'
    or lower(p_pricing_root) !~ '^0x[0-9a-f]{64}$'
    or lower(p_funding_tx_hash) !~ '^0x[0-9a-f]{64}$'
    or jsonb_typeof(p_quotes) <> 'array'
    or jsonb_array_length(p_quotes) <> p_work_unit_count
    or p_work_unit_count not between 1 and 48
    or p_settled_work_unit_count <> 0
    or p_total_budget_wei <= 0
    or p_remaining_budget_wei <> p_total_budget_wei
    or p_funded_block <= 0 then
    raise exception 'invalid dynamic Project Escrow funding evidence';
  end if;

  if (
    select count(distinct quote.work_unit_id)
    from jsonb_to_recordset(p_quotes) as quote(work_unit_id integer)
  ) <> p_work_unit_count or exists (
    select 1 from jsonb_to_recordset(p_quotes) as quote(
      work_unit_id integer, workload_score integer, reward_tier text, reward_amount_wei numeric
    )
    where quote.work_unit_id not between 0 and p_work_unit_count - 1
      or quote.workload_score not between 1 and 64
      or quote.reward_tier not in ('S', 'M', 'L', 'XL')
      or quote.reward_amount_wei <= 0
  ) then raise exception 'invalid Work Unit quote sheet'; end if;

  select sum(quote.reward_amount_wei) into v_quoted_total
  from jsonb_to_recordset(p_quotes) as quote(reward_amount_wei numeric);
  if v_quoted_total <> p_total_budget_wei then
    raise exception 'dynamic Project Escrow total does not match quote sheet';
  end if;

  perform 1 from public.learning_projects
  where project_id = lower(p_project_id)
    and status in ('AWAITING_REGISTRY', 'GENERATING')
    and escrow_state = 'UNFUNDED'
  for update;
  if not found then raise exception 'Project is not awaiting dynamic funded Registry reconciliation'; end if;

  select count(*)::integer into v_actual_work_unit_count
  from public.work_units where project_id = lower(p_project_id);
  if v_actual_work_unit_count <> p_work_unit_count then
    raise exception 'Project Escrow Work Unit count does not match frozen design';
  end if;

  update public.work_units as units
  set workload_score = quote.workload_score::smallint,
      reward_tier = quote.reward_tier,
      reward_amount_wei = quote.reward_amount_wei
  from jsonb_to_recordset(p_quotes) as quote(
    work_unit_id integer, workload_score integer, reward_tier text, reward_amount_wei numeric
  )
  where units.project_id = lower(p_project_id)
    and units.work_unit_id = quote.work_unit_id::smallint;
  get diagnostics v_updated_work_unit_count = row_count;
  if v_updated_work_unit_count <> p_work_unit_count then
    raise exception 'quote sheet does not cover every frozen Work Unit';
  end if;

  update public.learning_projects
  set project_escrow_address = lower(p_escrow_address),
      sponsor_treasury_address = lower(p_sponsor_address),
      reward_per_work_unit_wei = null,
      pricing_policy_version = p_pricing_policy_version,
      pricing_root = lower(p_pricing_root),
      escrow_total_budget_wei = p_total_budget_wei,
      escrow_remaining_budget_wei = p_remaining_budget_wei,
      escrow_work_unit_count = p_work_unit_count::smallint,
      escrow_settled_work_unit_count = 0,
      escrow_funding_tx_hash = lower(p_funding_tx_hash),
      escrow_funded_block = p_funded_block,
      escrow_state = 'FUNDED',
      status = 'GENERATING',
      last_error = null
  where project_id = lower(p_project_id);

  update public.work_unit_rewards as rewards
  set escrow_address = lower(p_escrow_address),
      treasury_address = lower(p_sponsor_address),
      amount_wei = units.reward_amount_wei
  from public.work_units as units
  where rewards.project_id = lower(p_project_id)
    and rewards.project_id = units.project_id
    and rewards.work_unit_id = units.work_unit_id
    and rewards.status in ('PENDING', 'PROCESSING', 'RETRYABLE');
  return true;
end;
$$;

create or replace function public.confirm_work_unit_and_enqueue_escrow_reward_v3(
  p_project_id text,
  p_work_unit_id integer,
  p_tx_hash text,
  p_block_number bigint,
  p_gas_used numeric,
  p_confirmation_ms integer
)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare
  v_project record;
  v_unit record;
  v_approved_evaluation_count integer;
begin
  select project_escrow_address, sponsor_treasury_address,
    escrow_work_unit_count, generation_policy_version
  into v_project
  from public.learning_projects
  where project_id = lower(p_project_id) and escrow_state = 'FUNDED'
  for update;
  if not found then raise exception 'Project has no funded Sponsor Escrow'; end if;

  select * into v_unit from public.work_units
  where project_id = lower(p_project_id)
    and work_unit_id = p_work_unit_id::smallint
  for update;
  if not found
    or v_unit.status not in ('APPROVED', 'SUBMITTING', 'CONFIRMED')
    or v_unit.worker_address is null
    or v_unit.cards_root is null
    or v_unit.card_count <= 0
    or v_unit.reward_amount_wei is null then
    raise exception 'quality-approved priced Work Unit confirmation target is missing';
  end if;

  if v_project.generation_policy_version >= 3 then
    select count(distinct evaluations.card_id)::integer into v_approved_evaluation_count
    from public.card_quality_evaluations as evaluations
    join public.card_slot_candidates as candidates
      on candidates.project_id = evaluations.project_id
      and candidates.chapter_id = evaluations.chapter_id
      and candidates.design_run_id = evaluations.design_run_id
      and candidates.slot_id = evaluations.slot_id
      and candidates.card_id = evaluations.card_id
      and candidates.candidate_revision = evaluations.candidate_revision
    where evaluations.project_id = lower(p_project_id)
      and evaluations.chapter_id = v_unit.chapter_id
      and candidates.work_unit_id = p_work_unit_id::smallint
      and evaluations.verdict = 'APPROVED'
      and candidates.status = 'ACCEPTED';
    if v_approved_evaluation_count <> v_unit.card_count then
      raise exception 'Work Unit has no complete approved Quality Gate evidence';
    end if;
  end if;

  update public.work_units
  set status = 'CONFIRMED', commit_tx_hash = coalesce(lower(p_tx_hash), commit_tx_hash),
      confirmed_block = p_block_number, gas_used = p_gas_used,
      confirmation_ms = p_confirmation_ms, lease_until = null, last_error = null
  where project_id = lower(p_project_id) and work_unit_id = p_work_unit_id::smallint;

  insert into public.work_unit_rewards (
    project_id, work_unit_id, escrow_address, treasury_address,
    recipient_address, amount_wei, status
  ) values (
    lower(p_project_id), p_work_unit_id::smallint, v_project.project_escrow_address,
    v_project.sponsor_treasury_address, v_unit.worker_address,
    v_unit.reward_amount_wei, 'PENDING'
  ) on conflict (project_id, work_unit_id) do nothing;
  return true;
end;
$$;

create or replace function public.confirm_escrow_reward_settlement_v1(
  p_project_id text,
  p_work_unit_id integer,
  p_tx_hash text,
  p_confirmed_block bigint,
  p_gas_used numeric,
  p_confirmation_ms integer
)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare
  v_confirmed_count integer;
  v_confirmed_total numeric;
begin
  update public.work_unit_rewards
  set status = 'CONFIRMED', tx_hash = lower(p_tx_hash), confirmed_block = p_confirmed_block,
      gas_used = p_gas_used, confirmation_ms = p_confirmation_ms,
      lease_until = null, last_error = null
  where project_id = lower(p_project_id)
    and work_unit_id = p_work_unit_id::smallint
    and status in ('PROCESSING', 'PREPARED', 'SUBMITTING', 'CONFIRMED');
  if not found then raise exception 'Escrow Reward settlement target is missing'; end if;

  select count(*)::integer, coalesce(sum(amount_wei), 0)
  into v_confirmed_count, v_confirmed_total
  from public.work_unit_rewards
  where project_id = lower(p_project_id) and status = 'CONFIRMED';
  update public.learning_projects
  set escrow_settled_work_unit_count = v_confirmed_count::smallint,
      escrow_remaining_budget_wei = escrow_total_budget_wei - v_confirmed_total
  where project_id = lower(p_project_id) and escrow_state = 'FUNDED';
  if not found then raise exception 'funded Project for Escrow Reward is missing'; end if;
  return true;
end;
$$;

alter function public.get_schema_capabilities_v1() rename to get_schema_capabilities_pre_dynamic_pricing_v1;

create function public.get_schema_capabilities_v1()
returns jsonb
language plpgsql
stable
security definer
set search_path = pg_catalog, public
as $$
declare
  v_previous jsonb;
  v_dynamic_pricing boolean;
  v_missing jsonb;
begin
  v_previous := public.get_schema_capabilities_pre_dynamic_pricing_v1();
  v_dynamic_pricing :=
    to_regprocedure('public.mark_project_escrow_funded_v2(text,text,text,text,text,jsonb,numeric,numeric,integer,integer,text,bigint)') is not null
    and exists (
      select 1 from information_schema.columns
      where table_schema = 'public' and table_name = 'work_units'
        and column_name = 'reward_amount_wei'
    );
  v_missing := coalesce(v_previous->'missing', '[]'::jsonb);
  if not v_dynamic_pricing and not v_missing @> '["sponsor_escrow"]'::jsonb then
    v_missing := v_missing || '"sponsor_escrow"'::jsonb;
  end if;
  return jsonb_build_object(
    'schemaVersion', '2026-08-07.2',
    'capabilities', (v_previous->'capabilities') || jsonb_build_object(
      'sponsorEscrow', coalesce((v_previous->'capabilities'->>'sponsorEscrow')::boolean, false)
        and v_dynamic_pricing
    ),
    'missing', v_missing
  );
end;
$$;

revoke execute on function public.mark_project_escrow_funded_v2(text,text,text,text,text,jsonb,numeric,numeric,integer,integer,text,bigint) from public;
revoke execute on function public.get_schema_capabilities_pre_dynamic_pricing_v1() from public;
revoke execute on function public.get_schema_capabilities_v1() from public;

do $$
begin
  if exists (select 1 from pg_roles where rolname = 'anon') then
    revoke execute on function public.mark_project_escrow_funded_v2(text,text,text,text,text,jsonb,numeric,numeric,integer,integer,text,bigint) from anon;
    revoke execute on function public.get_schema_capabilities_v1() from anon;
  end if;
  if exists (select 1 from pg_roles where rolname = 'authenticated') then
    revoke execute on function public.mark_project_escrow_funded_v2(text,text,text,text,text,jsonb,numeric,numeric,integer,integer,text,bigint) from authenticated;
    revoke execute on function public.get_schema_capabilities_v1() from authenticated;
  end if;
  if exists (select 1 from pg_roles where rolname = 'service_role') then
    grant execute on function public.mark_project_escrow_funded_v2(text,text,text,text,text,jsonb,numeric,numeric,integer,integer,text,bigint) to service_role;
    grant execute on function public.get_schema_capabilities_v1() to service_role;
  end if;
end;
$$;

comment on column public.work_units.reward_amount_wei is
  'Reward frozen before generation by the versioned Work Unit pricing policy.';

commit;
