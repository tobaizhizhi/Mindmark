begin;

create table public.workflow_jobs (
  job_id uuid primary key default gen_random_uuid(),
  project_id text not null references public.learning_projects(project_id) on delete cascade,
  kind text not null check (kind in (
    'PLAN_OUTLINE', 'RECONCILE_PROJECT', 'GENERATE_WORK_UNIT',
    'QUALITY_CHECK_CHAPTER', 'ASSEMBLE_CHAPTER', 'FINALIZE_PROJECT',
    'SETTLE_WORK_UNIT_REWARD'
  )),
  chapter_id smallint check (chapter_id is null or chapter_id between 0 and 15),
  work_unit_id smallint check (work_unit_id is null or work_unit_id between 0 and 47),
  status text not null default 'QUEUED' check (status in (
    'QUEUED', 'RUNNING', 'SUCCEEDED', 'RETRYABLE', 'FAILED', 'CANCELLED'
  )),
  attempt smallint not null default 0 check (attempt between 0 and 10),
  available_at timestamptz not null default now(),
  lease_until timestamptz,
  input jsonb not null default '{}'::jsonb check (jsonb_typeof(input) = 'object'),
  output jsonb check (output is null or jsonb_typeof(output) = 'object'),
  last_error text check (last_error is null or char_length(last_error) <= 500),
  created_at timestamptz not null default now(),
  started_at timestamptz,
  completed_at timestamptz
);

create unique index workflow_jobs_active_aggregate_idx
  on public.workflow_jobs (project_id, kind, coalesce(chapter_id, -1), coalesce(work_unit_id, -1))
  where status in ('QUEUED', 'RUNNING', 'RETRYABLE');
create index workflow_jobs_claim_idx
  on public.workflow_jobs (status, available_at, created_at);

create table public.workflow_events (
  event_id bigint generated always as identity primary key,
  job_id uuid references public.workflow_jobs(job_id) on delete set null,
  project_id text not null references public.learning_projects(project_id) on delete cascade,
  chapter_id smallint,
  work_unit_id smallint,
  event_type text not null check (char_length(event_type) between 1 and 100),
  payload jsonb not null default '{}'::jsonb check (jsonb_typeof(payload) = 'object'),
  created_at timestamptz not null default now()
);
create index workflow_events_project_created_idx
  on public.workflow_events (project_id, created_at desc);

create function public.enqueue_outline_planning_v2(p_project_id text, p_owner text)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_project_id text := lower(p_project_id);
  v_owner text := lower(p_owner);
  v_job_id uuid;
begin
  if not exists (
    select 1 from public.learning_projects
    where project_id = v_project_id
      and owner_address = v_owner
      and status in ('UPLOADED', 'OUTLINING', 'OUTLINE_READY', 'FAILED_RETRYABLE')
  ) then
    raise exception 'editable Learning Project source was not found';
  end if;

  select job_id into v_job_id
  from public.workflow_jobs
  where project_id = v_project_id and kind = 'PLAN_OUTLINE'
    and chapter_id is null and work_unit_id is null
    and status in ('QUEUED', 'RUNNING', 'RETRYABLE')
  order by created_at desc
  limit 1;
  if found then return v_job_id; end if;

  insert into public.workflow_jobs (project_id, kind, input)
  values (v_project_id, 'PLAN_OUTLINE', jsonb_build_object('requestedBy', v_owner))
  returning job_id into v_job_id;
  update public.learning_projects
  set status = 'OUTLINING', last_error = null
  where project_id = v_project_id;
  insert into public.workflow_events (job_id, project_id, event_type, payload)
  values (v_job_id, v_project_id, 'OUTLINE_PLANNING_QUEUED', '{}'::jsonb);
  return v_job_id;
end;
$$;

create function public.claim_next_workflow_job_v2(p_kinds text[] default null)
returns setof public.workflow_jobs
language plpgsql
security definer
set search_path = public
as $$
declare
  v_job_id uuid;
begin
  select job_id into v_job_id
  from public.workflow_jobs
  where status in ('QUEUED', 'RETRYABLE')
    and available_at <= now()
    and (p_kinds is null or kind = any(p_kinds))
  order by available_at, created_at
  for update skip locked
  limit 1;
  if not found then return; end if;

  update public.workflow_jobs
  set status = 'RUNNING', attempt = attempt + 1,
      started_at = coalesce(started_at, now()), lease_until = now() + interval '90 seconds',
      last_error = null
  where job_id = v_job_id;
  return query select * from public.workflow_jobs where job_id = v_job_id;
end;
$$;

create function public.complete_workflow_job_v2(p_job_id uuid, p_output jsonb default '{}'::jsonb)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare
  v_job public.workflow_jobs%rowtype;
begin
  if jsonb_typeof(p_output) <> 'object' then raise exception 'job output must be an object'; end if;
  update public.workflow_jobs
  set status = 'SUCCEEDED', output = p_output, lease_until = null, completed_at = now()
  where job_id = p_job_id and status = 'RUNNING'
  returning * into v_job;
  if not found then raise exception 'workflow job is not running'; end if;
  insert into public.workflow_events (job_id, project_id, chapter_id, work_unit_id, event_type, payload)
  values (v_job.job_id, v_job.project_id, v_job.chapter_id, v_job.work_unit_id, 'WORKFLOW_JOB_SUCCEEDED',
    jsonb_build_object('kind', v_job.kind, 'attempt', v_job.attempt));
  return true;
end;
$$;

create function public.retry_workflow_job_v2(p_job_id uuid, p_error text)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare
  v_job public.workflow_jobs%rowtype;
  v_status text;
begin
  update public.workflow_jobs
  set status = case when attempt >= 3 then 'FAILED' else 'RETRYABLE' end,
      lease_until = null,
      available_at = now() + make_interval(secs => least(300, 5 * power(2, attempt)::integer)),
      last_error = left(p_error, 500),
      completed_at = case when attempt >= 3 then now() else null end
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

create function public.recover_stale_workflow_jobs_v2()
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare v_count integer;
begin
  update public.workflow_jobs
  set status = case when attempt >= 3 then 'FAILED' else 'RETRYABLE' end,
      lease_until = null,
      available_at = now(),
      last_error = 'workflow lease expired',
      completed_at = case when attempt >= 3 then now() else null end
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

alter table public.workflow_jobs enable row level security;
alter table public.workflow_events enable row level security;
alter table public.workflow_jobs force row level security;
alter table public.workflow_events force row level security;
revoke all on table public.workflow_jobs from public;
revoke all on table public.workflow_events from public;
revoke execute on function public.enqueue_outline_planning_v2(text, text) from public;
revoke execute on function public.claim_next_workflow_job_v2(text[]) from public;
revoke execute on function public.complete_workflow_job_v2(uuid, jsonb) from public;
revoke execute on function public.retry_workflow_job_v2(uuid, text) from public;
revoke execute on function public.recover_stale_workflow_jobs_v2() from public;

do $$
begin
  if exists (select 1 from pg_roles where rolname = 'anon') then
    revoke all on table public.workflow_jobs from anon;
    revoke all on table public.workflow_events from anon;
  end if;
  if exists (select 1 from pg_roles where rolname = 'authenticated') then
    revoke all on table public.workflow_jobs from authenticated;
    revoke all on table public.workflow_events from authenticated;
  end if;
  if exists (select 1 from pg_roles where rolname = 'service_role') then
    grant all on table public.workflow_jobs to service_role;
    grant all on table public.workflow_events to service_role;
    grant execute on function public.enqueue_outline_planning_v2(text, text) to service_role;
    grant execute on function public.claim_next_workflow_job_v2(text[]) to service_role;
    grant execute on function public.complete_workflow_job_v2(uuid, jsonb) to service_role;
    grant execute on function public.retry_workflow_job_v2(uuid, text) to service_role;
    grant execute on function public.recover_stale_workflow_jobs_v2() to service_role;
  end if;
end;
$$;

commit;
