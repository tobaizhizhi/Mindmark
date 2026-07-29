begin;

create function public.enqueue_workflow_job_v2(
  p_project_id text,
  p_kind text,
  p_chapter_id integer default null,
  p_work_unit_id integer default null,
  p_input jsonb default '{}'::jsonb
)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_project_id text := lower(p_project_id);
  v_job_id uuid;
begin
  if jsonb_typeof(p_input) <> 'object' then raise exception 'workflow input must be an object'; end if;
  perform 1 from public.learning_projects where project_id = v_project_id for update;
  if not found then raise exception 'Learning Project was not found'; end if;

  select job_id into v_job_id
  from public.workflow_jobs
  where project_id = v_project_id and kind = p_kind
    and chapter_id is not distinct from p_chapter_id::smallint
    and work_unit_id is not distinct from p_work_unit_id::smallint
    and status in ('QUEUED', 'RUNNING', 'RETRYABLE')
  order by created_at desc
  limit 1;
  if found then return v_job_id; end if;

  insert into public.workflow_jobs (project_id, kind, chapter_id, work_unit_id, input)
  values (v_project_id, p_kind, p_chapter_id::smallint, p_work_unit_id::smallint, p_input)
  returning job_id into v_job_id;
  insert into public.workflow_events (job_id, project_id, chapter_id, work_unit_id, event_type, payload)
  values (
    v_job_id, v_project_id, p_chapter_id::smallint, p_work_unit_id::smallint,
    'WORKFLOW_JOB_QUEUED', jsonb_build_object('kind', p_kind)
  );
  return v_job_id;
end;
$$;

create function public.queue_project_workflow_v2()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare v_unit record;
begin
  if new.status = 'AWAITING_REGISTRY' and (tg_op = 'INSERT' or old.status is distinct from new.status) then
    perform public.enqueue_workflow_job_v2(new.project_id, 'RECONCILE_PROJECT');
  end if;

  if new.status = 'GENERATING' and (tg_op = 'INSERT' or old.status is distinct from new.status) then
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

create function public.queue_work_unit_workflow_v2()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if exists (
    select 1 from public.learning_projects
    where project_id = new.project_id and status = 'GENERATING'
  ) then
    if new.status in ('QUEUED', 'RETRYABLE', 'REPAIRING', 'APPROVED', 'SUBMITTING')
      and (tg_op = 'INSERT' or old.status is distinct from new.status) then
      perform public.enqueue_workflow_job_v2(
        new.project_id, 'GENERATE_WORK_UNIT', new.chapter_id, new.work_unit_id
      );
    end if;

    if new.status = 'CANDIDATE_READY' and (tg_op = 'INSERT' or old.status is distinct from new.status)
      and exists (
        select 1 from public.work_units
        where project_id = new.project_id and chapter_id = new.chapter_id
      )
      and not exists (
        select 1 from public.work_units
        where project_id = new.project_id and chapter_id = new.chapter_id
          and status <> 'CANDIDATE_READY'
      ) then
      perform public.enqueue_workflow_job_v2(new.project_id, 'QUALITY_CHECK_CHAPTER', new.chapter_id);
    end if;

    if new.status = 'CONFIRMED' and (tg_op = 'INSERT' or old.status is distinct from new.status)
      and exists (
        select 1 from public.work_units
        where project_id = new.project_id and chapter_id = new.chapter_id
      )
      and not exists (
        select 1 from public.work_units
        where project_id = new.project_id and chapter_id = new.chapter_id
          and status <> 'CONFIRMED'
      ) then
      perform public.enqueue_workflow_job_v2(new.project_id, 'ASSEMBLE_CHAPTER', new.chapter_id);
    end if;
  end if;
  return new;
end;
$$;

create function public.queue_chapter_workflow_v2()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if new.status = 'READY' and (tg_op = 'INSERT' or old.status is distinct from new.status)
    and exists (
      select 1 from public.chapters where project_id = new.project_id
    )
    and not exists (
      select 1 from public.chapters where project_id = new.project_id and status <> 'READY'
    ) then
    perform public.enqueue_workflow_job_v2(new.project_id, 'FINALIZE_PROJECT');
  end if;
  return new;
end;
$$;

create function public.queue_work_unit_reward_workflow_v2()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if new.status in ('PENDING', 'RETRYABLE', 'PROCESSING', 'PREPARED', 'SUBMITTING')
    and (tg_op = 'INSERT' or old.status is distinct from new.status) then
    perform public.enqueue_workflow_job_v2(
      new.project_id, 'SETTLE_WORK_UNIT_REWARD', null, new.work_unit_id
    );
  end if;
  return new;
end;
$$;

create trigger learning_projects_queue_workflow
after insert or update of status on public.learning_projects
for each row execute function public.queue_project_workflow_v2();

create trigger work_units_queue_workflow
after insert or update of status on public.work_units
for each row execute function public.queue_work_unit_workflow_v2();

create trigger chapters_queue_workflow
after insert or update of status on public.chapters
for each row execute function public.queue_chapter_workflow_v2();

create trigger work_unit_rewards_queue_workflow
after insert or update of status on public.work_unit_rewards
for each row execute function public.queue_work_unit_reward_workflow_v2();

create function public.claim_work_unit_for_workflow_v2(
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

create function public.claim_chapter_quality_check_for_workflow_v2(
  p_project_id text,
  p_chapter_id integer
)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
begin
  update public.chapters as chapters
  set status = 'QUALITY_CHECK', last_error = null
  where chapters.project_id = lower(p_project_id) and chapters.chapter_id = p_chapter_id::smallint
    and chapters.status in ('GENERATING', 'FAILED_RETRYABLE')
    and exists (
      select 1 from public.learning_projects as projects
      where projects.project_id = chapters.project_id and projects.status = 'GENERATING'
    )
    and exists (
      select 1 from public.work_units as units
      where units.project_id = chapters.project_id and units.chapter_id = chapters.chapter_id
    )
    and not exists (
      select 1 from public.work_units as units
      where units.project_id = chapters.project_id and units.chapter_id = chapters.chapter_id
        and units.status <> 'CANDIDATE_READY'
    );
  return found;
end;
$$;

create function public.claim_chapter_assembly_for_workflow_v2(
  p_project_id text,
  p_chapter_id integer
)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
begin
  update public.chapters as chapters
  set status = 'ASSEMBLING', assembly_attempt = least(assembly_attempt + 1, 10),
      assembly_lease_until = now() + interval '90 seconds', last_error = null
  where chapters.project_id = lower(p_project_id) and chapters.chapter_id = p_chapter_id::smallint
    and chapters.status in ('GENERATING', 'FAILED_RETRYABLE')
    and exists (
      select 1 from public.learning_projects as projects
      where projects.project_id = chapters.project_id and projects.status = 'GENERATING'
    )
    and exists (
      select 1 from public.work_units as units
      where units.project_id = chapters.project_id and units.chapter_id = chapters.chapter_id
    )
    and not exists (
      select 1 from public.work_units as units
      where units.project_id = chapters.project_id and units.chapter_id = chapters.chapter_id
        and units.status <> 'CONFIRMED'
    );
  return found;
end;
$$;

create function public.claim_project_finalization_for_workflow_v2(p_project_id text)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
begin
  update public.learning_projects as projects
  set status = 'FINALIZING', runner_lease_until = now() + interval '90 seconds', last_error = null
  where projects.project_id = lower(p_project_id)
    and projects.status in ('GENERATING', 'FINALIZING', 'FAILED_RETRYABLE')
    and exists (select 1 from public.chapters where project_id = projects.project_id)
    and not exists (
      select 1 from public.chapters
      where project_id = projects.project_id and status <> 'READY'
    );
  return found;
end;
$$;

create function public.claim_work_unit_reward_for_workflow_v2(
  p_project_id text,
  p_work_unit_id integer
)
returns setof public.work_unit_rewards
language plpgsql
security definer
set search_path = public
as $$
declare v_status text;
begin
  select status into v_status
  from public.work_unit_rewards
  where project_id = lower(p_project_id) and work_unit_id = p_work_unit_id::smallint
  for update;
  if not found or v_status in ('CONFIRMED', 'BLOCKED') then return; end if;
  if v_status not in ('PENDING', 'RETRYABLE', 'PROCESSING', 'PREPARED', 'SUBMITTING') then return; end if;

  update public.work_unit_rewards
  set status = case when v_status in ('PENDING', 'RETRYABLE', 'PROCESSING') then 'PROCESSING' else v_status end,
      attempt = least(attempt + 1, 20), lease_until = now() + interval '90 seconds'
  where project_id = lower(p_project_id) and work_unit_id = p_work_unit_id::smallint;
  return query select * from public.work_unit_rewards
  where project_id = lower(p_project_id) and work_unit_id = p_work_unit_id::smallint;
end;
$$;

create or replace function public.retry_workflow_job_v2(p_job_id uuid, p_error text)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare
  v_job public.workflow_jobs%rowtype;
  v_status text;
  v_attempt_limit smallint;
begin
  select kind into v_job.kind from public.workflow_jobs where job_id = p_job_id;
  if not found then raise exception 'workflow job was not found'; end if;
  v_attempt_limit := case when v_job.kind = 'PLAN_OUTLINE' then 3 else 10 end;
  update public.workflow_jobs
  set status = case when attempt >= v_attempt_limit then 'FAILED' else 'RETRYABLE' end,
      lease_until = null,
      available_at = now() + make_interval(secs => least(300, 5 * power(2, attempt)::integer)),
      last_error = left(p_error, 500),
      completed_at = case when attempt >= v_attempt_limit then now() else null end
  where job_id = p_job_id and status = 'RUNNING'
  returning * into v_job;
  if not found then raise exception 'workflow job is not running'; end if;
  v_status := v_job.status;
  insert into public.workflow_events (job_id, project_id, chapter_id, work_unit_id, event_type, payload)
  values (v_job.job_id, v_job.project_id, v_job.chapter_id, v_job.work_unit_id,
    case when v_status = 'FAILED' then 'WORKFLOW_JOB_FAILED' else 'WORKFLOW_JOB_RETRYABLE' end,
    jsonb_build_object('kind', v_job.kind, 'attempt', v_job.attempt, 'error', v_job.last_error));
  if v_status = 'FAILED' and v_job.kind = 'PLAN_OUTLINE' then
    update public.learning_projects
    set status = 'FAILED_RETRYABLE', last_error = v_job.last_error
    where project_id = v_job.project_id and status = 'OUTLINING';
  end if;
  return true;
end;
$$;

create or replace function public.recover_stale_workflow_jobs_v2()
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare v_count integer;
begin
  update public.workflow_jobs
  set status = case
        when kind = 'PLAN_OUTLINE' and attempt >= 3 then 'FAILED'
        when kind <> 'PLAN_OUTLINE' and attempt >= 10 then 'FAILED'
        else 'RETRYABLE'
      end,
      lease_until = null,
      available_at = now(),
      last_error = 'workflow lease expired',
      completed_at = case
        when (kind = 'PLAN_OUTLINE' and attempt >= 3) or (kind <> 'PLAN_OUTLINE' and attempt >= 10) then now()
        else null
      end
  where status = 'RUNNING' and lease_until < now();
  get diagnostics v_count = row_count;
  update public.learning_projects as projects
  set status = 'FAILED_RETRYABLE', last_error = 'workflow lease expired'
  where projects.status = 'OUTLINING'
    and exists (
      select 1 from public.workflow_jobs as jobs
      where jobs.project_id = projects.project_id
        and jobs.kind = 'PLAN_OUTLINE'
        and jobs.status = 'FAILED'
        and jobs.last_error = 'workflow lease expired'
    );
  return v_count;
end;
$$;

do $$
declare v_project record; v_unit record; v_chapter record; v_reward record;
begin
  for v_project in select project_id from public.learning_projects where status = 'AWAITING_REGISTRY' loop
    perform public.enqueue_workflow_job_v2(v_project.project_id, 'RECONCILE_PROJECT');
  end loop;
  for v_unit in
    select units.project_id, units.chapter_id, units.work_unit_id
    from public.work_units as units
    join public.learning_projects as projects on projects.project_id = units.project_id
    where projects.status = 'GENERATING'
      and units.status in ('QUEUED', 'RETRYABLE', 'REPAIRING', 'APPROVED', 'SUBMITTING', 'GENERATING')
  loop
    perform public.enqueue_workflow_job_v2(
      v_unit.project_id, 'GENERATE_WORK_UNIT', v_unit.chapter_id, v_unit.work_unit_id
    );
  end loop;
  for v_chapter in
    select chapters.project_id, chapters.chapter_id
    from public.chapters as chapters
    join public.learning_projects as projects on projects.project_id = chapters.project_id
    where projects.status = 'GENERATING' and chapters.status in ('GENERATING', 'FAILED_RETRYABLE')
      and exists (select 1 from public.work_units as units where units.project_id = chapters.project_id and units.chapter_id = chapters.chapter_id)
      and not exists (
        select 1 from public.work_units as units
        where units.project_id = chapters.project_id and units.chapter_id = chapters.chapter_id
          and units.status <> 'CANDIDATE_READY'
      )
  loop
    perform public.enqueue_workflow_job_v2(v_chapter.project_id, 'QUALITY_CHECK_CHAPTER', v_chapter.chapter_id);
  end loop;
  for v_chapter in
    select chapters.project_id, chapters.chapter_id
    from public.chapters as chapters
    join public.learning_projects as projects on projects.project_id = chapters.project_id
    where projects.status = 'GENERATING' and chapters.status in ('GENERATING', 'FAILED_RETRYABLE')
      and exists (select 1 from public.work_units as units where units.project_id = chapters.project_id and units.chapter_id = chapters.chapter_id)
      and not exists (
        select 1 from public.work_units as units
        where units.project_id = chapters.project_id and units.chapter_id = chapters.chapter_id
          and units.status <> 'CONFIRMED'
      )
  loop
    perform public.enqueue_workflow_job_v2(v_chapter.project_id, 'ASSEMBLE_CHAPTER', v_chapter.chapter_id);
  end loop;
  for v_project in
    select projects.project_id from public.learning_projects as projects
    where projects.status in ('GENERATING', 'FINALIZING', 'FAILED_RETRYABLE')
      and exists (select 1 from public.chapters where project_id = projects.project_id)
      and not exists (select 1 from public.chapters where project_id = projects.project_id and status <> 'READY')
  loop
    perform public.enqueue_workflow_job_v2(v_project.project_id, 'FINALIZE_PROJECT');
  end loop;
  for v_reward in
    select project_id, work_unit_id from public.work_unit_rewards
    where status in ('PENDING', 'RETRYABLE', 'PROCESSING', 'PREPARED', 'SUBMITTING')
  loop
    perform public.enqueue_workflow_job_v2(v_reward.project_id, 'SETTLE_WORK_UNIT_REWARD', null, v_reward.work_unit_id);
  end loop;
end;
$$;

drop function public.claim_next_work_unit_v2(text);
drop function public.recover_stale_work_units_v2();
drop function public.claim_next_chapter_quality_check_v2();
drop function public.claim_next_chapter_assembly_v2();
drop function public.claim_next_project_finalization_v2();
drop function public.claim_work_unit_reward_v2();

revoke execute on function public.enqueue_workflow_job_v2(text, text, integer, integer, jsonb) from public;
revoke execute on function public.claim_work_unit_for_workflow_v2(text, integer, text) from public;
revoke execute on function public.claim_chapter_quality_check_for_workflow_v2(text, integer) from public;
revoke execute on function public.claim_chapter_assembly_for_workflow_v2(text, integer) from public;
revoke execute on function public.claim_project_finalization_for_workflow_v2(text) from public;
revoke execute on function public.claim_work_unit_reward_for_workflow_v2(text, integer) from public;

do $$
begin
  if exists (select 1 from pg_roles where rolname = 'service_role') then
    grant execute on function public.enqueue_workflow_job_v2(text, text, integer, integer, jsonb) to service_role;
    grant execute on function public.claim_work_unit_for_workflow_v2(text, integer, text) to service_role;
    grant execute on function public.claim_chapter_quality_check_for_workflow_v2(text, integer) to service_role;
    grant execute on function public.claim_chapter_assembly_for_workflow_v2(text, integer) to service_role;
    grant execute on function public.claim_project_finalization_for_workflow_v2(text) to service_role;
    grant execute on function public.claim_work_unit_reward_for_workflow_v2(text, integer) to service_role;
  end if;
end;
$$;

commit;
