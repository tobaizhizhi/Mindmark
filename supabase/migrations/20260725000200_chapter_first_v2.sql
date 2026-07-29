begin;

create table public.learning_projects (
  id uuid primary key default gen_random_uuid(),
  project_id text not null unique check (project_id ~ '^0x[0-9a-f]{64}$'),
  owner_address text not null check (owner_address ~ '^0x[0-9a-f]{40}$'),
  title text not null check (char_length(title) between 1 and 200),
  goal text check (goal is null or char_length(goal) between 1 and 500),
  source_hash text not null check (source_hash ~ '^0x[0-9a-f]{64}$'),
  goal_hash text not null check (goal_hash ~ '^0x[0-9a-f]{64}$'),
  outline_version integer not null default 1 check (outline_version > 0),
  outline_hash text not null check (outline_hash ~ '^0x[0-9a-f]{64}$'),
  work_unit_manifest_root text check (
    work_unit_manifest_root is null or work_unit_manifest_root ~ '^0x[0-9a-f]{64}$'
  ),
  registry_version smallint not null default 2 check (registry_version = 2),
  status text not null check (
    status in (
      'UPLOADED',
      'OUTLINING',
      'OUTLINE_READY',
      'AWAITING_REGISTRY',
      'GENERATING',
      'FINALIZING',
      'READY',
      'FAILED_RETRYABLE',
      'CANCELLED'
    )
  ),
  project_deck_root text check (
    project_deck_root is null or project_deck_root ~ '^0x[0-9a-f]{64}$'
  ),
  initial_plan_hash text check (
    initial_plan_hash is null or initial_plan_hash ~ '^0x[0-9a-f]{64}$'
  ),
  total_card_count smallint not null default 0 check (total_card_count between 0 and 200),
  create_tx_hash text check (create_tx_hash is null or create_tx_hash ~ '^0x[0-9a-f]{64}$'),
  finalize_tx_hash text check (
    finalize_tx_hash is null or finalize_tx_hash ~ '^0x[0-9a-f]{64}$'
  ),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table public.source_blocks (
  project_id text not null references public.learning_projects(project_id) on delete cascade,
  block_index integer not null check (block_index between 0 and 65535),
  page_number smallint not null check (page_number > 0),
  kind text not null check (kind in ('heading', 'paragraph', 'code')),
  text text check (text is null or char_length(text) between 1 and 4000),
  block_hash text not null check (block_hash ~ '^0x[0-9a-f]{64}$'),
  created_at timestamptz not null default now(),
  primary key (project_id, block_index)
);

create table public.chapters (
  id uuid primary key default gen_random_uuid(),
  project_id text not null references public.learning_projects(project_id) on delete cascade,
  chapter_id smallint not null check (chapter_id between 0 and 15),
  position smallint not null check (position between 0 and 15),
  title text not null check (char_length(title) between 1 and 200),
  summary text not null check (char_length(summary) between 1 and 500),
  start_block integer not null check (start_block between 0 and 65535),
  end_block integer not null check (end_block between start_block and 65535),
  page_start smallint not null check (page_start > 0),
  page_end smallint not null check (page_end >= page_start),
  source_hash text not null check (source_hash ~ '^0x[0-9a-f]{64}$'),
  importance smallint not null check (importance between 1 and 5),
  status text not null check (
    status in ('DRAFT', 'CONFIRMED', 'GENERATING', 'ASSEMBLING', 'READY', 'FAILED_RETRYABLE')
  ),
  cards_root text check (cards_root is null or cards_root ~ '^0x[0-9a-f]{64}$'),
  card_count smallint not null default 0 check (card_count between 0 and 30),
  finalize_tx_hash text check (
    finalize_tx_hash is null or finalize_tx_hash ~ '^0x[0-9a-f]{64}$'
  ),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (project_id, chapter_id),
  unique (project_id, position)
);

create table public.work_units (
  project_id text not null references public.learning_projects(project_id) on delete cascade,
  work_unit_id smallint not null check (work_unit_id between 0 and 47),
  chapter_id smallint not null,
  unit_index smallint not null check (unit_index between 0 and 7),
  start_block integer not null check (start_block between 0 and 65535),
  end_block integer not null check (end_block between start_block and 65535),
  source_text text,
  source_blocks jsonb check (source_blocks is null or jsonb_typeof(source_blocks) = 'array'),
  source_unit_hash text not null check (source_unit_hash ~ '^0x[0-9a-f]{64}$'),
  manifest_proof jsonb not null check (jsonb_typeof(manifest_proof) = 'array'),
  card_budget smallint not null check (card_budget between 1 and 30),
  worker_address text check (worker_address is null or worker_address ~ '^0x[0-9a-f]{40}$'),
  status text not null check (
    status in ('QUEUED', 'GENERATING', 'VALIDATING', 'SAVED', 'SUBMITTING', 'CONFIRMED', 'RETRYABLE')
  ),
  attempt smallint not null default 0 check (attempt between 0 and 3),
  lease_until timestamptz,
  last_error text check (last_error is null or char_length(last_error) <= 500),
  worker_cards jsonb not null default '[]'::jsonb check (jsonb_typeof(worker_cards) = 'array'),
  cards_root text check (cards_root is null or cards_root ~ '^0x[0-9a-f]{64}$'),
  card_count smallint check (card_count is null or card_count between 1 and 30),
  commit_tx_hash text check (commit_tx_hash is null or commit_tx_hash ~ '^0x[0-9a-f]{64}$'),
  confirmed_block bigint check (confirmed_block is null or confirmed_block >= 0),
  gas_used numeric(30, 0) check (gas_used is null or gas_used >= 0),
  generation_ms integer check (generation_ms is null or generation_ms >= 0),
  confirmation_ms integer check (confirmation_ms is null or confirmation_ms >= 0),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (project_id, work_unit_id),
  unique (project_id, chapter_id, unit_index),
  foreign key (project_id, chapter_id)
    references public.chapters(project_id, chapter_id) on delete cascade
);

create table public.knowledge_cards (
  card_id text primary key check (card_id ~ '^0x[0-9a-f]{64}$'),
  project_id text not null references public.learning_projects(project_id) on delete cascade,
  chapter_id smallint not null,
  work_unit_id smallint not null,
  position smallint not null check (position between 0 and 199),
  content jsonb not null check (jsonb_typeof(content) = 'object'),
  card_hash text not null check (card_hash ~ '^0x[0-9a-f]{64}$'),
  worker_proof jsonb not null check (jsonb_typeof(worker_proof) = 'array'),
  chapter_proof jsonb not null check (jsonb_typeof(chapter_proof) = 'array'),
  created_at timestamptz not null default now(),
  unique (project_id, chapter_id, position),
  unique (card_id, project_id, chapter_id),
  foreign key (project_id, chapter_id)
    references public.chapters(project_id, chapter_id) on delete cascade,
  foreign key (project_id, work_unit_id)
    references public.work_units(project_id, work_unit_id) on delete cascade
);

create table public.card_learning_states (
  owner_address text not null check (owner_address ~ '^0x[0-9a-f]{40}$'),
  project_id text not null,
  chapter_id smallint not null,
  card_id text not null,
  fsrs_state jsonb not null check (jsonb_typeof(fsrs_state) = 'object'),
  due_at timestamptz,
  reps integer not null default 0 check (reps >= 0),
  lapses integer not null default 0 check (lapses >= 0),
  last_reviewed_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (owner_address, card_id),
  foreign key (card_id, project_id, chapter_id)
    references public.knowledge_cards(card_id, project_id, chapter_id) on delete cascade
);

create table public.review_sessions (
  session_id uuid primary key,
  owner_address text not null check (owner_address ~ '^0x[0-9a-f]{40}$'),
  project_id text not null references public.learning_projects(project_id) on delete cascade,
  scope_type text not null check (scope_type in ('CHAPTER', 'PROJECT')),
  chapter_id smallint,
  status text not null default 'ACTIVE' check (status in ('ACTIVE', 'COMPLETED', 'ABANDONED')),
  reviewed_count smallint not null default 0 check (reviewed_count between 0 and 15),
  forgotten_count smallint not null default 0 check (
    forgotten_count between 0 and reviewed_count
  ),
  average_response_ms integer check (average_response_ms is null or average_response_ms >= 0),
  started_at timestamptz not null default now(),
  completed_at timestamptz,
  check (
    (scope_type = 'CHAPTER' and chapter_id is not null)
    or (scope_type = 'PROJECT' and chapter_id is null)
  ),
  foreign key (project_id, chapter_id)
    references public.chapters(project_id, chapter_id)
);

create table public.project_review_logs (
  id uuid primary key default gen_random_uuid(),
  session_id uuid not null references public.review_sessions(session_id) on delete cascade,
  owner_address text not null check (owner_address ~ '^0x[0-9a-f]{40}$'),
  project_id text not null,
  chapter_id smallint not null,
  card_id text not null,
  rating text not null check (rating in ('again', 'hard', 'good', 'easy')),
  response_ms integer not null check (response_ms between 0 and 3600000),
  reviewed_at timestamptz not null,
  fsrs_before jsonb,
  fsrs_after jsonb not null check (jsonb_typeof(fsrs_after) = 'object'),
  created_at timestamptz not null default now(),
  unique (session_id, card_id),
  foreign key (card_id, project_id, chapter_id)
    references public.knowledge_cards(card_id, project_id, chapter_id) on delete cascade
);

create table public.project_agent_events (
  id bigint generated always as identity primary key,
  project_id text not null references public.learning_projects(project_id) on delete cascade,
  chapter_id smallint,
  work_unit_id smallint,
  agent_role text not null check (
    agent_role in ('chapter-planner', 'worker', 'chapter-assembler', 'project-finalizer', 'settlement-agent')
  ),
  event_type text not null check (char_length(event_type) between 1 and 80),
  payload jsonb not null default '{}'::jsonb check (jsonb_typeof(payload) = 'object'),
  tx_hash text check (tx_hash is null or tx_hash ~ '^0x[0-9a-f]{64}$'),
  created_at timestamptz not null default now(),
  foreign key (project_id, chapter_id)
    references public.chapters(project_id, chapter_id),
  foreign key (project_id, work_unit_id)
    references public.work_units(project_id, work_unit_id)
);

create index learning_projects_owner_updated_idx
  on public.learning_projects (owner_address, updated_at desc);
create index learning_projects_status_updated_idx
  on public.learning_projects (status, updated_at);
create index chapters_project_position_idx
  on public.chapters (project_id, position);
create index chapters_status_updated_idx
  on public.chapters (status, updated_at);
create index work_units_claim_idx
  on public.work_units (status, lease_until, chapter_id, unit_index);
create index knowledge_cards_chapter_position_idx
  on public.knowledge_cards (project_id, chapter_id, position);
create index knowledge_cards_tags_idx
  on public.knowledge_cards using gin ((content -> 'tags'));
create index card_learning_states_due_idx
  on public.card_learning_states (owner_address, project_id, chapter_id, due_at);
create index project_review_logs_chapter_reviewed_idx
  on public.project_review_logs (owner_address, project_id, chapter_id, reviewed_at desc);
create index project_agent_events_project_created_idx
  on public.project_agent_events (project_id, created_at desc);

create trigger learning_projects_set_updated_at
before update on public.learning_projects
for each row execute function public.set_updated_at();

create trigger chapters_set_updated_at
before update on public.chapters
for each row execute function public.set_updated_at();

create trigger work_units_set_updated_at
before update on public.work_units
for each row execute function public.set_updated_at();

create trigger card_learning_states_set_updated_at
before update on public.card_learning_states
for each row execute function public.set_updated_at();

create function public.create_project_outline_v2(
  p_project jsonb,
  p_source_blocks jsonb,
  p_chapters jsonb
)
returns text
language plpgsql
security definer
set search_path = public
as $$
declare
  v_project_id text := lower(p_project->>'project_id');
  v_block_count integer;
  v_chapter_count integer;
begin
  if jsonb_typeof(p_source_blocks) <> 'array' or jsonb_array_length(p_source_blocks) < 1 then
    raise exception 'source_blocks must be a non-empty array';
  end if;
  if jsonb_typeof(p_chapters) <> 'array'
    or jsonb_array_length(p_chapters) not between 1 and 16 then
    raise exception 'chapters must contain between 1 and 16 entries';
  end if;
  v_block_count := jsonb_array_length(p_source_blocks);
  v_chapter_count := jsonb_array_length(p_chapters);

  if (
    select count(distinct item.block_index)
    from jsonb_to_recordset(p_source_blocks) as item(block_index integer)
  ) <> v_block_count or exists (
    select 1
    from jsonb_to_recordset(p_source_blocks) as item(block_index integer)
    where item.block_index < 0 or item.block_index >= v_block_count
  ) then
    raise exception 'block_index values must be unique and contiguous';
  end if;

  if (
    select count(distinct item.chapter_id)
    from jsonb_to_recordset(p_chapters) as item(chapter_id integer)
  ) <> v_chapter_count or exists (
    select 1
    from jsonb_to_recordset(p_chapters) as item(chapter_id integer, position integer)
    where item.chapter_id < 0 or item.chapter_id >= v_chapter_count
      or item.position <> item.chapter_id
  ) then
    raise exception 'chapter_id and position values must be unique and contiguous';
  end if;

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
  ) then
    raise exception 'Chapter ranges must cover every Source Block exactly once';
  end if;

  insert into public.learning_projects (
    project_id, owner_address, title, goal, source_hash, goal_hash,
    outline_version, outline_hash, registry_version, status
  ) values (
    v_project_id,
    lower(p_project->>'owner_address'),
    btrim(p_project->>'title'),
    nullif(btrim(p_project->>'goal'), ''),
    lower(p_project->>'source_hash'),
    lower(p_project->>'goal_hash'),
    (p_project->>'outline_version')::integer,
    lower(p_project->>'outline_hash'),
    2,
    'OUTLINE_READY'
  );

  insert into public.source_blocks (
    project_id, block_index, page_number, kind, text, block_hash
  )
  select v_project_id, item.block_index, item.page_number, item.kind,
    item.text, lower(item.block_hash)
  from jsonb_to_recordset(p_source_blocks) as item(
    block_index integer, page_number smallint, kind text, text text, block_hash text
  );

  insert into public.chapters (
    project_id, chapter_id, position, title, summary, start_block, end_block,
    page_start, page_end, source_hash, importance, status
  )
  select v_project_id, item.chapter_id, item.position, item.title, item.summary,
    item.start_block, item.end_block, item.page_start, item.page_end,
    lower(item.source_hash), item.importance, 'DRAFT'
  from jsonb_to_recordset(p_chapters) as item(
    chapter_id smallint, position smallint, title text, summary text,
    start_block integer, end_block integer, page_start smallint, page_end smallint,
    source_hash text, importance smallint
  );

  return v_project_id;
end;
$$;

create function public.confirm_project_outline_v2(
  p_project_id text,
  p_owner text,
  p_outline_version integer,
  p_outline_hash text,
  p_work_unit_manifest_root text,
  p_chapters jsonb,
  p_work_units jsonb
)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare
  v_project_id text := lower(p_project_id);
  v_chapter_count integer;
  v_work_unit_count integer;
  v_block_count integer;
begin
  perform 1 from public.learning_projects
  where project_id = v_project_id
    and owner_address = lower(p_owner)
    and outline_version = p_outline_version
    and status = 'OUTLINE_READY'
  for update;
  if not found then raise exception 'editable owned Project outline not found'; end if;

  if jsonb_typeof(p_chapters) <> 'array'
    or jsonb_array_length(p_chapters) not between 1 and 16 then
    raise exception 'chapters must contain between 1 and 16 entries';
  end if;
  if jsonb_typeof(p_work_units) <> 'array'
    or jsonb_array_length(p_work_units) not between 1 and 48 then
    raise exception 'work_units must contain between 1 and 48 entries';
  end if;
  v_chapter_count := jsonb_array_length(p_chapters);
  v_work_unit_count := jsonb_array_length(p_work_units);
  select count(*)::integer into v_block_count
  from public.source_blocks where project_id = v_project_id;

  if (
    select count(distinct item.chapter_id)
    from jsonb_to_recordset(p_chapters) as item(chapter_id integer)
  ) <> v_chapter_count or exists (
    select 1
    from jsonb_to_recordset(p_chapters) as item(chapter_id integer, position integer)
    where item.chapter_id < 0 or item.chapter_id >= v_chapter_count
      or item.position <> item.chapter_id
  ) then
    raise exception 'chapter_id and position values must be unique and contiguous';
  end if;

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
  ) then
    raise exception 'Chapter ranges must cover every Source Block exactly once';
  end if;

  if (
    select count(distinct item.work_unit_id)
    from jsonb_to_recordset(p_work_units) as item(work_unit_id integer)
  ) <> v_work_unit_count or exists (
    select 1
    from jsonb_to_recordset(p_work_units) as item(work_unit_id integer)
    where item.work_unit_id < 0 or item.work_unit_id >= v_work_unit_count
  ) then
    raise exception 'work_unit_id values must be unique and contiguous';
  end if;

  if exists (
    select 1
    from jsonb_to_recordset(p_work_units) as unit(
      chapter_id integer, unit_index integer, start_block integer, end_block integer
    )
    left join jsonb_to_recordset(p_chapters) as chapter(
      chapter_id integer, start_block integer, end_block integer
    ) on chapter.chapter_id = unit.chapter_id
    where chapter.chapter_id is null
      or unit.start_block < chapter.start_block
      or unit.end_block > chapter.end_block
      or unit.end_block < unit.start_block
  ) then
    raise exception 'Work Unit cannot cross its Chapter range';
  end if;

  if exists (
    with units as (
      select item.chapter_id, item.unit_index,
        row_number() over (partition by item.chapter_id order by item.unit_index) - 1 as expected_index,
        count(*) over (partition by item.chapter_id) as chapter_unit_count
      from jsonb_to_recordset(p_work_units) as item(chapter_id integer, unit_index integer)
    )
    select 1 from units
    where unit_index <> expected_index or chapter_unit_count > 8
  ) then
    raise exception 'unit_index values must be contiguous within each Chapter';
  end if;

  delete from public.chapters where project_id = v_project_id;

  insert into public.chapters (
    project_id, chapter_id, position, title, summary, start_block, end_block,
    page_start, page_end, source_hash, importance, status
  )
  select v_project_id, item.chapter_id, item.position, item.title, item.summary,
    item.start_block, item.end_block, item.page_start, item.page_end,
    lower(item.source_hash), item.importance, 'CONFIRMED'
  from jsonb_to_recordset(p_chapters) as item(
    chapter_id smallint, position smallint, title text, summary text,
    start_block integer, end_block integer, page_start smallint, page_end smallint,
    source_hash text, importance smallint
  );

  insert into public.work_units (
    project_id, work_unit_id, chapter_id, unit_index, start_block, end_block,
    source_text, source_blocks, source_unit_hash, manifest_proof, card_budget, status
  )
  select v_project_id, item.work_unit_id, item.chapter_id, item.unit_index,
    item.start_block, item.end_block, item.source_text, item.source_blocks,
    lower(item.source_unit_hash), item.manifest_proof, item.card_budget, 'QUEUED'
  from jsonb_to_recordset(p_work_units) as item(
    work_unit_id smallint, chapter_id smallint, unit_index smallint,
    start_block integer, end_block integer, source_text text, source_blocks jsonb,
    source_unit_hash text, manifest_proof jsonb, card_budget smallint
  );

  update public.learning_projects
  set outline_hash = lower(p_outline_hash),
      work_unit_manifest_root = lower(p_work_unit_manifest_root),
      status = 'AWAITING_REGISTRY'
  where project_id = v_project_id;
  return true;
end;
$$;

create function public.claim_next_work_unit_v2(p_worker_address text)
returns setof public.work_units
language plpgsql
security definer
set search_path = public
as $$
declare
  v_project_id text;
  v_work_unit_id smallint;
  v_chapter_id smallint;
begin
  if lower(p_worker_address) !~ '^0x[0-9a-f]{40}$' then
    raise exception 'invalid Worker address';
  end if;

  select units.project_id, units.work_unit_id, units.chapter_id
  into v_project_id, v_work_unit_id, v_chapter_id
  from public.work_units as units
  join public.learning_projects as projects on projects.project_id = units.project_id
  join public.chapters as chapters
    on chapters.project_id = units.project_id and chapters.chapter_id = units.chapter_id
  where projects.status = 'GENERATING'
    and chapters.status in ('CONFIRMED', 'GENERATING', 'FAILED_RETRYABLE')
    and units.status in ('QUEUED', 'RETRYABLE')
    and units.attempt < 3
  order by
    (units.status = 'RETRYABLE') desc,
    exists (
      select 1 from public.work_units as completed
      where completed.project_id = units.project_id
        and completed.chapter_id = units.chapter_id
        and completed.status = 'CONFIRMED'
    ) desc,
    chapters.position,
    units.unit_index
  for update of units skip locked
  limit 1;

  if not found then return; end if;

  update public.work_units
  set status = 'GENERATING',
      worker_address = lower(p_worker_address),
      attempt = attempt + 1,
      lease_until = now() + interval '90 seconds',
      last_error = null
  where project_id = v_project_id and work_unit_id = v_work_unit_id;

  update public.chapters
  set status = 'GENERATING'
  where project_id = v_project_id
    and chapter_id = v_chapter_id
    and status in ('CONFIRMED', 'FAILED_RETRYABLE');

  return query
  select * from public.work_units
  where project_id = v_project_id and work_unit_id = v_work_unit_id;
end;
$$;

create function public.recover_stale_work_units_v2()
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  v_count integer;
begin
  update public.work_units
  set status = 'RETRYABLE',
      lease_until = null,
      last_error = 'generation lease expired'
  where status in ('GENERATING', 'VALIDATING')
    and lease_until < now()
    and attempt < 3;
  get diagnostics v_count = row_count;
  return v_count;
end;
$$;

create function public.get_chapter_summaries_v2(
  p_owner text,
  p_project_id text,
  p_now timestamptz default now()
)
returns table (
  project_id text,
  chapter_id smallint,
  "position" smallint,
  title text,
  summary text,
  page_start smallint,
  page_end smallint,
  importance smallint,
  status text,
  card_count bigint,
  studied_count bigint,
  due_count bigint,
  new_count bigint,
  mastered_count bigint,
  last_reviewed_at timestamptz,
  progress_percent numeric
)
language sql
stable
security definer
set search_path = public
as $$
  select
    chapters.project_id,
    chapters.chapter_id,
    chapters.position,
    chapters.title,
    chapters.summary,
    chapters.page_start,
    chapters.page_end,
    chapters.importance,
    chapters.status,
    count(cards.card_id) as card_count,
    count(states.card_id) filter (where states.reps > 0) as studied_count,
    count(states.card_id) filter (where states.reps > 0 and states.due_at <= p_now) as due_count,
    count(cards.card_id) filter (where states.card_id is null or states.reps = 0) as new_count,
    count(states.card_id) filter (where states.reps >= 3 and states.lapses = 0) as mastered_count,
    max(states.last_reviewed_at) as last_reviewed_at,
    case when count(cards.card_id) = 0 then 0::numeric
      else round(
        count(states.card_id) filter (where states.reps > 0)::numeric
          * 100 / count(cards.card_id),
        1
      )
    end as progress_percent
  from public.chapters
  join public.learning_projects as projects on projects.project_id = chapters.project_id
  left join public.knowledge_cards as cards
    on cards.project_id = chapters.project_id and cards.chapter_id = chapters.chapter_id
  left join public.card_learning_states as states
    on states.card_id = cards.card_id and states.owner_address = lower(p_owner)
  where projects.owner_address = lower(p_owner)
    and projects.project_id = lower(p_project_id)
  group by chapters.project_id, chapters.chapter_id, chapters.position, chapters.title,
    chapters.summary, chapters.page_start, chapters.page_end, chapters.importance, chapters.status
  order by chapters.position;
$$;

create function public.get_project_summaries_v2(
  p_owner text,
  p_now timestamptz default now()
)
returns table (
  project_id text,
  title text,
  goal text,
  status text,
  registry_version smallint,
  chapter_count bigint,
  ready_chapter_count bigint,
  card_count bigint,
  due_count bigint,
  updated_at timestamptz
)
language sql
stable
security definer
set search_path = public
as $$
  select
    projects.project_id,
    projects.title,
    projects.goal,
    projects.status,
    projects.registry_version,
    count(distinct chapters.chapter_id) as chapter_count,
    count(distinct chapters.chapter_id) filter (where chapters.status = 'READY') as ready_chapter_count,
    count(distinct cards.card_id) as card_count,
    count(distinct states.card_id) filter (where states.reps > 0 and states.due_at <= p_now) as due_count,
    projects.updated_at
  from public.learning_projects as projects
  left join public.chapters on chapters.project_id = projects.project_id
  left join public.knowledge_cards as cards on cards.project_id = projects.project_id
  left join public.card_learning_states as states
    on states.card_id = cards.card_id and states.owner_address = lower(p_owner)
  where projects.owner_address = lower(p_owner)
  group by projects.project_id, projects.title, projects.goal, projects.status,
    projects.registry_version, projects.updated_at
  order by projects.updated_at desc;
$$;

alter table public.learning_projects enable row level security;
alter table public.source_blocks enable row level security;
alter table public.chapters enable row level security;
alter table public.work_units enable row level security;
alter table public.knowledge_cards enable row level security;
alter table public.card_learning_states enable row level security;
alter table public.review_sessions enable row level security;
alter table public.project_review_logs enable row level security;
alter table public.project_agent_events enable row level security;

alter table public.learning_projects force row level security;
alter table public.source_blocks force row level security;
alter table public.chapters force row level security;
alter table public.work_units force row level security;
alter table public.knowledge_cards force row level security;
alter table public.card_learning_states force row level security;
alter table public.review_sessions force row level security;
alter table public.project_review_logs force row level security;
alter table public.project_agent_events force row level security;

revoke all on table public.learning_projects from public;
revoke all on table public.source_blocks from public;
revoke all on table public.chapters from public;
revoke all on table public.work_units from public;
revoke all on table public.knowledge_cards from public;
revoke all on table public.card_learning_states from public;
revoke all on table public.review_sessions from public;
revoke all on table public.project_review_logs from public;
revoke all on table public.project_agent_events from public;
revoke execute on function public.create_project_outline_v2(jsonb, jsonb, jsonb) from public;
revoke execute on function public.confirm_project_outline_v2(
  text, text, integer, text, text, jsonb, jsonb
) from public;
revoke execute on function public.claim_next_work_unit_v2(text) from public;
revoke execute on function public.recover_stale_work_units_v2() from public;
revoke execute on function public.get_chapter_summaries_v2(text, text, timestamptz) from public;
revoke execute on function public.get_project_summaries_v2(text, timestamptz) from public;

do $$
begin
  if exists (select 1 from pg_roles where rolname = 'anon') then
    revoke all on table public.learning_projects from anon;
    revoke all on table public.source_blocks from anon;
    revoke all on table public.chapters from anon;
    revoke all on table public.work_units from anon;
    revoke all on table public.knowledge_cards from anon;
    revoke all on table public.card_learning_states from anon;
    revoke all on table public.review_sessions from anon;
    revoke all on table public.project_review_logs from anon;
    revoke all on table public.project_agent_events from anon;
  end if;
  if exists (select 1 from pg_roles where rolname = 'authenticated') then
    revoke all on table public.learning_projects from authenticated;
    revoke all on table public.source_blocks from authenticated;
    revoke all on table public.chapters from authenticated;
    revoke all on table public.work_units from authenticated;
    revoke all on table public.knowledge_cards from authenticated;
    revoke all on table public.card_learning_states from authenticated;
    revoke all on table public.review_sessions from authenticated;
    revoke all on table public.project_review_logs from authenticated;
    revoke all on table public.project_agent_events from authenticated;
  end if;
  if exists (select 1 from pg_roles where rolname = 'service_role') then
    grant all on table public.learning_projects to service_role;
    grant all on table public.source_blocks to service_role;
    grant all on table public.chapters to service_role;
    grant all on table public.work_units to service_role;
    grant all on table public.knowledge_cards to service_role;
    grant all on table public.card_learning_states to service_role;
    grant all on table public.review_sessions to service_role;
    grant all on table public.project_review_logs to service_role;
    grant all on table public.project_agent_events to service_role;
    grant usage, select on all sequences in schema public to service_role;
    grant execute on function public.create_project_outline_v2(jsonb, jsonb, jsonb) to service_role;
    grant execute on function public.confirm_project_outline_v2(
      text, text, integer, text, text, jsonb, jsonb
    ) to service_role;
    grant execute on function public.claim_next_work_unit_v2(text) to service_role;
    grant execute on function public.recover_stale_work_units_v2() to service_role;
    grant execute on function public.get_chapter_summaries_v2(text, text, timestamptz)
      to service_role;
    grant execute on function public.get_project_summaries_v2(text, timestamptz)
      to service_role;
  end if;
end;
$$;

comment on table public.source_blocks is
  'V2 source provenance. Text is private and may be cleared after generation; hashes remain.';
comment on table public.work_units is
  'Internal V2 execution shards. Work Units are never learner-facing navigation.';
comment on table public.project_agent_events is
  'Redacted V2 operational metadata only; never store source text, prompts, reasoning, or secrets.';

commit;
