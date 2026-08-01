begin;

-- V3 is additive. Existing policy-v2 Projects retain their original recovery path.
alter table public.learning_projects
  add column generation_policy_version smallint not null default 2 check (
    generation_policy_version in (2, 3)
  ),
  add column frozen_design_hash text check (
    frozen_design_hash is null or frozen_design_hash ~ '^0x[0-9a-f]{64}$'
  ),
  add column frozen_at timestamptz;

alter table public.learning_projects
  drop constraint learning_projects_status_check,
  add constraint learning_projects_status_check check (
    status in (
      'UPLOADED', 'OUTLINING', 'OUTLINE_READY', 'DESIGNING_CARDS',
      'AWAITING_REGISTRY', 'GENERATING', 'FINALIZING', 'READY',
      'FAILED_RETRYABLE', 'CANCELLED'
    )
  );

alter table public.workflow_jobs
  drop constraint workflow_jobs_kind_check,
  add constraint workflow_jobs_kind_check check (kind in (
    'PLAN_OUTLINE', 'DESIGN_CHAPTER', 'FREEZE_PROJECT_DESIGN',
    'RECONCILE_PROJECT', 'GENERATE_WORK_UNIT', 'QUALITY_CHECK_CHAPTER',
    'ASSEMBLE_CHAPTER', 'FINALIZE_PROJECT', 'SETTLE_WORK_UNIT_REWARD'
  ));

alter table public.project_agent_events
  drop constraint project_agent_events_agent_role_check,
  add constraint project_agent_events_agent_role_check check (
    agent_role in (
      'chapter-planner', 'chapter-design', 'worker', 'chapter-quality-gate',
      'chapter-assembler', 'project-finalizer', 'settlement-agent'
    )
  );

create table public.chapter_design_runs (
  design_run_id uuid primary key default gen_random_uuid(),
  project_id text not null references public.learning_projects(project_id) on delete cascade,
  chapter_id smallint not null check (chapter_id between 0 and 15),
  outline_version integer not null check (outline_version > 0),
  source_hash text not null check (source_hash ~ '^0x[0-9a-f]{64}$'),
  policy_version smallint not null check (policy_version = 3),
  status text not null check (status in ('RUNNING', 'COMPLETED', 'REPAIR_EXHAUSTED', 'FAILED', 'CANCELLED')),
  inventory jsonb check (inventory is null or jsonb_typeof(inventory) = 'object'),
  blueprint jsonb check (blueprint is null or jsonb_typeof(blueprint) = 'object'),
  inventory_hash text check (inventory_hash is null or inventory_hash ~ '^0x[0-9a-f]{64}$'),
  blueprint_hash text check (blueprint_hash is null or blueprint_hash ~ '^0x[0-9a-f]{64}$'),
  prompt_version text check (prompt_version is null or char_length(prompt_version) between 1 and 100),
  model_id text check (model_id is null or char_length(model_id) between 1 and 200),
  attempt smallint not null default 1 check (attempt between 1 and 10),
  metrics jsonb not null default '{}'::jsonb check (jsonb_typeof(metrics) = 'object'),
  last_error text check (last_error is null or char_length(last_error) <= 500),
  created_at timestamptz not null default now(),
  completed_at timestamptz,
  unique (project_id, chapter_id, outline_version, policy_version, attempt),
  foreign key (project_id, chapter_id) references public.chapters(project_id, chapter_id) on delete cascade,
  check ((status = 'COMPLETED') = (completed_at is not null)),
  check (
    (status = 'COMPLETED' and inventory is not null and blueprint is not null
      and inventory_hash is not null and blueprint_hash is not null
      and prompt_version is not null and model_id is not null)
    or status <> 'COMPLETED'
  )
);

create unique index chapter_design_runs_completed_unique_idx
  on public.chapter_design_runs (project_id, chapter_id, outline_version, policy_version)
  where status = 'COMPLETED';
create unique index chapter_design_runs_active_unique_idx
  on public.chapter_design_runs (project_id, chapter_id, outline_version, policy_version)
  where status = 'RUNNING';
create index chapter_design_runs_project_status_idx
  on public.chapter_design_runs (project_id, status, created_at);

create table public.card_blueprint_slots (
  project_id text not null,
  chapter_id smallint not null check (chapter_id between 0 and 15),
  design_run_id uuid not null references public.chapter_design_runs(design_run_id) on delete cascade,
  slot_id text not null check (slot_id ~ '^0x[0-9a-f]{64}$'),
  concept_id text not null check (concept_id ~ '^0x[0-9a-f]{64}$'),
  card_type text not null check (card_type in ('concept', 'comparison', 'process', 'application', 'misconception')),
  objective text not null check (char_length(objective) between 1 and 500),
  difficulty smallint not null check (difficulty between 1 and 5),
  source_block_indexes jsonb not null check (
    jsonb_typeof(source_block_indexes) = 'array' and jsonb_array_length(source_block_indexes) between 1 and 64
  ),
  required boolean not null,
  assigned_work_unit_id smallint check (assigned_work_unit_id between 0 and 47),
  status text not null default 'PLANNED' check (
    status in ('PLANNED', 'ASSIGNED', 'CANDIDATE_READY', 'REPAIR_REQUESTED', 'ACCEPTED', 'REJECTED')
  ),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (project_id, chapter_id, design_run_id, slot_id),
  foreign key (project_id, chapter_id) references public.chapters(project_id, chapter_id) on delete cascade
);
create index card_blueprint_slots_design_assignment_idx
  on public.card_blueprint_slots (design_run_id, assigned_work_unit_id, status);

create table public.card_slot_candidates (
  project_id text not null,
  chapter_id smallint not null check (chapter_id between 0 and 15),
  work_unit_id smallint not null check (work_unit_id between 0 and 47),
  design_run_id uuid not null,
  slot_id text not null check (slot_id ~ '^0x[0-9a-f]{64}$'),
  candidate_revision smallint not null check (candidate_revision between 1 and 10),
  card_id text not null check (card_id ~ '^0x[0-9a-f]{64}$'),
  card_hash text not null check (card_hash ~ '^0x[0-9a-f]{64}$'),
  card jsonb not null check (jsonb_typeof(card) = 'object'),
  status text not null default 'CANDIDATE_READY' check (
    status in ('CANDIDATE_READY', 'ACCEPTED', 'REJECTED')
  ),
  created_at timestamptz not null default now(),
  primary key (project_id, chapter_id, design_run_id, slot_id, candidate_revision),
  unique (project_id, design_run_id, candidate_revision, card_id),
  foreign key (project_id, work_unit_id)
    references public.work_units(project_id, work_unit_id) on delete cascade,
  foreign key (project_id, chapter_id, design_run_id, slot_id)
    references public.card_blueprint_slots(project_id, chapter_id, design_run_id, slot_id) on delete cascade
);
create index card_slot_candidates_work_unit_revision_idx
  on public.card_slot_candidates (project_id, work_unit_id, candidate_revision desc, status);
create unique index card_slot_candidates_one_accepted_per_slot_idx
  on public.card_slot_candidates (project_id, chapter_id, design_run_id, slot_id)
  where status = 'ACCEPTED';

create function public.reject_card_slot_candidate_content_mutation_v3()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  if new.project_id is distinct from old.project_id
    or new.chapter_id is distinct from old.chapter_id
    or new.work_unit_id is distinct from old.work_unit_id
    or new.design_run_id is distinct from old.design_run_id
    or new.slot_id is distinct from old.slot_id
    or new.candidate_revision is distinct from old.candidate_revision
    or new.card_id is distinct from old.card_id
    or new.card_hash is distinct from old.card_hash
    or new.card is distinct from old.card
    or new.created_at is distinct from old.created_at then
    raise exception 'Card Slot candidate revisions are immutable';
  end if;
  return new;
end;
$$;

create trigger card_slot_candidates_reject_content_mutation
before update on public.card_slot_candidates
for each row execute function public.reject_card_slot_candidate_content_mutation_v3();

create table public.card_quality_evaluations (
  evaluation_id uuid primary key default gen_random_uuid(),
  project_id text not null references public.learning_projects(project_id) on delete cascade,
  chapter_id smallint not null check (chapter_id between 0 and 15),
  design_run_id uuid not null references public.chapter_design_runs(design_run_id) on delete cascade,
  candidate_revision smallint not null check (candidate_revision between 0 and 10),
  slot_id text check (slot_id is null or slot_id ~ '^0x[0-9a-f]{64}$'),
  card_id text check (card_id is null or card_id ~ '^0x[0-9a-f]{64}$'),
  verdict text not null check (verdict in ('APPROVED', 'REPAIR_REQUESTED', 'FAILED')),
  hard_failures jsonb not null default '[]'::jsonb check (jsonb_typeof(hard_failures) = 'array'),
  rubric_scores jsonb not null default '{}'::jsonb check (jsonb_typeof(rubric_scores) = 'object'),
  coverage_result jsonb not null default '{}'::jsonb check (jsonb_typeof(coverage_result) = 'object'),
  repair_reason text check (repair_reason is null or char_length(repair_reason) <= 500),
  evaluator_model text not null check (char_length(evaluator_model) between 1 and 200),
  prompt_version text not null check (char_length(prompt_version) between 1 and 100),
  created_at timestamptz not null default now(),
  foreign key (project_id, chapter_id) references public.chapters(project_id, chapter_id) on delete cascade
);
create index card_quality_evaluations_chapter_idx
  on public.card_quality_evaluations (project_id, chapter_id, design_run_id, candidate_revision, created_at desc);

create table public.knowledge_card_feedback (
  feedback_id uuid primary key default gen_random_uuid(),
  owner_address text not null check (owner_address ~ '^0x[0-9a-f]{40}$'),
  project_id text not null references public.learning_projects(project_id) on delete cascade,
  chapter_id smallint not null check (chapter_id between 0 and 15),
  card_id text not null check (card_id ~ '^0x[0-9a-f]{64}$'),
  rating text not null check (rating in ('UP', 'DOWN', 'INCORRECT', 'UNCLEAR')),
  reason text check (reason is null or char_length(reason) <= 500),
  corrected_content jsonb check (corrected_content is null or jsonb_typeof(corrected_content) = 'object'),
  created_at timestamptz not null default now(),
  foreign key (card_id, project_id, chapter_id)
    references public.knowledge_cards(card_id, project_id, chapter_id) on delete cascade
);
create index knowledge_card_feedback_owner_card_idx
  on public.knowledge_card_feedback (owner_address, card_id, created_at desc);

create function public.reject_completed_chapter_design_mutation_v3()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  if old.status = 'COMPLETED' and (
    new.status is distinct from old.status
    or new.inventory is distinct from old.inventory
    or new.blueprint is distinct from old.blueprint
    or new.inventory_hash is distinct from old.inventory_hash
    or new.blueprint_hash is distinct from old.blueprint_hash
    or new.policy_version is distinct from old.policy_version
    or new.prompt_version is distinct from old.prompt_version
    or new.model_id is distinct from old.model_id
    or new.metrics is distinct from old.metrics
    or new.last_error is distinct from old.last_error
  ) then
    raise exception 'completed Chapter Design Runs are immutable';
  end if;
  return new;
end;
$$;

create trigger chapter_design_runs_reject_completed_mutation
before update on public.chapter_design_runs
for each row execute function public.reject_completed_chapter_design_mutation_v3();

create function public.validate_chapter_design_snapshot_v3(
  p_design_run_id uuid,
  p_inventory jsonb,
  p_blueprint jsonb
)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare
  v_run public.chapter_design_runs%rowtype;
begin
  select * into v_run from public.chapter_design_runs
  where design_run_id = p_design_run_id for update;
  if not found then raise exception 'Chapter Design Run was not found'; end if;
  if jsonb_typeof(p_inventory) <> 'object' or jsonb_typeof(p_blueprint) <> 'object'
    or jsonb_typeof(p_inventory->'concepts') <> 'array'
    or jsonb_typeof(p_blueprint->'slots') <> 'array'
    or jsonb_array_length(p_inventory->'concepts') not between 1 and 40
    or jsonb_array_length(p_blueprint->'slots') not between 1 and 30 then
    raise exception 'Chapter Design snapshot has invalid inventory or Blueprint shape';
  end if;
  if p_inventory->>'projectId' <> v_run.project_id
    or (p_inventory->>'chapterId')::integer <> v_run.chapter_id
    or (p_inventory->>'outlineVersion')::integer <> v_run.outline_version
    or lower(p_inventory->>'sourceHash') <> v_run.source_hash
    or (p_inventory->>'policyVersion')::integer <> v_run.policy_version
    or p_blueprint->>'projectId' <> v_run.project_id
    or (p_blueprint->>'chapterId')::integer <> v_run.chapter_id
    or (p_blueprint->>'outlineVersion')::integer <> v_run.outline_version
    or (p_blueprint->>'policyVersion')::integer <> v_run.policy_version then
    raise exception 'Chapter Design snapshot does not match its Design Run';
  end if;
  if exists (
    select 1
    from jsonb_array_elements(p_inventory->'concepts') as concept(value)
    cross join lateral jsonb_array_elements_text(concept.value->'sourceBlockIndexes') as source_index(value)
    left join public.source_blocks as blocks
      on blocks.project_id = v_run.project_id and blocks.block_index = source_index.value::integer
    join public.chapters as chapters
      on chapters.project_id = v_run.project_id and chapters.chapter_id = v_run.chapter_id
    where blocks.block_index is null
      or source_index.value::integer < chapters.start_block
      or source_index.value::integer > chapters.end_block
  ) then raise exception 'Concept Inventory cites Source Blocks outside its Chapter'; end if;
  if exists (
    select 1
    from jsonb_array_elements(p_blueprint->'slots') as slot(value)
    where not exists (
      select 1 from jsonb_array_elements(p_inventory->'concepts') as concept(value)
      where concept.value->>'conceptId' = slot.value->>'conceptId'
    )
  ) then raise exception 'Card Blueprint Slot references a Concept outside its Inventory'; end if;
  if exists (
    select 1
    from jsonb_array_elements(p_blueprint->'slots') as slot(value)
    cross join lateral jsonb_array_elements_text(slot.value->'sourceBlockIndexes') as source_index(value)
    join public.chapters as chapters
      on chapters.project_id = v_run.project_id and chapters.chapter_id = v_run.chapter_id
    where source_index.value::integer < chapters.start_block
      or source_index.value::integer > chapters.end_block
  ) then raise exception 'Card Blueprint Slot cites Source Blocks outside its Chapter'; end if;
  if exists (
    select 1
    from jsonb_array_elements(p_inventory->'concepts') as concept(value)
    where (concept.value->>'importance')::integer >= 4
      and not exists (
        select 1 from jsonb_array_elements(p_blueprint->'slots') as slot(value)
        where slot.value->>'conceptId' = concept.value->>'conceptId'
          and coalesce((slot.value->>'required')::boolean, false)
      )
  ) then raise exception 'important Concept has no required Card Blueprint Slot'; end if;
  if exists (
    select 1
    from jsonb_array_elements(p_inventory->'concepts') as concept(value)
    where (concept.value->>'importance')::integer >= 4
      and coalesce(jsonb_array_length(concept.value->'misconceptions'), 0) > 0
      and not exists (
        select 1 from jsonb_array_elements(p_blueprint->'slots') as slot(value)
        where slot.value->>'conceptId' = concept.value->>'conceptId'
          and slot.value->>'type' = 'misconception'
          and coalesce((slot.value->>'required')::boolean, false)
      )
  ) then raise exception 'important Concept with misconceptions needs a required misconception Slot'; end if;
  return true;
end;
$$;

create function public.start_chapter_design_v3(
  p_project_id text,
  p_chapter_id integer,
  p_outline_version integer,
  p_policy_version integer default 3
)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_project_id text := lower(p_project_id);
  v_run_id uuid;
  v_attempt smallint;
begin
  if p_policy_version <> 3 then raise exception 'unsupported Generation Policy version'; end if;
  select design_run_id into v_run_id
  from public.chapter_design_runs
  where project_id = v_project_id and chapter_id = p_chapter_id::smallint
    and outline_version = p_outline_version and policy_version = p_policy_version
    and status in ('RUNNING', 'COMPLETED')
  order by created_at desc limit 1;
  if found then return v_run_id; end if;
  perform 1 from public.learning_projects as projects
  join public.chapters as chapters on chapters.project_id = projects.project_id
  where projects.project_id = v_project_id and projects.status = 'DESIGNING_CARDS'
    and projects.outline_version = p_outline_version and projects.generation_policy_version = 3
    and chapters.chapter_id = p_chapter_id::smallint and chapters.status = 'CONFIRMED'
  for update of projects, chapters;
  if not found then raise exception 'designable Chapter was not found'; end if;
  select coalesce(max(attempt), 0)::smallint + 1 into v_attempt
  from public.chapter_design_runs
  where project_id = v_project_id and chapter_id = p_chapter_id::smallint
    and outline_version = p_outline_version and policy_version = p_policy_version;
  insert into public.chapter_design_runs (
    project_id, chapter_id, outline_version, source_hash, policy_version, status, attempt
  ) select projects.project_id, chapters.chapter_id, projects.outline_version,
      chapters.source_hash, p_policy_version::smallint, 'RUNNING', v_attempt
    from public.learning_projects as projects
    join public.chapters as chapters on chapters.project_id = projects.project_id
    where projects.project_id = v_project_id and chapters.chapter_id = p_chapter_id::smallint
  returning design_run_id into v_run_id;
  return v_run_id;
end;
$$;

create function public.complete_chapter_design_v3(
  p_design_run_id uuid,
  p_inventory jsonb,
  p_blueprint jsonb,
  p_inventory_hash text,
  p_blueprint_hash text,
  p_prompt_version text,
  p_model_id text,
  p_metrics jsonb default '{}'::jsonb
)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare v_run public.chapter_design_runs%rowtype;
begin
  if jsonb_typeof(p_metrics) <> 'object' then raise exception 'design metrics must be an object'; end if;
  perform public.validate_chapter_design_snapshot_v3(p_design_run_id, p_inventory, p_blueprint);
  select * into v_run from public.chapter_design_runs
  where design_run_id = p_design_run_id and status = 'RUNNING' for update;
  if not found then raise exception 'running Chapter Design Run was not found'; end if;
  update public.chapter_design_runs
  set status = 'COMPLETED', inventory = p_inventory, blueprint = p_blueprint,
      inventory_hash = lower(p_inventory_hash), blueprint_hash = lower(p_blueprint_hash),
      prompt_version = p_prompt_version, model_id = p_model_id, metrics = p_metrics,
      last_error = null, completed_at = now()
  where design_run_id = p_design_run_id;
  insert into public.card_blueprint_slots (
    project_id, chapter_id, design_run_id, slot_id, concept_id, card_type,
    objective, difficulty, source_block_indexes, required
  )
  select v_run.project_id, v_run.chapter_id, v_run.design_run_id,
    slot.value->>'slotId', slot.value->>'conceptId', slot.value->>'type',
    slot.value->>'objective', (slot.value->>'difficulty')::smallint,
    slot.value->'sourceBlockIndexes', (slot.value->>'required')::boolean
  from jsonb_array_elements(p_blueprint->'slots') as slot(value);
  insert into public.project_agent_events (project_id, chapter_id, agent_role, event_type, payload)
  values (v_run.project_id, v_run.chapter_id, 'chapter-design', 'CHAPTER_DESIGN_COMPLETED',
    jsonb_build_object('designRunId', v_run.design_run_id, 'policyVersion', v_run.policy_version));
  return true;
end;
$$;

create function public.fail_chapter_design_v3(p_design_run_id uuid, p_error text, p_exhausted boolean default false)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare v_run public.chapter_design_runs%rowtype;
begin
  update public.chapter_design_runs
  set status = case when p_exhausted then 'REPAIR_EXHAUSTED' else 'FAILED' end,
      last_error = left(p_error, 500), completed_at = null
  where design_run_id = p_design_run_id and status = 'RUNNING'
  returning * into v_run;
  if not found then return false; end if;
  insert into public.project_agent_events (project_id, chapter_id, agent_role, event_type, payload)
  values (v_run.project_id, v_run.chapter_id, 'chapter-design', 'CHAPTER_DESIGN_FAILED',
    jsonb_build_object('designRunId', v_run.design_run_id, 'exhausted', p_exhausted));
  return true;
end;
$$;

create function public.queue_project_design_freeze_v3()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare v_job_id uuid;
begin
  if new.status <> 'COMPLETED' or old.status = 'COMPLETED' then return new; end if;
  if exists (
    select 1 from public.chapters as chapters
    where chapters.project_id = new.project_id
      and not exists (
        select 1 from public.chapter_design_runs as runs
        where runs.project_id = chapters.project_id and runs.chapter_id = chapters.chapter_id
          and runs.outline_version = new.outline_version and runs.policy_version = new.policy_version
          and runs.status = 'COMPLETED'
      )
  ) then return new; end if;
  select job_id into v_job_id from public.workflow_jobs
  where project_id = new.project_id and kind = 'FREEZE_PROJECT_DESIGN'
    and chapter_id is null and work_unit_id is null
    and status in ('QUEUED', 'RUNNING', 'RETRYABLE')
  order by created_at desc limit 1;
  if found then return new; end if;
  insert into public.workflow_jobs (project_id, kind, input)
  values (new.project_id, 'FREEZE_PROJECT_DESIGN',
    jsonb_build_object('outlineVersion', new.outline_version, 'policyVersion', new.policy_version));
  return new;
end;
$$;

create trigger chapter_design_runs_queue_freeze
after update of status on public.chapter_design_runs
for each row execute function public.queue_project_design_freeze_v3();

create function public.reflect_project_design_job_failure_v3()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if new.status = 'FAILED' and old.status is distinct from new.status
    and new.kind in ('DESIGN_CHAPTER', 'FREEZE_PROJECT_DESIGN') then
    update public.learning_projects
    set status = 'FAILED_RETRYABLE', last_error = new.last_error
    where project_id = new.project_id and status = 'DESIGNING_CARDS';
  end if;
  return new;
end;
$$;

create trigger workflow_jobs_reflect_project_design_failure
after update of status on public.workflow_jobs
for each row execute function public.reflect_project_design_job_failure_v3();

create function public.confirm_project_outline_design_v3(
  p_project_id text,
  p_owner text,
  p_outline_version integer,
  p_outline_hash text,
  p_chapters jsonb
)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare
  v_project_id text := lower(p_project_id);
  v_chapter_count integer;
  v_block_count integer;
begin
  perform 1 from public.project_outline_versions as versions
  join public.learning_projects as projects on projects.project_id = versions.project_id
  where versions.project_id = v_project_id and versions.version = p_outline_version
    and versions.status = 'DRAFT' and versions.outline_hash = lower(p_outline_hash)
    and projects.owner_address = lower(p_owner) and projects.status = 'OUTLINE_READY'
  for update of versions, projects;
  if not found then raise exception 'current editable Outline Draft was not found'; end if;
  if exists (select 1 from public.chapters where project_id = v_project_id)
    or exists (select 1 from public.work_units where project_id = v_project_id) then
    raise exception 'Project has already materialized Chapters or Work Units';
  end if;
  if jsonb_typeof(p_chapters) <> 'array'
    or jsonb_array_length(p_chapters) not between 1 and 16 then
    raise exception 'chapters must contain between 1 and 16 entries';
  end if;
  v_chapter_count := jsonb_array_length(p_chapters);
  select count(*)::integer into v_block_count
  from public.source_blocks where project_id = v_project_id;
  if (
    select count(distinct item.chapter_id)
    from jsonb_to_recordset(p_chapters) as item(chapter_id integer)
  ) <> v_chapter_count or exists (
    select 1 from jsonb_to_recordset(p_chapters) as item(chapter_id integer, position integer)
    where item.chapter_id < 0 or item.chapter_id >= v_chapter_count
      or item.position <> item.chapter_id
  ) then raise exception 'chapter_id and position values must be unique and contiguous'; end if;
  if exists (
    with ordered as (
      select item.chapter_id, item.start_block, item.end_block,
        lag(item.end_block) over (order by item.chapter_id) as previous_end
      from jsonb_to_recordset(p_chapters) as item(
        chapter_id integer, start_block integer, end_block integer
      )
    )
    select 1 from ordered
    where end_block < start_block
      or (chapter_id = 0 and start_block <> 0)
      or (chapter_id > 0 and start_block <> previous_end + 1)
      or (chapter_id = v_chapter_count - 1 and end_block <> v_block_count - 1)
  ) then raise exception 'Chapter ranges must cover every Source Block exactly once'; end if;
  insert into public.chapters (
    project_id, chapter_id, position, title, summary, start_block, end_block,
    page_start, page_end, source_hash, importance, status,
    min_card_count, target_card_count, max_card_count, card_policy_version
  )
  select v_project_id, item.chapter_id, item.position, item.title, item.summary,
    item.start_block, item.end_block, item.page_start, item.page_end,
    lower(item.source_hash), item.importance, 'CONFIRMED',
    item.min_card_count, item.target_card_count, item.max_card_count, 3
  from jsonb_to_recordset(p_chapters) as item(
    chapter_id smallint, position smallint, title text, summary text,
    start_block integer, end_block integer, page_start smallint, page_end smallint,
    source_hash text, importance smallint, min_card_count smallint,
    target_card_count smallint, max_card_count smallint
  );
  if not found then raise exception 'Outline Draft has no Chapters'; end if;
  update public.project_outline_versions set status = 'CONFIRMED', confirmed_at = now()
  where project_id = v_project_id and version = p_outline_version;
  update public.learning_projects
  set outline_hash = lower(p_outline_hash), work_unit_manifest_root = null,
      generation_policy_version = 3, frozen_design_hash = null, frozen_at = null,
      status = 'DESIGNING_CARDS', last_error = null
  where project_id = v_project_id;
  insert into public.workflow_jobs (project_id, kind, chapter_id, input)
  select v_project_id, 'DESIGN_CHAPTER', chapter_id,
    jsonb_build_object('outlineVersion', p_outline_version, 'policyVersion', 3)
  from public.chapters where project_id = v_project_id;
  return true;
end;
$$;

create function public.freeze_project_design_v3(
  p_project_id text,
  p_outline_version integer,
  p_work_unit_manifest_root text,
  p_work_units jsonb,
  p_slot_assignments jsonb,
  p_frozen_design_hash text,
  p_creation_intent jsonb
)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare
  v_project_id text := lower(p_project_id);
  v_work_unit_count integer;
begin
  if jsonb_typeof(p_work_units) <> 'array' or jsonb_array_length(p_work_units) not between 1 and 48
    or jsonb_typeof(p_slot_assignments) <> 'array'
    or jsonb_typeof(p_creation_intent) <> 'object' then
    raise exception 'invalid V3 Work Unit manifest input';
  end if;
  v_work_unit_count := jsonb_array_length(p_work_units);
  perform 1 from public.learning_projects
  where project_id = v_project_id and status = 'DESIGNING_CARDS'
    and outline_version = p_outline_version and generation_policy_version = 3
  for update;
  if not found then raise exception 'freezable Project design was not found'; end if;
  if exists (
    select 1 from public.chapters as chapters
    where chapters.project_id = v_project_id
      and not exists (
        select 1 from public.chapter_design_runs as runs
        where runs.project_id = chapters.project_id and runs.chapter_id = chapters.chapter_id
          and runs.outline_version = p_outline_version and runs.policy_version = 3
          and runs.status = 'COMPLETED'
      )
  ) then raise exception 'every Chapter needs a completed V3 Design Run before freeze'; end if;
  if exists (select 1 from public.work_units where project_id = v_project_id) then
    raise exception 'Project already has a frozen Work Unit manifest';
  end if;
  if (
    select count(distinct item.work_unit_id)
    from jsonb_to_recordset(p_work_units) as item(work_unit_id integer)
  ) <> v_work_unit_count or exists (
    select 1 from jsonb_to_recordset(p_work_units) as item(work_unit_id integer)
    where item.work_unit_id < 0 or item.work_unit_id >= v_work_unit_count
  ) then raise exception 'Work Unit IDs must be unique and contiguous'; end if;
  if exists (
    select 1
    from jsonb_to_recordset(p_work_units) as unit(
      chapter_id integer, unit_index integer, start_block integer, end_block integer
    )
    join public.chapters as chapter
      on chapter.project_id = v_project_id and chapter.chapter_id = unit.chapter_id::smallint
    where unit.start_block < chapter.start_block or unit.end_block > chapter.end_block
      or unit.end_block < unit.start_block or unit.unit_index not between 0 and 7
  ) then raise exception 'V3 Work Unit cannot cross its Chapter range'; end if;
  insert into public.work_units (
    project_id, work_unit_id, chapter_id, unit_index, start_block, end_block,
    source_text, source_blocks, source_unit_hash, manifest_proof,
    card_minimum, card_target, card_budget, status
  )
  select v_project_id, item.work_unit_id, item.chapter_id, item.unit_index,
    item.start_block, item.end_block, item.source_text, item.source_blocks,
    lower(item.source_unit_hash), item.manifest_proof, item.card_minimum,
    item.card_target, item.card_budget, 'QUEUED'
  from jsonb_to_recordset(p_work_units) as item(
    work_unit_id smallint, chapter_id smallint, unit_index smallint,
    start_block integer, end_block integer, source_text text, source_blocks jsonb,
    source_unit_hash text, manifest_proof jsonb, card_minimum smallint,
    card_target smallint, card_budget smallint
  );
  if exists (
    select 1 from public.card_blueprint_slots as slots
    where slots.project_id = v_project_id
      and not exists (
        select 1 from jsonb_to_recordset(p_slot_assignments) as assignment(slot_id text, work_unit_id integer)
        where assignment.slot_id = slots.slot_id
      )
  ) then raise exception 'every Card Blueprint Slot needs a Work Unit assignment'; end if;
  if exists (
    select 1
    from jsonb_to_recordset(p_slot_assignments) as assignment(slot_id text, work_unit_id integer)
    join public.card_blueprint_slots as slots
      on slots.project_id = v_project_id and slots.slot_id = lower(assignment.slot_id)
    join public.work_units as units
      on units.project_id = v_project_id and units.work_unit_id = assignment.work_unit_id::smallint
    where slots.chapter_id <> units.chapter_id
      or exists (
        select 1 from jsonb_array_elements_text(slots.source_block_indexes) as source_index(value)
        where source_index.value::integer < units.start_block or source_index.value::integer > units.end_block
      )
  ) then raise exception 'Card Blueprint Slot assignment does not contain its evidence'; end if;
  update public.card_blueprint_slots as slots
  set assigned_work_unit_id = assignment.work_unit_id::smallint, status = 'ASSIGNED', updated_at = now()
  from jsonb_to_recordset(p_slot_assignments) as assignment(slot_id text, work_unit_id integer)
  where slots.project_id = v_project_id and slots.slot_id = lower(assignment.slot_id);
  update public.learning_projects
  set work_unit_manifest_root = lower(p_work_unit_manifest_root),
      frozen_design_hash = lower(p_frozen_design_hash), frozen_at = now(),
      creation_intent = p_creation_intent, status = 'AWAITING_REGISTRY', last_error = null
  where project_id = v_project_id;
  return true;
end;
$$;

create function public.save_work_unit_candidates_v3(
  p_project_id text,
  p_work_unit_id integer,
  p_cards_root text,
  p_generation_ms integer,
  p_candidates jsonb
)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare
  v_project_id text := lower(p_project_id);
  v_unit public.work_units%rowtype;
  v_design_run_id uuid;
  v_expected_count integer;
  v_revision integer;
begin
  if (lower(p_cards_root) ~ '^0x[0-9a-f]{64}$') is not true
    or p_generation_ms is null or p_generation_ms < 0
    or jsonb_typeof(p_candidates) <> 'array'
    or jsonb_array_length(p_candidates) not between 1 and 30 then
    raise exception 'invalid V3 Work Unit candidate input';
  end if;

  select units.* into v_unit
  from public.work_units as units
  join public.learning_projects as projects on projects.project_id = units.project_id
  where units.project_id = v_project_id
    and units.work_unit_id = p_work_unit_id::smallint
    and units.status = 'VALIDATING'
    and projects.status = 'GENERATING'
    and projects.generation_policy_version = 3
  for update of units;
  if not found then raise exception 'validating V3 Work Unit was not found'; end if;

  select count(*)::integer, (array_agg(distinct slots.design_run_id))[1]
  into v_expected_count, v_design_run_id
  from public.card_blueprint_slots as slots
  join public.chapter_design_runs as runs on runs.design_run_id = slots.design_run_id
  where slots.project_id = v_project_id
    and slots.chapter_id = v_unit.chapter_id
    and slots.assigned_work_unit_id = v_unit.work_unit_id
    and slots.status in ('ASSIGNED', 'REPAIR_REQUESTED')
    and runs.status = 'COMPLETED';
  if v_expected_count < 1 or (
    select count(distinct slots.design_run_id)
    from public.card_blueprint_slots as slots
    where slots.project_id = v_project_id
      and slots.chapter_id = v_unit.chapter_id
      and slots.assigned_work_unit_id = v_unit.work_unit_id
      and slots.status in ('ASSIGNED', 'REPAIR_REQUESTED')
  ) <> 1 then
    raise exception 'V3 Work Unit does not have one completed assigned Blueprint';
  end if;

  if jsonb_array_length(p_candidates) <> v_expected_count or (
    select count(distinct lower(item.slot_id))
    from jsonb_to_recordset(p_candidates) as item(slot_id text)
  ) <> v_expected_count or exists (
    select 1
    from jsonb_to_recordset(p_candidates) as item(slot_id text, card jsonb)
    left join public.card_blueprint_slots as slots
      on slots.project_id = v_project_id
      and slots.chapter_id = v_unit.chapter_id
      and slots.design_run_id = v_design_run_id
      and slots.slot_id = lower(item.slot_id)
      and slots.assigned_work_unit_id = v_unit.work_unit_id
    where slots.slot_id is null
      or slots.status not in ('ASSIGNED', 'REPAIR_REQUESTED')
      or jsonb_typeof(item.card) <> 'object'
      or lower(item.card->>'projectId') is distinct from v_project_id
      or item.card->'chapterId' is distinct from to_jsonb(v_unit.chapter_id::integer)
      or item.card->'workUnitId' is distinct from to_jsonb(v_unit.work_unit_id::integer)
      or (lower(item.card->>'id') ~ '^0x[0-9a-f]{64}$') is not true
      or (lower(item.card->>'cardHash') ~ '^0x[0-9a-f]{64}$') is not true
      or jsonb_typeof(item.card->'workerProof') <> 'array'
  ) or (
    select count(distinct lower(item.card->>'id'))
    from jsonb_to_recordset(p_candidates) as item(card jsonb)
  ) <> v_expected_count then
    raise exception 'V3 candidates must cover every assigned Blueprint Slot exactly once';
  end if;

  select coalesce(max(candidates.candidate_revision), 0) + 1 into v_revision
  from public.card_slot_candidates as candidates
  where candidates.project_id = v_project_id and candidates.work_unit_id = v_unit.work_unit_id;
  if v_revision > 10 then raise exception 'V3 candidate repair limit is exhausted'; end if;

  insert into public.card_slot_candidates (
    project_id, chapter_id, work_unit_id, design_run_id, slot_id,
    candidate_revision, card_id, card_hash, card, status
  )
  select v_project_id, v_unit.chapter_id, v_unit.work_unit_id, v_design_run_id,
    lower(item.slot_id), v_revision::smallint, lower(item.card->>'id'),
    lower(item.card->>'cardHash'), item.card, 'CANDIDATE_READY'
  from jsonb_to_recordset(p_candidates) as item(slot_id text, card jsonb);

  update public.card_blueprint_slots as slots
  set status = 'CANDIDATE_READY', updated_at = now()
  from jsonb_to_recordset(p_candidates) as item(slot_id text)
  where slots.project_id = v_project_id
    and slots.chapter_id = v_unit.chapter_id
    and slots.design_run_id = v_design_run_id
    and slots.slot_id = lower(item.slot_id);

  update public.work_units
  set worker_cards = (
        select jsonb_agg(candidate.value->'card' order by candidate.ordinality)
        from jsonb_array_elements(p_candidates) with ordinality as candidate(value, ordinality)
      ),
      cards_root = lower(p_cards_root), card_count = v_expected_count::smallint,
      generation_ms = p_generation_ms, status = 'CANDIDATE_READY',
      lease_until = null, last_error = null
  where project_id = v_project_id and work_unit_id = v_unit.work_unit_id;
  return true;
end;
$$;

create function public.record_chapter_quality_evaluations_v3(
  p_project_id text,
  p_chapter_id integer,
  p_design_run_id uuid,
  p_evaluations jsonb,
  p_coverage_result jsonb,
  p_duplicate_pairs jsonb,
  p_evaluator_model text,
  p_prompt_version text
)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  if jsonb_typeof(p_evaluations) <> 'array'
    or jsonb_typeof(p_coverage_result) <> 'object'
    or jsonb_typeof(p_duplicate_pairs) <> 'array'
    or char_length(p_evaluator_model) not between 1 and 200
    or char_length(p_prompt_version) not between 1 and 100 then
    raise exception 'invalid V3 Chapter quality evaluation';
  end if;
  if jsonb_array_length(p_evaluations) = 0 then
    insert into public.card_quality_evaluations (
      project_id, chapter_id, design_run_id, candidate_revision, verdict,
      hard_failures, rubric_scores, coverage_result, repair_reason,
      evaluator_model, prompt_version
    ) values (
      lower(p_project_id), p_chapter_id::smallint, p_design_run_id, 0, 'REPAIR_REQUESTED',
      '["MISSING_REQUIRED_CANDIDATES"]'::jsonb,
      jsonb_build_object('duplicatePairs', p_duplicate_pairs), p_coverage_result,
      'Required Blueprint Slots have no candidates', p_evaluator_model, p_prompt_version
    );
    return;
  end if;
  insert into public.card_quality_evaluations (
    project_id, chapter_id, design_run_id, candidate_revision, slot_id, card_id,
    verdict, hard_failures, rubric_scores, coverage_result, repair_reason,
    evaluator_model, prompt_version
  )
  select lower(p_project_id), p_chapter_id::smallint, p_design_run_id,
    item.candidate_revision::smallint, lower(item.slot_id), lower(item.card_id),
    item.verdict, item.hard_failures,
    coalesce(item.rubric_scores, '{}'::jsonb) || jsonb_build_object('duplicatePairs', p_duplicate_pairs),
    p_coverage_result,
    case when item.verdict = 'REPAIR_REQUESTED'
      then left(coalesce(
        item.rubric_scores->'reasons'->>0,
        item.hard_failures->>0,
        'Blueprint quality repair requested'
      ), 500)
      else null end,
    p_evaluator_model, p_prompt_version
  from jsonb_to_recordset(p_evaluations) as item(
    slot_id text, card_id text, candidate_revision integer, verdict text,
    hard_failures jsonb, rubric_scores jsonb
  );
end;
$$;

create function public.approve_chapter_candidates_v3(
  p_project_id text,
  p_chapter_id integer,
  p_design_run_id uuid,
  p_evaluations jsonb,
  p_work_units jsonb,
  p_coverage_result jsonb,
  p_duplicate_pairs jsonb,
  p_evaluator_model text,
  p_prompt_version text
)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare
  v_project_id text := lower(p_project_id);
  v_expected_work_units integer;
  v_required_slots integer;
begin
  if jsonb_typeof(p_evaluations) <> 'array' or jsonb_array_length(p_evaluations) < 1
    or jsonb_typeof(p_work_units) <> 'array' or jsonb_array_length(p_work_units) < 1 then
    raise exception 'approved V3 candidates and Work Units must be non-empty arrays';
  end if;
  perform 1 from public.chapters as chapters
  join public.learning_projects as projects on projects.project_id = chapters.project_id
  join public.chapter_design_runs as runs
    on runs.project_id = chapters.project_id and runs.chapter_id = chapters.chapter_id
  where chapters.project_id = v_project_id and chapters.chapter_id = p_chapter_id::smallint
    and chapters.status = 'QUALITY_CHECK' and projects.status = 'GENERATING'
    and projects.generation_policy_version = 3
    and runs.design_run_id = p_design_run_id and runs.status = 'COMPLETED'
  for update of chapters;
  if not found then raise exception 'claimed V3 Chapter quality check was not found'; end if;

  select count(*)::integer into v_expected_work_units from public.work_units
  where project_id = v_project_id and chapter_id = p_chapter_id::smallint;
  select count(*)::integer into v_required_slots from public.card_blueprint_slots
  where project_id = v_project_id and chapter_id = p_chapter_id::smallint
    and design_run_id = p_design_run_id and required;
  if jsonb_array_length(p_work_units) <> v_expected_work_units
    or (select count(distinct item.work_unit_id)
        from jsonb_to_recordset(p_work_units) as item(work_unit_id integer)) <> v_expected_work_units
    or exists (
      select 1 from jsonb_to_recordset(p_work_units) as item(
        work_unit_id integer, worker_cards jsonb, cards_root text, card_count integer
      )
      left join public.work_units as units
        on units.project_id = v_project_id and units.work_unit_id = item.work_unit_id::smallint
      where units.work_unit_id is null or units.chapter_id <> p_chapter_id::smallint
        or units.status <> 'CANDIDATE_READY' or item.card_count < 1
        or jsonb_typeof(item.worker_cards) <> 'array'
        or jsonb_array_length(item.worker_cards) <> item.card_count
        or (lower(item.cards_root) ~ '^0x[0-9a-f]{64}$') is not true
    ) then raise exception 'V3 Chapter candidate approval has invalid Work Units'; end if;

  if exists (
    select 1 from jsonb_to_recordset(p_evaluations) as evaluation(
      slot_id text, card_id text, candidate_revision integer, verdict text,
      hard_failures jsonb, rubric_scores jsonb
    )
    left join public.card_slot_candidates as candidates
      on candidates.project_id = v_project_id
      and candidates.chapter_id = p_chapter_id::smallint
      and candidates.design_run_id = p_design_run_id
      and candidates.slot_id = lower(evaluation.slot_id)
      and candidates.card_id = lower(evaluation.card_id)
      and candidates.candidate_revision = evaluation.candidate_revision::smallint
    where evaluation.verdict <> 'APPROVED' or candidates.card_id is null
      or candidates.status not in ('CANDIDATE_READY', 'ACCEPTED')
      or jsonb_typeof(evaluation.hard_failures) <> 'array'
      or jsonb_typeof(evaluation.rubric_scores) <> 'object'
      or jsonb_array_length(evaluation.hard_failures) <> 0
  ) or exists (
    select 1 from public.card_blueprint_slots as slots
    where slots.project_id = v_project_id and slots.chapter_id = p_chapter_id::smallint
      and slots.design_run_id = p_design_run_id and slots.required
      and not exists (
        select 1 from jsonb_to_recordset(p_evaluations) as evaluation(slot_id text, verdict text)
        where lower(evaluation.slot_id) = slots.slot_id and evaluation.verdict = 'APPROVED'
      )
  ) or (
    select coalesce(sum(item.card_count), 0)
    from jsonb_to_recordset(p_work_units) as item(card_count integer)
  ) <> jsonb_array_length(p_evaluations) or exists (
    select 1
    from jsonb_to_recordset(p_work_units) as item(work_unit_id integer, worker_cards jsonb)
    cross join lateral jsonb_array_elements(item.worker_cards) as card(value)
    where not exists (
      select 1
      from jsonb_to_recordset(p_evaluations) as evaluation(
        slot_id text, card_id text, candidate_revision integer, verdict text
      )
      join public.card_slot_candidates as candidates
        on candidates.project_id = v_project_id
        and candidates.chapter_id = p_chapter_id::smallint
        and candidates.design_run_id = p_design_run_id
        and candidates.slot_id = lower(evaluation.slot_id)
        and candidates.card_id = lower(evaluation.card_id)
        and candidates.candidate_revision = evaluation.candidate_revision::smallint
      where evaluation.verdict = 'APPROVED'
        and candidates.work_unit_id = item.work_unit_id::smallint
        and candidates.card_id = lower(card.value->>'id')
    )
  ) then raise exception 'V3 approved cards do not match accepted Slot candidates'; end if;

  perform public.record_chapter_quality_evaluations_v3(
    v_project_id, p_chapter_id, p_design_run_id, p_evaluations,
    p_coverage_result, p_duplicate_pairs, p_evaluator_model, p_prompt_version
  );
  update public.card_slot_candidates as candidates set status = 'ACCEPTED'
  from jsonb_to_recordset(p_evaluations) as evaluation(
    slot_id text, card_id text, candidate_revision integer, verdict text
  )
  where candidates.project_id = v_project_id
    and candidates.chapter_id = p_chapter_id::smallint
    and candidates.design_run_id = p_design_run_id
    and candidates.slot_id = lower(evaluation.slot_id)
    and candidates.card_id = lower(evaluation.card_id)
    and candidates.candidate_revision = evaluation.candidate_revision::smallint
    and evaluation.verdict = 'APPROVED';
  update public.card_blueprint_slots set status = 'ACCEPTED', updated_at = now()
  where project_id = v_project_id and chapter_id = p_chapter_id::smallint
    and design_run_id = p_design_run_id
    and slot_id in (
      select lower(evaluation.slot_id)
      from jsonb_to_recordset(p_evaluations) as evaluation(slot_id text, verdict text)
      where evaluation.verdict = 'APPROVED'
    );
  update public.work_units as units
  set worker_cards = item.worker_cards, cards_root = lower(item.cards_root),
      card_count = item.card_count::smallint, status = 'APPROVED',
      lease_until = null, last_error = null
  from jsonb_to_recordset(p_work_units) as item(
    work_unit_id integer, worker_cards jsonb, cards_root text, card_count integer
  )
  where units.project_id = v_project_id and units.work_unit_id = item.work_unit_id::smallint;
  update public.chapters set status = 'GENERATING', last_error = null
  where project_id = v_project_id and chapter_id = p_chapter_id::smallint;
  return true;
end;
$$;

create function public.request_chapter_slot_repairs_v3(
  p_project_id text,
  p_chapter_id integer,
  p_design_run_id uuid,
  p_evaluations jsonb,
  p_repairs jsonb,
  p_coverage_result jsonb,
  p_duplicate_pairs jsonb,
  p_evaluator_model text,
  p_prompt_version text
)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare v_project_id text := lower(p_project_id);
begin
  if jsonb_typeof(p_evaluations) <> 'array'
    or jsonb_typeof(p_repairs) <> 'array' or jsonb_array_length(p_repairs) < 1
    or (select count(distinct lower(item.slot_id))
        from jsonb_to_recordset(p_repairs) as item(slot_id text)) <> jsonb_array_length(p_repairs) then
    raise exception 'V3 Slot repairs must be a non-empty unique array';
  end if;
  perform 1 from public.chapters as chapters
  join public.learning_projects as projects on projects.project_id = chapters.project_id
  join public.chapter_design_runs as runs
    on runs.project_id = chapters.project_id and runs.chapter_id = chapters.chapter_id
  where chapters.project_id = v_project_id and chapters.chapter_id = p_chapter_id::smallint
    and chapters.status = 'QUALITY_CHECK' and projects.status = 'GENERATING'
    and projects.generation_policy_version = 3
    and runs.design_run_id = p_design_run_id and runs.status = 'COMPLETED'
  for update of chapters;
  if not found then raise exception 'claimed V3 Chapter quality check was not found'; end if;

  if exists (
    select 1 from jsonb_to_recordset(p_repairs) as repair(slot_id text, reason text)
    left join public.card_blueprint_slots as slots
      on slots.project_id = v_project_id and slots.chapter_id = p_chapter_id::smallint
      and slots.design_run_id = p_design_run_id and slots.slot_id = lower(repair.slot_id)
    where slots.slot_id is null or slots.status = 'ACCEPTED'
      or char_length(repair.reason) not between 1 and 500
  ) or exists (
    select 1 from jsonb_to_recordset(p_evaluations) as evaluation(
      slot_id text, card_id text, candidate_revision integer, verdict text,
      hard_failures jsonb, rubric_scores jsonb
    )
    left join public.card_slot_candidates as candidates
      on candidates.project_id = v_project_id
      and candidates.chapter_id = p_chapter_id::smallint
      and candidates.design_run_id = p_design_run_id
      and candidates.slot_id = lower(evaluation.slot_id)
      and candidates.card_id = lower(evaluation.card_id)
      and candidates.candidate_revision = evaluation.candidate_revision::smallint
    where candidates.card_id is null
      or candidates.status not in ('CANDIDATE_READY', 'ACCEPTED')
      or evaluation.verdict not in ('APPROVED', 'REPAIR_REQUESTED')
      or jsonb_typeof(evaluation.hard_failures) <> 'array'
      or jsonb_typeof(evaluation.rubric_scores) <> 'object'
  ) then raise exception 'V3 Slot repair evaluations do not match candidates'; end if;
  if exists (
    select 1 from jsonb_to_recordset(p_repairs) as repair(slot_id text)
    join public.card_slot_candidates as candidates
      on candidates.project_id = v_project_id and candidates.chapter_id = p_chapter_id::smallint
      and candidates.design_run_id = p_design_run_id and candidates.slot_id = lower(repair.slot_id)
    group by candidates.slot_id having max(candidates.candidate_revision) >= 3
  ) then raise exception 'V3 candidate repair limit is exhausted'; end if;

  perform public.record_chapter_quality_evaluations_v3(
    v_project_id, p_chapter_id, p_design_run_id, p_evaluations,
    p_coverage_result, p_duplicate_pairs, p_evaluator_model, p_prompt_version
  );
  update public.card_quality_evaluations as evaluations
  set repair_reason = repair.reason
  from jsonb_to_recordset(p_evaluations) as evaluation(
    slot_id text, candidate_revision integer, verdict text
  )
  join jsonb_to_recordset(p_repairs) as repair(slot_id text, reason text)
    on lower(repair.slot_id) = lower(evaluation.slot_id)
  where evaluations.project_id = v_project_id
    and evaluations.chapter_id = p_chapter_id::smallint
    and evaluations.design_run_id = p_design_run_id
    and evaluations.slot_id = lower(evaluation.slot_id)
    and evaluations.candidate_revision = evaluation.candidate_revision::smallint
    and evaluation.verdict = 'REPAIR_REQUESTED';
  update public.card_slot_candidates as candidates
  set status = case evaluation.verdict
    when 'APPROVED' then 'ACCEPTED' else 'REJECTED' end
  from jsonb_to_recordset(p_evaluations) as evaluation(
    slot_id text, card_id text, candidate_revision integer, verdict text
  )
  where candidates.project_id = v_project_id
    and candidates.chapter_id = p_chapter_id::smallint
    and candidates.design_run_id = p_design_run_id
    and candidates.slot_id = lower(evaluation.slot_id)
    and candidates.card_id = lower(evaluation.card_id)
    and candidates.candidate_revision = evaluation.candidate_revision::smallint;
  update public.card_blueprint_slots as slots set status = 'ACCEPTED', updated_at = now()
  from jsonb_to_recordset(p_evaluations) as evaluation(slot_id text, verdict text)
  where slots.project_id = v_project_id and slots.chapter_id = p_chapter_id::smallint
    and slots.design_run_id = p_design_run_id and slots.slot_id = lower(evaluation.slot_id)
    and evaluation.verdict = 'APPROVED';
  update public.card_blueprint_slots as slots
  set status = 'REPAIR_REQUESTED', updated_at = now()
  from jsonb_to_recordset(p_repairs) as repair(slot_id text)
  where slots.project_id = v_project_id and slots.chapter_id = p_chapter_id::smallint
    and slots.design_run_id = p_design_run_id and slots.slot_id = lower(repair.slot_id);
  update public.work_units as units
  set status = 'REPAIRING', worker_cards = '[]'::jsonb, cards_root = null,
      card_count = null, commit_tx_hash = null, lease_until = null,
      last_error = 'Blueprint Slot repair requested'
  where units.project_id = v_project_id and units.chapter_id = p_chapter_id::smallint
    and exists (
      select 1 from public.card_blueprint_slots as slots
      join jsonb_to_recordset(p_repairs) as repair(slot_id text)
        on slots.slot_id = lower(repair.slot_id)
      where slots.project_id = units.project_id and slots.chapter_id = units.chapter_id
        and slots.assigned_work_unit_id = units.work_unit_id and slots.design_run_id = p_design_run_id
    );
  update public.chapters set status = 'GENERATING', last_error = 'Blueprint Slot repair requested'
  where project_id = v_project_id and chapter_id = p_chapter_id::smallint;
  return true;
end;
$$;

alter table public.chapter_design_runs enable row level security;
alter table public.chapter_design_runs force row level security;
alter table public.card_blueprint_slots enable row level security;
alter table public.card_blueprint_slots force row level security;
alter table public.card_slot_candidates enable row level security;
alter table public.card_slot_candidates force row level security;
alter table public.card_quality_evaluations enable row level security;
alter table public.card_quality_evaluations force row level security;
alter table public.knowledge_card_feedback enable row level security;
alter table public.knowledge_card_feedback force row level security;
revoke all on table public.chapter_design_runs from public;
revoke all on table public.card_blueprint_slots from public;
revoke all on table public.card_slot_candidates from public;
revoke all on table public.card_quality_evaluations from public;
revoke all on table public.knowledge_card_feedback from public;
revoke execute on function public.validate_chapter_design_snapshot_v3(uuid, jsonb, jsonb) from public;
revoke execute on function public.start_chapter_design_v3(text, integer, integer, integer) from public;
revoke execute on function public.complete_chapter_design_v3(uuid, jsonb, jsonb, text, text, text, text, jsonb) from public;
revoke execute on function public.fail_chapter_design_v3(uuid, text, boolean) from public;
revoke execute on function public.confirm_project_outline_design_v3(text, text, integer, text, jsonb) from public;
revoke execute on function public.freeze_project_design_v3(text, integer, text, jsonb, jsonb, text, jsonb) from public;
revoke execute on function public.save_work_unit_candidates_v3(text, integer, text, integer, jsonb) from public;
revoke execute on function public.record_chapter_quality_evaluations_v3(text, integer, uuid, jsonb, jsonb, jsonb, text, text) from public;
revoke execute on function public.approve_chapter_candidates_v3(text, integer, uuid, jsonb, jsonb, jsonb, jsonb, text, text) from public;
revoke execute on function public.request_chapter_slot_repairs_v3(text, integer, uuid, jsonb, jsonb, jsonb, jsonb, text, text) from public;

do $$
begin
  if exists (select 1 from pg_roles where rolname = 'anon') then
    revoke all on table public.chapter_design_runs from anon;
    revoke all on table public.card_blueprint_slots from anon;
    revoke all on table public.card_slot_candidates from anon;
    revoke all on table public.card_quality_evaluations from anon;
    revoke all on table public.knowledge_card_feedback from anon;
  end if;
  if exists (select 1 from pg_roles where rolname = 'authenticated') then
    revoke all on table public.chapter_design_runs from authenticated;
    revoke all on table public.card_blueprint_slots from authenticated;
    revoke all on table public.card_slot_candidates from authenticated;
    revoke all on table public.card_quality_evaluations from authenticated;
    revoke all on table public.knowledge_card_feedback from authenticated;
  end if;
  if exists (select 1 from pg_roles where rolname = 'service_role') then
    grant all on table public.chapter_design_runs to service_role;
    grant all on table public.card_blueprint_slots to service_role;
    grant all on table public.card_slot_candidates to service_role;
    grant all on table public.card_quality_evaluations to service_role;
    grant all on table public.knowledge_card_feedback to service_role;
    grant execute on function public.validate_chapter_design_snapshot_v3(uuid, jsonb, jsonb) to service_role;
    grant execute on function public.start_chapter_design_v3(text, integer, integer, integer) to service_role;
    grant execute on function public.complete_chapter_design_v3(uuid, jsonb, jsonb, text, text, text, text, jsonb) to service_role;
    grant execute on function public.fail_chapter_design_v3(uuid, text, boolean) to service_role;
    grant execute on function public.confirm_project_outline_design_v3(text, text, integer, text, jsonb) to service_role;
    grant execute on function public.freeze_project_design_v3(text, integer, text, jsonb, jsonb, text, jsonb) to service_role;
    grant execute on function public.save_work_unit_candidates_v3(text, integer, text, integer, jsonb) to service_role;
    grant execute on function public.approve_chapter_candidates_v3(text, integer, uuid, jsonb, jsonb, jsonb, jsonb, text, text) to service_role;
    grant execute on function public.request_chapter_slot_repairs_v3(text, integer, uuid, jsonb, jsonb, jsonb, jsonb, text, text) to service_role;
  end if;
end;
$$;

commit;
