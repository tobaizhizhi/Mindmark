begin;

create function public.get_workflow_operations_v2()
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_jobs jsonb;
  v_events jsonb;
  v_metrics jsonb;
  v_alerts jsonb;
begin
  select jsonb_build_object(
    'queuedJobs', count(*) filter (where status = 'QUEUED'),
    'runningJobs', count(*) filter (where status = 'RUNNING'),
    'retryableJobs', count(*) filter (where status = 'RETRYABLE'),
    'failedJobs', count(*) filter (where status = 'FAILED'),
    'staleJobs', count(*) filter (where status = 'RUNNING' and lease_until < now()),
    'succeededJobs', count(*) filter (where status = 'SUCCEEDED')
  ) into v_metrics
  from public.workflow_jobs;

  v_metrics := v_metrics || jsonb_build_object(
    'pendingRewards', (select count(*) from public.work_unit_rewards where status in ('PENDING', 'PROCESSING', 'PREPARED', 'SUBMITTING')),
    'blockedRewards', (select count(*) from public.work_unit_rewards where status = 'BLOCKED'),
    'retryableRewards', (select count(*) from public.work_unit_rewards where status = 'RETRYABLE'),
    'failedProjects', (select count(*) from public.learning_projects where status = 'FAILED_RETRYABLE')
  );

  select coalesce(jsonb_agg(jsonb_build_object(
    'severity', alerts.severity,
    'code', alerts.code,
    'count', alerts.count,
    'message', alerts.message
  )), '[]'::jsonb)
  into v_alerts
  from (
    select 'critical'::text as severity, 'STALE_JOBS'::text as code,
      (v_metrics->>'staleJobs')::integer as count, '工作流租约已过期，需要恢复或检查 Runner。'::text as message
    union all
    select 'critical', 'FAILED_JOBS', (v_metrics->>'failedJobs')::integer, '工作流已达到重试上限，需要人工处理。'
    union all
    select 'warning', 'BLOCKED_REWARDS', (v_metrics->>'blockedRewards')::integer, '奖励验证受阻，学习内容不会回滚。'
    union all
    select 'warning', 'FAILED_PROJECTS', (v_metrics->>'failedProjects')::integer, 'Learning Project 处于可重试失败状态。'
  ) as alerts
  where alerts.count > 0;

  select coalesce(jsonb_agg(to_jsonb(job_rows) - 'created_at' order by job_rows.created_at desc), '[]'::jsonb)
  into v_jobs
  from (
    select
      jobs.job_id as "jobId",
      jobs.project_id as "projectId",
      projects.title as "projectTitle",
      jobs.kind,
      jobs.status,
      jobs.chapter_id as "chapterId",
      jobs.work_unit_id as "workUnitId",
      jobs.attempt,
      jobs.available_at as "availableAt",
      jobs.lease_until as "leaseUntil",
      jobs.last_error as "lastError",
      jobs.created_at as "createdAt",
      jobs.started_at as "startedAt",
      jobs.completed_at as "completedAt",
      jobs.created_at
    from public.workflow_jobs as jobs
    join public.learning_projects as projects on projects.project_id = jobs.project_id
    where jobs.status <> 'SUCCEEDED'
    order by jobs.created_at desc
    limit 100
  ) as job_rows;

  select coalesce(jsonb_agg(to_jsonb(event_rows) - 'created_at' order by event_rows.created_at desc), '[]'::jsonb)
  into v_events
  from (
    select
      events.event_id as "eventId",
      events.job_id as "jobId",
      events.project_id as "projectId",
      events.chapter_id as "chapterId",
      events.work_unit_id as "workUnitId",
      events.event_type as "eventType",
      events.payload,
      events.created_at as "createdAt",
      events.created_at
    from public.workflow_events as events
    order by events.created_at desc
    limit 80
  ) as event_rows;

  return jsonb_build_object(
    'generatedAt', now(),
    'metrics', v_metrics,
    'alerts', v_alerts,
    'jobs', v_jobs,
    'events', v_events
  );
end;
$$;

revoke execute on function public.get_workflow_operations_v2() from public;

do $$
begin
  if exists (select 1 from pg_roles where rolname = 'service_role') then
    grant execute on function public.get_workflow_operations_v2() to service_role;
  end if;
end;
$$;

commit;
