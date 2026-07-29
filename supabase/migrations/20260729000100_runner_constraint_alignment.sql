begin;

alter table public.project_agent_events
  drop constraint project_agent_events_agent_role_check,
  add constraint project_agent_events_agent_role_check check (
    agent_role in (
      'chapter-planner', 'worker', 'chapter-quality-gate', 'chapter-assembler',
      'project-finalizer', 'settlement-agent'
    )
  );

alter table public.work_units
  drop constraint work_units_attempt_check,
  add constraint work_units_attempt_check check (attempt between 0 and 10);

commit;
