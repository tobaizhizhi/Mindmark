begin;

alter table public.learning_projects
  add column project_escrow_address text check (
    project_escrow_address is null or project_escrow_address ~ '^0x[0-9a-f]{40}$'
  ),
  add column sponsor_treasury_address text check (
    sponsor_treasury_address is null or sponsor_treasury_address ~ '^0x[0-9a-f]{40}$'
  ),
  add column reward_per_work_unit_wei numeric(78, 0) check (
    reward_per_work_unit_wei is null or reward_per_work_unit_wei > 0
  ),
  add column escrow_total_budget_wei numeric(78, 0) check (
    escrow_total_budget_wei is null or escrow_total_budget_wei > 0
  ),
  add column escrow_remaining_budget_wei numeric(78, 0) check (
    escrow_remaining_budget_wei is null or escrow_remaining_budget_wei >= 0
  ),
  add column escrow_work_unit_count smallint check (
    escrow_work_unit_count is null or escrow_work_unit_count between 1 and 48
  ),
  add column escrow_settled_work_unit_count smallint check (
    escrow_settled_work_unit_count is null or escrow_settled_work_unit_count between 0 and 48
  ),
  add column escrow_funding_tx_hash text check (
    escrow_funding_tx_hash is null or escrow_funding_tx_hash ~ '^0x[0-9a-f]{64}$'
  ),
  add column escrow_funded_block bigint check (
    escrow_funded_block is null or escrow_funded_block > 0
  ),
  add column escrow_state text not null default 'UNFUNDED' check (
    escrow_state in ('UNFUNDED', 'FUNDED', 'REFUNDED')
  ),
  add constraint learning_projects_escrow_budget_consistent check (
    escrow_state = 'UNFUNDED'
    or (
      project_escrow_address is not null
      and sponsor_treasury_address is not null
      and reward_per_work_unit_wei is not null
      and escrow_total_budget_wei = reward_per_work_unit_wei * escrow_work_unit_count
      and escrow_remaining_budget_wei = reward_per_work_unit_wei
        * (escrow_work_unit_count - escrow_settled_work_unit_count)
      and escrow_funding_tx_hash is not null
      and escrow_funded_block is not null
    )
  );

alter table public.work_unit_rewards
  add column escrow_address text check (
    escrow_address is null or escrow_address ~ '^0x[0-9a-f]{40}$'
  );

create or replace function public.mark_project_escrow_funded_v1(
  p_project_id text,
  p_escrow_address text,
  p_sponsor_address text,
  p_reward_per_work_unit_wei numeric,
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
begin
  if lower(p_project_id) !~ '^0x[0-9a-f]{64}$'
    or lower(p_escrow_address) !~ '^0x[0-9a-f]{40}$'
    or lower(p_sponsor_address) !~ '^0x[0-9a-f]{40}$'
    or lower(p_funding_tx_hash) !~ '^0x[0-9a-f]{64}$'
    or p_reward_per_work_unit_wei <= 0
    or p_work_unit_count not between 1 and 48
    or p_settled_work_unit_count not between 0 and p_work_unit_count
    or p_total_budget_wei <> p_reward_per_work_unit_wei * p_work_unit_count
    or p_remaining_budget_wei <> p_reward_per_work_unit_wei
      * (p_work_unit_count - p_settled_work_unit_count)
    or p_funded_block <= 0 then
    raise exception 'invalid Project Escrow funding evidence';
  end if;

  perform 1 from public.learning_projects
  where project_id = lower(p_project_id)
    and status in ('AWAITING_REGISTRY', 'GENERATING')
    and escrow_state = 'UNFUNDED'
  for update;
  if not found then raise exception 'Project is not awaiting funded Registry reconciliation'; end if;

  select count(*)::integer into v_actual_work_unit_count
  from public.work_units where project_id = lower(p_project_id);
  if v_actual_work_unit_count <> p_work_unit_count then
    raise exception 'Project Escrow Work Unit count does not match frozen design';
  end if;

  update public.learning_projects
  set project_escrow_address = lower(p_escrow_address),
      sponsor_treasury_address = lower(p_sponsor_address),
      reward_per_work_unit_wei = p_reward_per_work_unit_wei,
      escrow_total_budget_wei = p_total_budget_wei,
      escrow_remaining_budget_wei = p_remaining_budget_wei,
      escrow_work_unit_count = p_work_unit_count::smallint,
      escrow_settled_work_unit_count = p_settled_work_unit_count::smallint,
      escrow_funding_tx_hash = lower(p_funding_tx_hash),
      escrow_funded_block = p_funded_block,
      escrow_state = 'FUNDED',
      status = 'GENERATING',
      last_error = null
  where project_id = lower(p_project_id);

  update public.work_unit_rewards
  set escrow_address = lower(p_escrow_address),
      treasury_address = lower(p_sponsor_address),
      amount_wei = p_reward_per_work_unit_wei
  where project_id = lower(p_project_id)
    and status in ('PENDING', 'PROCESSING', 'RETRYABLE');
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
    reward_per_work_unit_wei, escrow_work_unit_count, generation_policy_version
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
    or v_unit.card_count <= 0 then
    raise exception 'quality-approved Work Unit confirmation target is missing';
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
      and candidates.status = 'APPROVED';
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
    v_project.reward_per_work_unit_wei, 'PENDING'
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
begin
  update public.work_unit_rewards
  set status = 'CONFIRMED', tx_hash = lower(p_tx_hash), confirmed_block = p_confirmed_block,
      gas_used = p_gas_used, confirmation_ms = p_confirmation_ms,
      lease_until = null, last_error = null
  where project_id = lower(p_project_id)
    and work_unit_id = p_work_unit_id::smallint
    and status in ('PROCESSING', 'PREPARED', 'SUBMITTING', 'CONFIRMED');
  if not found then raise exception 'Escrow Reward settlement target is missing'; end if;

  select count(*)::integer into v_confirmed_count from public.work_unit_rewards
  where project_id = lower(p_project_id) and status = 'CONFIRMED';
  update public.learning_projects
  set escrow_settled_work_unit_count = v_confirmed_count::smallint,
      escrow_remaining_budget_wei = reward_per_work_unit_wei
        * (escrow_work_unit_count - v_confirmed_count)
  where project_id = lower(p_project_id) and escrow_state = 'FUNDED';
  if not found then raise exception 'funded Project for Escrow Reward is missing'; end if;
  return true;
end;
$$;

alter function public.get_schema_capabilities_v1() rename to get_schema_capabilities_pre_escrow_v1;

create function public.get_schema_capabilities_v1()
returns jsonb
language plpgsql
stable
security definer
set search_path = pg_catalog, public
as $$
declare
  v_previous jsonb;
  v_sponsor_escrow boolean;
  v_missing jsonb;
begin
  v_previous := public.get_schema_capabilities_pre_escrow_v1();
  v_sponsor_escrow :=
    to_regprocedure('public.mark_project_escrow_funded_v1(text,text,text,numeric,numeric,numeric,integer,integer,text,bigint)') is not null
    and to_regprocedure('public.confirm_work_unit_and_enqueue_escrow_reward_v3(text,integer,text,bigint,numeric,integer)') is not null
    and to_regprocedure('public.confirm_escrow_reward_settlement_v1(text,integer,text,bigint,numeric,integer)') is not null;
  v_missing := coalesce(v_previous->'missing', '[]'::jsonb);
  if not v_sponsor_escrow then v_missing := v_missing || '"sponsor_escrow"'::jsonb; end if;
  return jsonb_build_object(
    'schemaVersion', '2026-08-07.1',
    'capabilities', (v_previous->'capabilities') || jsonb_build_object('sponsorEscrow', v_sponsor_escrow),
    'missing', v_missing
  );
end;
$$;

revoke execute on function public.mark_project_escrow_funded_v1(text,text,text,numeric,numeric,numeric,integer,integer,text,bigint) from public;
revoke execute on function public.confirm_work_unit_and_enqueue_escrow_reward_v3(text,integer,text,bigint,numeric,integer) from public;
revoke execute on function public.confirm_escrow_reward_settlement_v1(text,integer,text,bigint,numeric,integer) from public;
revoke execute on function public.get_schema_capabilities_pre_escrow_v1() from public;
revoke execute on function public.get_schema_capabilities_v1() from public;

do $$
begin
  if exists (select 1 from pg_roles where rolname = 'anon') then
    revoke execute on function public.mark_project_escrow_funded_v1(text,text,text,numeric,numeric,numeric,integer,integer,text,bigint) from anon;
    revoke execute on function public.confirm_work_unit_and_enqueue_escrow_reward_v3(text,integer,text,bigint,numeric,integer) from anon;
    revoke execute on function public.confirm_escrow_reward_settlement_v1(text,integer,text,bigint,numeric,integer) from anon;
    revoke execute on function public.get_schema_capabilities_v1() from anon;
  end if;
  if exists (select 1 from pg_roles where rolname = 'authenticated') then
    revoke execute on function public.mark_project_escrow_funded_v1(text,text,text,numeric,numeric,numeric,integer,integer,text,bigint) from authenticated;
    revoke execute on function public.confirm_work_unit_and_enqueue_escrow_reward_v3(text,integer,text,bigint,numeric,integer) from authenticated;
    revoke execute on function public.confirm_escrow_reward_settlement_v1(text,integer,text,bigint,numeric,integer) from authenticated;
    revoke execute on function public.get_schema_capabilities_v1() from authenticated;
  end if;
  if exists (select 1 from pg_roles where rolname = 'service_role') then
    grant execute on function public.mark_project_escrow_funded_v1(text,text,text,numeric,numeric,numeric,integer,integer,text,bigint) to service_role;
    grant execute on function public.confirm_work_unit_and_enqueue_escrow_reward_v3(text,integer,text,bigint,numeric,integer) to service_role;
    grant execute on function public.confirm_escrow_reward_settlement_v1(text,integer,text,bigint,numeric,integer) to service_role;
    grant execute on function public.get_schema_capabilities_v1() to service_role;
  end if;
end;
$$;

do $$
declare v_project record;
begin
  for v_project in
    select project_id from public.learning_projects
    where status = 'GENERATING' and escrow_state = 'UNFUNDED'
  loop
    perform public.enqueue_workflow_job_v2(v_project.project_id, 'RECONCILE_PROJECT');
  end loop;
end;
$$;

commit;
