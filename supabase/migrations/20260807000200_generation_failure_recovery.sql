begin;

-- Quality evaluations use APPROVED, while persisted candidates use ACCEPTED.
-- Keep confirmation aligned with approve_chapter_candidates_v3 so a valid V3
-- Work Unit can advance to CONFIRMED and enqueue its Escrow Reward.
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
    v_project.reward_per_work_unit_wei, 'PENDING'
  ) on conflict (project_id, work_unit_id) do nothing;
  return true;
end;
$$;

create or replace function public.reflect_terminal_learning_workflow_failure_v2()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_failed_job public.workflow_jobs%rowtype;
begin
  if new.status not in ('SUCCEEDED', 'FAILED', 'CANCELLED')
    or old.status is not distinct from new.status
    or new.kind = 'SETTLE_WORK_UNIT_REWARD' then
    return new;
  end if;

  select * into v_failed_job
  from public.workflow_jobs
  where project_id = new.project_id
    and kind <> 'SETTLE_WORK_UNIT_REWARD'
    and status = 'FAILED'
  order by completed_at desc nulls last, created_at desc
  limit 1;
  if not found then return new; end if;

  -- Parallel Work Units may still finish successfully. Only close the current
  -- workflow stage after it has no claimable/running Job left.
  if exists (
    select 1 from public.workflow_jobs
    where project_id = new.project_id
      and status in ('QUEUED', 'RUNNING', 'RETRYABLE')
      and (
        (v_failed_job.kind = 'PLAN_OUTLINE' and kind = 'PLAN_OUTLINE')
        or (v_failed_job.kind in ('DESIGN_CHAPTER', 'FREEZE_PROJECT_DESIGN')
          and kind in ('DESIGN_CHAPTER', 'FREEZE_PROJECT_DESIGN'))
        or (v_failed_job.kind = 'RECONCILE_PROJECT' and kind = 'RECONCILE_PROJECT')
        or (v_failed_job.kind in ('GENERATE_WORK_UNIT', 'QUALITY_CHECK_CHAPTER', 'ASSEMBLE_CHAPTER', 'FINALIZE_PROJECT')
          and kind in ('GENERATE_WORK_UNIT', 'QUALITY_CHECK_CHAPTER', 'ASSEMBLE_CHAPTER', 'FINALIZE_PROJECT'))
      )
  ) then
    return new;
  end if;

  if v_failed_job.chapter_id is not null
    and v_failed_job.kind in ('GENERATE_WORK_UNIT', 'QUALITY_CHECK_CHAPTER', 'ASSEMBLE_CHAPTER') then
    update public.chapters
    set status = 'FAILED_RETRYABLE', last_error = v_failed_job.last_error
    where project_id = v_failed_job.project_id
      and chapter_id = v_failed_job.chapter_id
      and status not in ('READY', 'FAILED_RETRYABLE');
  end if;

  update public.learning_projects
  set status = 'FAILED_RETRYABLE', runner_lease_until = null, last_error = v_failed_job.last_error
  where project_id = v_failed_job.project_id
    and (
      (v_failed_job.kind = 'PLAN_OUTLINE' and status = 'OUTLINING')
      or (v_failed_job.kind in ('DESIGN_CHAPTER', 'FREEZE_PROJECT_DESIGN') and status = 'DESIGNING_CARDS')
      or (v_failed_job.kind = 'RECONCILE_PROJECT' and status = 'AWAITING_REGISTRY')
      or (v_failed_job.kind in ('GENERATE_WORK_UNIT', 'QUALITY_CHECK_CHAPTER', 'ASSEMBLE_CHAPTER') and status = 'GENERATING')
      or (v_failed_job.kind = 'FINALIZE_PROJECT' and status = 'FINALIZING')
    );
  return new;
end;
$$;

drop trigger if exists workflow_jobs_reflect_terminal_learning_failure on public.workflow_jobs;
create trigger workflow_jobs_reflect_terminal_learning_failure
after update of status on public.workflow_jobs
for each row execute function public.reflect_terminal_learning_workflow_failure_v2();

-- Existing terminal Jobs predate the trigger, so project their failure once.
update public.chapters as chapters
set status = 'FAILED_RETRYABLE', last_error = jobs.last_error
from public.workflow_jobs as jobs
where jobs.project_id = chapters.project_id
  and jobs.chapter_id = chapters.chapter_id
  and jobs.status = 'FAILED'
  and jobs.kind in ('GENERATE_WORK_UNIT', 'QUALITY_CHECK_CHAPTER', 'ASSEMBLE_CHAPTER')
  and chapters.status not in ('READY', 'FAILED_RETRYABLE');

update public.learning_projects as projects
set status = 'FAILED_RETRYABLE', runner_lease_until = null,
    last_error = (
      select jobs.last_error
      from public.workflow_jobs as jobs
      where jobs.project_id = projects.project_id
        and jobs.status = 'FAILED'
        and jobs.kind <> 'SETTLE_WORK_UNIT_REWARD'
      order by jobs.completed_at desc nulls last, jobs.created_at desc
      limit 1
    )
where (
  projects.status = 'GENERATING'
  or projects.status = 'FINALIZING'
  or projects.status = 'AWAITING_REGISTRY'
  or projects.status = 'DESIGNING_CARDS'
  or projects.status = 'OUTLINING'
)
and exists (
  select 1 from public.workflow_jobs as jobs
  where jobs.project_id = projects.project_id
    and jobs.status = 'FAILED'
    and jobs.kind <> 'SETTLE_WORK_UNIT_REWARD'
)
and not exists (
  select 1 from public.workflow_jobs as jobs
  where jobs.project_id = projects.project_id
    and jobs.status in ('QUEUED', 'RUNNING', 'RETRYABLE')
    and jobs.kind <> 'SETTLE_WORK_UNIT_REWARD'
);

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
      and units.status in ('QUEUED', 'GENERATING', 'VALIDATING', 'REPAIRING', 'RETRYABLE')
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

  update public.chapters as chapters
  set status = 'GENERATING', last_error = null
  where chapters.project_id = v_project_id
    and chapters.status = 'FAILED_RETRYABLE'
    and exists (
      select 1 from public.work_units as units
      where units.project_id = chapters.project_id
        and units.chapter_id = chapters.chapter_id
        and units.status = 'RETRYABLE'
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
        and units.status = 'RETRYABLE'
    );
  get diagnostics v_job_count = row_count;

  insert into public.workflow_events (
    job_id, project_id, chapter_id, work_unit_id, event_type, payload
  )
  select
    jobs.job_id, jobs.project_id, jobs.chapter_id, jobs.work_unit_id,
    'WORKFLOW_JOB_RECOVERY_QUEUED',
    jsonb_build_object('kind', jobs.kind, 'reason', 'owner_requested_generation_retry')
  from public.workflow_jobs as jobs
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

revoke execute on function public.reflect_terminal_learning_workflow_failure_v2() from public;
revoke execute on function public.retry_failed_project_generation_v2(text, text) from public;

do $$
begin
  if exists (select 1 from pg_roles where rolname = 'anon') then
    revoke execute on function public.retry_failed_project_generation_v2(text, text) from anon;
  end if;
  if exists (select 1 from pg_roles where rolname = 'authenticated') then
    revoke execute on function public.retry_failed_project_generation_v2(text, text) from authenticated;
  end if;
  if exists (select 1 from pg_roles where rolname = 'service_role') then
    grant execute on function public.retry_failed_project_generation_v2(text, text) to service_role;
  end if;
end;
$$;

commit;

notify pgrst, 'reload schema';
