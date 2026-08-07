begin;

-- Keep projects funded under the pre-dynamic fixed-price model confirmable.
-- Dynamic projects must use their immutable per-Work-Unit quote; legacy
-- projects use the frozen project-level price captured in Sponsor Escrow.
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
  v_reward_amount_wei numeric;
  v_approved_evaluation_count integer;
begin
  select project_escrow_address, sponsor_treasury_address,
    reward_per_work_unit_wei, pricing_policy_version, pricing_root,
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
    or v_unit.card_count <= 0 then
    raise exception 'quality-approved Work Unit confirmation target is missing';
  end if;

  if v_project.pricing_policy_version is null and v_project.pricing_root is null then
    v_reward_amount_wei := v_project.reward_per_work_unit_wei;
  elsif v_project.pricing_policy_version = 'work-unit-pricing-v1'
    and v_project.pricing_root is not null then
    v_reward_amount_wei := v_unit.reward_amount_wei;
  else
    raise exception 'Project has incomplete Sponsor Escrow pricing evidence';
  end if;
  if v_reward_amount_wei is null or v_reward_amount_wei <= 0 then
    raise exception 'quality-approved Work Unit pricing target is missing';
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
    v_reward_amount_wei, 'PENDING'
  ) on conflict (project_id, work_unit_id) do nothing;
  return true;
end;
$$;

-- Existing failed GENERATE_WORK_UNIT jobs for an APPROVED Work Unit only need
-- to be replayed through the persisted-card submission path. They must not
-- reset the Work Unit to GENERATING or invoke the model again.
create or replace function public.retry_failed_project_generation_v2(
  p_project_id text,
  p_owner text
)
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  v_project_id text := lower(p_project_id);
  v_owner text := lower(p_owner);
  v_status text;
  v_job_count integer;
begin
  select status into v_status
  from public.learning_projects
  where project_id = v_project_id and owner_address = v_owner
  for update;
  if not found then raise exception 'Learning Project was not found'; end if;
  if v_status <> 'FAILED_RETRYABLE' then
    raise exception 'Learning Project is not in retryable failure state';
  end if;
  if exists (
    select 1 from public.workflow_jobs
    where project_id = v_project_id
      and kind in ('GENERATE_WORK_UNIT', 'QUALITY_CHECK_CHAPTER', 'ASSEMBLE_CHAPTER', 'FINALIZE_PROJECT')
      and status in ('QUEUED', 'RUNNING', 'RETRYABLE')
  ) then
    raise exception 'Learning Project generation already has active work';
  end if;
  if not exists (
    select 1
    from public.workflow_jobs as jobs
    join public.work_units as units
      on units.project_id = jobs.project_id and units.work_unit_id = jobs.work_unit_id
    where jobs.project_id = v_project_id
      and jobs.kind = 'GENERATE_WORK_UNIT'
      and jobs.status = 'FAILED'
      and units.status in (
        'QUEUED', 'GENERATING', 'VALIDATING', 'REPAIRING', 'RETRYABLE', 'APPROVED', 'SUBMITTING'
      )
  ) then
    raise exception 'Learning Project has no failed generation work to retry';
  end if;

  update public.work_units as units
  set status = 'RETRYABLE', attempt = 0, lease_until = null, last_error = null
  where units.project_id = v_project_id
    and units.status in ('QUEUED', 'GENERATING', 'VALIDATING', 'REPAIRING', 'RETRYABLE')
    and exists (
      select 1 from public.workflow_jobs as jobs
      where jobs.project_id = units.project_id
        and jobs.work_unit_id = units.work_unit_id
        and jobs.kind = 'GENERATE_WORK_UNIT'
        and jobs.status = 'FAILED'
    );

  update public.work_units as units
  set lease_until = null, last_error = null
  where units.project_id = v_project_id
    and units.status in ('APPROVED', 'SUBMITTING')
    and exists (
      select 1 from public.workflow_jobs as jobs
      where jobs.project_id = units.project_id
        and jobs.work_unit_id = units.work_unit_id
        and jobs.kind = 'GENERATE_WORK_UNIT'
        and jobs.status = 'FAILED'
    );

  update public.chapters as chapters
  set status = 'GENERATING', last_error = null
  where chapters.project_id = v_project_id
    and chapters.status = 'FAILED_RETRYABLE'
    and exists (
      select 1 from public.work_units as units
      where units.project_id = chapters.project_id
        and units.chapter_id = chapters.chapter_id
        and units.status in ('RETRYABLE', 'APPROVED', 'SUBMITTING')
    );

  update public.workflow_jobs as jobs
  set status = 'QUEUED', attempt = 0, available_at = now(),
      lease_until = null, started_at = null, completed_at = null,
      last_error = null, output = '{}'::jsonb
  where jobs.project_id = v_project_id
    and jobs.kind = 'GENERATE_WORK_UNIT'
    and jobs.status = 'FAILED'
    and exists (
      select 1 from public.work_units as units
      where units.project_id = jobs.project_id
        and units.work_unit_id = jobs.work_unit_id
        and units.status in ('RETRYABLE', 'APPROVED', 'SUBMITTING')
    );
  get diagnostics v_job_count = row_count;

  insert into public.workflow_events (
    job_id, project_id, chapter_id, work_unit_id, event_type, payload
  )
  select
    jobs.job_id, jobs.project_id, jobs.chapter_id, jobs.work_unit_id,
    'WORKFLOW_JOB_RECOVERY_QUEUED',
    jsonb_build_object(
      'kind', jobs.kind,
      'reason', case
        when units.status in ('APPROVED', 'SUBMITTING') then 'owner_requested_persisted_work_unit_confirmation_retry'
        else 'owner_requested_generation_retry'
      end
    )
  from public.workflow_jobs as jobs
  join public.work_units as units
    on units.project_id = jobs.project_id and units.work_unit_id = jobs.work_unit_id
  where jobs.project_id = v_project_id
    and jobs.kind = 'GENERATE_WORK_UNIT'
    and jobs.status = 'QUEUED'
    and jobs.attempt = 0;

  update public.learning_projects
  set status = 'GENERATING', runner_lease_until = null, last_error = null
  where project_id = v_project_id;

  return v_job_count;
end;
$$;

-- A Registry receipt is not a Sponsor Escrow receipt. Keep the queue trigger
-- from starting Work Units while the Project is still waiting for funding.
create or replace function public.queue_project_workflow_v2()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_unit record;
begin
  if new.status = 'AWAITING_REGISTRY' and (tg_op = 'INSERT' or old.status is distinct from new.status) then
    perform public.enqueue_workflow_job_v2(new.project_id, 'RECONCILE_PROJECT');
  end if;

  if new.status = 'GENERATING'
    and new.escrow_state = 'FUNDED'
    and (tg_op = 'INSERT' or old.status is distinct from new.status) then
    for v_unit in
      select chapter_id, work_unit_id from public.work_units
      where project_id = new.project_id
        and status in ('QUEUED', 'RETRYABLE', 'REPAIRING', 'APPROVED', 'SUBMITTING', 'GENERATING')
    loop
      perform public.enqueue_workflow_job_v2(
        new.project_id, 'GENERATE_WORK_UNIT', v_unit.chapter_id, v_unit.work_unit_id
      );
    end loop;
  end if;
  return new;
end;
$$;

create or replace function public.claim_work_unit_for_workflow_v2(
  p_project_id text,
  p_work_unit_id integer,
  p_worker_address text
)
returns setof public.work_units
language plpgsql
security definer
set search_path = public
as $$
declare
  v_project_id text := lower(p_project_id);
  v_work_unit_id smallint := p_work_unit_id::smallint;
  v_status text;
  v_worker text;
  v_chapter_id smallint;
begin
  if lower(p_worker_address) !~ '^0x[0-9a-f]{40}$' then raise exception 'invalid Worker address'; end if;
  select units.status, units.worker_address, units.chapter_id
  into v_status, v_worker, v_chapter_id
  from public.work_units as units
  join public.learning_projects as projects on projects.project_id = units.project_id
  where units.project_id = v_project_id and units.work_unit_id = v_work_unit_id
    and projects.status = 'GENERATING'
    and projects.escrow_state = 'FUNDED'
  for update of units;
  if not found then return; end if;

  if v_status in ('QUEUED', 'RETRYABLE', 'REPAIRING') then
    update public.work_units
    set status = 'GENERATING', worker_address = lower(p_worker_address),
        attempt = least(attempt + 1, 10), lease_until = now() + interval '90 seconds', last_error = null
    where project_id = v_project_id and work_unit_id = v_work_unit_id;
    update public.chapters
    set status = 'GENERATING', last_error = null
    where project_id = v_project_id and chapter_id = v_chapter_id
      and status in ('CONFIRMED', 'FAILED_RETRYABLE');
  elsif v_status in ('APPROVED', 'SUBMITTING', 'GENERATING') then
    if v_worker is distinct from lower(p_worker_address) then return; end if;
    update public.work_units
    set lease_until = now() + interval '90 seconds'
    where project_id = v_project_id and work_unit_id = v_work_unit_id;
  else
    return;
  end if;

  return query select * from public.work_units
  where project_id = v_project_id and work_unit_id = v_work_unit_id;
end;
$$;

revoke execute on function public.confirm_work_unit_and_enqueue_escrow_reward_v3(text, integer, text, bigint, numeric, integer) from public;
revoke execute on function public.retry_failed_project_generation_v2(text, text) from public;

do $$
begin
  if exists (select 1 from pg_roles where rolname = 'anon') then
    revoke execute on function public.confirm_work_unit_and_enqueue_escrow_reward_v3(text, integer, text, bigint, numeric, integer) from anon;
    revoke execute on function public.retry_failed_project_generation_v2(text, text) from anon;
  end if;
  if exists (select 1 from pg_roles where rolname = 'authenticated') then
    revoke execute on function public.confirm_work_unit_and_enqueue_escrow_reward_v3(text, integer, text, bigint, numeric, integer) from authenticated;
    revoke execute on function public.retry_failed_project_generation_v2(text, text) from authenticated;
  end if;
  if exists (select 1 from pg_roles where rolname = 'service_role') then
    grant execute on function public.confirm_work_unit_and_enqueue_escrow_reward_v3(text, integer, text, bigint, numeric, integer) to service_role;
    grant execute on function public.retry_failed_project_generation_v2(text, text) to service_role;
  end if;
end;
$$;

comment on function public.confirm_work_unit_and_enqueue_escrow_reward_v3(text, integer, text, bigint, numeric, integer) is
  'Confirms a quality-approved Work Unit using its dynamic quote or legacy funded fixed price and enqueues one Escrow Reward.';

commit;

notify pgrst, 'reload schema';
