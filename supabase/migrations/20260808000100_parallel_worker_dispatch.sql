begin;

-- Claim one generation job for a specific Worker lane. The lane is derived
-- from the same work_unit_id % 3 mapping used by the Runner, so one wallet
-- can never have two concurrent generation/commit jobs from this queue.
create function public.claim_next_generation_workflow_job_for_worker_v2(
  p_worker_index integer
)
returns setof public.workflow_jobs
language plpgsql
security definer
set search_path = public
as $$
declare
  v_job_id uuid;
begin
  if p_worker_index < 0 or p_worker_index > 2 then
    raise exception 'Worker index must be between 0 and 2';
  end if;

  select job_id into v_job_id
  from public.workflow_jobs
  where kind = 'GENERATE_WORK_UNIT'
    and work_unit_id is not null
    and mod(work_unit_id, 3) = p_worker_index
    and status in ('QUEUED', 'RETRYABLE')
    and available_at <= now()
  order by available_at, created_at
  for update skip locked
  limit 1;

  if not found then return; end if;

  update public.workflow_jobs
  set status = 'RUNNING',
      attempt = attempt + 1,
      started_at = coalesce(started_at, now()),
      lease_until = now() + interval '90 seconds',
      last_error = null
  where job_id = v_job_id;

  return query
    select * from public.workflow_jobs where job_id = v_job_id;
end;
$$;

revoke execute on function public.claim_next_generation_workflow_job_for_worker_v2(integer) from public;

do $$
begin
  if exists (select 1 from pg_roles where rolname = 'anon') then
    revoke execute on function public.claim_next_generation_workflow_job_for_worker_v2(integer) from anon;
  end if;
  if exists (select 1 from pg_roles where rolname = 'authenticated') then
    revoke execute on function public.claim_next_generation_workflow_job_for_worker_v2(integer) from authenticated;
  end if;
  if exists (select 1 from pg_roles where rolname = 'service_role') then
    grant execute on function public.claim_next_generation_workflow_job_for_worker_v2(integer) to service_role;
  end if;
end;
$$;

alter function public.get_schema_capabilities_v1() rename to get_schema_capabilities_pre_parallel_v1;

create function public.get_schema_capabilities_v1()
returns jsonb
language plpgsql
stable
security definer
set search_path = pg_catalog, public
as $$
declare
  v_previous jsonb;
  v_parallel boolean;
  v_missing jsonb;
begin
  v_previous := public.get_schema_capabilities_pre_parallel_v1();
  v_parallel := to_regprocedure(
    'public.claim_next_generation_workflow_job_for_worker_v2(integer)'
  ) is not null;
  v_missing := coalesce(v_previous->'missing', '[]'::jsonb);
  if not v_parallel and not v_missing @> '["parallel_worker_dispatch"]'::jsonb then
    v_missing := v_missing || '"parallel_worker_dispatch"'::jsonb;
  end if;
  return jsonb_build_object(
    'schemaVersion', '2026-08-08.1',
    'capabilities', (v_previous->'capabilities') || jsonb_build_object(
      'parallelWorkerDispatch', v_parallel
    ),
    'missing', v_missing
  );
end;
$$;

revoke execute on function public.get_schema_capabilities_v1() from public;

do $$
begin
  if exists (select 1 from pg_roles where rolname = 'anon') then
    revoke execute on function public.get_schema_capabilities_v1() from anon;
  end if;
  if exists (select 1 from pg_roles where rolname = 'authenticated') then
    revoke execute on function public.get_schema_capabilities_v1() from authenticated;
  end if;
  if exists (select 1 from pg_roles where rolname = 'service_role') then
    grant execute on function public.get_schema_capabilities_v1() to service_role;
  end if;
end;
$$;

comment on function public.claim_next_generation_workflow_job_for_worker_v2(integer) is
  'Claims one GENERATE_WORK_UNIT job from a deterministic Worker lane for safe parallel generation.';

notify pgrst, 'reload schema';
commit;
