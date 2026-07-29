begin;

alter table public.learning_projects
  alter column outline_hash drop not null,
  add column client_request_id text check (
    client_request_id is null or char_length(client_request_id) between 1 and 100
  ),
  add column source_filename text check (
    source_filename is null or char_length(source_filename) between 1 and 255
  ),
  add column source_mime_type text check (
    source_mime_type is null or char_length(source_mime_type) between 1 and 100
  ),
  add column source_page_count smallint check (source_page_count is null or source_page_count > 0),
  add column source_character_count integer check (
    source_character_count is null or source_character_count > 0
  ),
  add column creation_intent jsonb check (
    creation_intent is null or jsonb_typeof(creation_intent) = 'object'
  );

create unique index learning_projects_owner_request_unique_idx
  on public.learning_projects (owner_address, client_request_id)
  where client_request_id is not null;

create unique index learning_projects_owner_source_unique_idx
  on public.learning_projects (owner_address, source_hash);

alter table public.source_blocks
  add column heading_level smallint check (heading_level is null or heading_level between 1 and 6);

alter table public.chapters
  drop constraint chapters_status_check,
  add column min_card_count smallint not null default 2 check (min_card_count between 2 and 30),
  add column target_card_count smallint not null default 3 check (target_card_count between 2 and 30),
  add column max_card_count smallint not null default 30 check (max_card_count between 2 and 30),
  add column card_policy_version smallint not null default 1 check (card_policy_version > 0),
  add constraint chapters_status_check check (
    status in (
      'DRAFT', 'CONFIRMED', 'GENERATING', 'QUALITY_CHECK',
      'ASSEMBLING', 'READY', 'FAILED_RETRYABLE'
    )
  ),
  add constraint chapters_card_policy_check check (
    min_card_count <= target_card_count and target_card_count <= max_card_count
  );

alter table public.work_units drop constraint work_units_status_check;
update public.work_units set status = 'CANDIDATE_READY' where status = 'SAVED';
alter table public.work_units
  add column card_minimum smallint not null default 1 check (card_minimum between 1 and 30),
  add column card_target smallint not null default 1 check (card_target between 1 and 30),
  add constraint work_units_status_check check (
    status in (
      'QUEUED', 'GENERATING', 'VALIDATING', 'CANDIDATE_READY', 'REPAIRING',
      'APPROVED', 'SAVED', 'SUBMITTING', 'CONFIRMED', 'RETRYABLE'
    )
  ),
  add constraint work_units_card_policy_check check (
    card_minimum <= card_target and card_target <= card_budget
  );

create table public.project_outline_versions (
  project_id text not null references public.learning_projects(project_id) on delete cascade,
  version integer not null check (version > 0),
  status text not null check (status in ('DRAFT', 'SUPERSEDED', 'CONFIRMED')),
  outline_hash text not null check (outline_hash ~ '^0x[0-9a-f]{64}$'),
  planner_version text not null check (char_length(planner_version) between 1 and 100),
  created_at timestamptz not null default now(),
  confirmed_at timestamptz,
  primary key (project_id, version)
);

create unique index project_outline_versions_draft_head_idx
  on public.project_outline_versions (project_id)
  where status = 'DRAFT';

create unique index project_outline_versions_confirmed_idx
  on public.project_outline_versions (project_id)
  where status = 'CONFIRMED';

create table public.project_outline_items (
  project_id text not null,
  outline_version integer not null,
  item_id text not null check (char_length(item_id) between 1 and 100),
  position smallint not null check (position between 0 and 15),
  title text not null check (char_length(title) between 1 and 200),
  summary text not null check (char_length(summary) between 1 and 500),
  start_block integer not null check (start_block between 0 and 65535),
  end_block integer not null check (end_block between start_block and 65535),
  page_start smallint not null check (page_start > 0),
  page_end smallint not null check (page_end >= page_start),
  source_hash text not null check (source_hash ~ '^0x[0-9a-f]{64}$'),
  importance smallint not null check (importance between 1 and 5),
  min_card_count smallint not null check (min_card_count between 2 and 30),
  target_card_count smallint not null check (target_card_count between 2 and 30),
  max_card_count smallint not null check (max_card_count between 2 and 30),
  primary key (project_id, outline_version, item_id),
  unique (project_id, outline_version, position),
  foreign key (project_id, outline_version)
    references public.project_outline_versions(project_id, version) on delete cascade,
  check (min_card_count <= target_card_count and target_card_count <= max_card_count)
);

create function public.register_learning_project_source_v2(
  p_project jsonb,
  p_source_blocks jsonb
)
returns text
language plpgsql
security definer
set search_path = public
as $$
declare
  v_project_id text := lower(p_project->>'project_id');
  v_owner text := lower(p_project->>'owner_address');
  v_request_id text := p_project->>'client_request_id';
  v_source_hash text := lower(p_project->>'source_hash');
  v_existing public.learning_projects%rowtype;
  v_block_count integer;
begin
  if jsonb_typeof(p_source_blocks) <> 'array' or jsonb_array_length(p_source_blocks) < 1 then
    raise exception 'source_blocks must be a non-empty array';
  end if;
  v_block_count := jsonb_array_length(p_source_blocks);
  if (
    select count(distinct item.block_index)
    from jsonb_to_recordset(p_source_blocks) as item(block_index integer)
  ) <> v_block_count or exists (
    select 1 from jsonb_to_recordset(p_source_blocks) as item(block_index integer)
    where item.block_index < 0 or item.block_index >= v_block_count
  ) then
    raise exception 'block_index values must be unique and contiguous';
  end if;

  select * into v_existing from public.learning_projects
  where owner_address = v_owner and client_request_id = v_request_id;
  if found then
    if v_existing.source_hash <> v_source_hash
      or v_existing.goal_hash <> lower(p_project->>'goal_hash')
      or v_existing.title <> btrim(p_project->>'title') then
      raise exception 'IDEMPOTENCY_CONFLICT: clientRequestId was used with another payload';
    end if;
    return v_existing.project_id;
  end if;

  select * into v_existing from public.learning_projects
  where owner_address = v_owner and source_hash = v_source_hash;
  if found then return v_existing.project_id; end if;

  insert into public.learning_projects (
    project_id, owner_address, client_request_id, title, goal, source_hash, goal_hash,
    outline_version, outline_hash, registry_version, status, source_filename,
    source_mime_type, source_page_count, source_character_count
  ) values (
    v_project_id, v_owner, v_request_id, btrim(p_project->>'title'),
    nullif(btrim(p_project->>'goal'), ''), v_source_hash, lower(p_project->>'goal_hash'),
    1, null, 2, 'UPLOADED', nullif(btrim(p_project->>'source_filename'), ''),
    nullif(btrim(p_project->>'source_mime_type'), ''),
    (p_project->>'source_page_count')::smallint,
    (p_project->>'source_character_count')::integer
  );

  insert into public.source_blocks (
    project_id, block_index, page_number, kind, text, block_hash, heading_level
  )
  select v_project_id, item.block_index, item.page_number, item.kind, item.text,
    lower(item.block_hash), item.heading_level
  from jsonb_to_recordset(p_source_blocks) as item(
    block_index integer, page_number smallint, kind text, text text,
    block_hash text, heading_level smallint
  );
  return v_project_id;
end;
$$;

create function public.save_project_outline_draft_v2(
  p_project_id text,
  p_owner text,
  p_expected_head_version integer,
  p_outline_hash text,
  p_planner_version text,
  p_items jsonb
)
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  v_project_id text := lower(p_project_id);
  v_head_version integer;
  v_next_version integer;
  v_item_count integer;
  v_block_count integer;
begin
  perform 1 from public.learning_projects
  where project_id = v_project_id and owner_address = lower(p_owner)
    and status in ('UPLOADED', 'OUTLINING', 'OUTLINE_READY')
  for update;
  if not found then raise exception 'editable owned Learning Project not found'; end if;

  select max(version) into v_head_version
  from public.project_outline_versions where project_id = v_project_id;
  if p_expected_head_version is distinct from v_head_version then
    raise exception 'OUTLINE_VERSION_CONFLICT: current head is %', coalesce(v_head_version::text, 'none');
  end if;
  if jsonb_typeof(p_items) <> 'array' or jsonb_array_length(p_items) not between 1 and 16 then
    raise exception 'outline items must contain between 1 and 16 entries';
  end if;
  v_item_count := jsonb_array_length(p_items);
  select count(*)::integer into v_block_count from public.source_blocks where project_id = v_project_id;

  if exists (
    with ordered as (
      select item.position, item.start_block, item.end_block,
        lag(item.end_block) over (order by item.position) as previous_end
      from jsonb_to_recordset(p_items) as item(
        position integer, start_block integer, end_block integer
      )
    )
    select 1 from ordered
    where end_block < start_block
      or (position = 0 and start_block <> 0)
      or (position > 0 and start_block <> previous_end + 1)
      or (position = v_item_count - 1 and end_block <> v_block_count - 1)
  ) or (
    select count(distinct item.position)
    from jsonb_to_recordset(p_items) as item(position integer)
  ) <> v_item_count or exists (
    select 1 from jsonb_to_recordset(p_items) as item(position integer)
    where item.position < 0 or item.position >= v_item_count
  ) then
    raise exception 'Outline ranges must cover every Source Block exactly once';
  end if;

  v_next_version := coalesce(v_head_version, 0) + 1;
  update public.project_outline_versions set status = 'SUPERSEDED'
  where project_id = v_project_id and status = 'DRAFT';
  insert into public.project_outline_versions (
    project_id, version, status, outline_hash, planner_version
  ) values (v_project_id, v_next_version, 'DRAFT', lower(p_outline_hash), p_planner_version);
  insert into public.project_outline_items (
    project_id, outline_version, item_id, position, title, summary,
    start_block, end_block, page_start, page_end, source_hash, importance,
    min_card_count, target_card_count, max_card_count
  )
  select v_project_id, v_next_version, item.item_id, item.position, item.title, item.summary,
    item.start_block, item.end_block, item.page_start, item.page_end,
    lower(item.source_hash), item.importance, item.min_card_count,
    item.target_card_count, item.max_card_count
  from jsonb_to_recordset(p_items) as item(
    item_id text, position smallint, title text, summary text,
    start_block integer, end_block integer, page_start smallint, page_end smallint,
    source_hash text, importance smallint, min_card_count smallint,
    target_card_count smallint, max_card_count smallint
  );
  update public.learning_projects
  set status = 'OUTLINE_READY', outline_version = v_next_version,
      outline_hash = lower(p_outline_hash)
  where project_id = v_project_id;
  return v_next_version;
end;
$$;

create function public.confirm_project_outline_draft_v2(
  p_project_id text,
  p_owner text,
  p_outline_version integer,
  p_outline_hash text,
  p_work_unit_manifest_root text,
  p_chapters jsonb,
  p_work_units jsonb,
  p_creation_intent jsonb
)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare v_project_id text := lower(p_project_id);
begin
  perform 1 from public.project_outline_versions
  where project_id = v_project_id and version = p_outline_version
    and status = 'DRAFT' and outline_hash = lower(p_outline_hash)
  for update;
  if not found then raise exception 'current Outline Draft was not found'; end if;

  perform public.confirm_project_outline_v2(
    v_project_id, lower(p_owner), p_outline_version, lower(p_outline_hash),
    lower(p_work_unit_manifest_root), p_chapters, p_work_units
  );

  update public.chapters as chapters
  set min_card_count = item.min_card_count,
      target_card_count = item.target_card_count,
      max_card_count = item.max_card_count,
      card_policy_version = 1
  from jsonb_to_recordset(p_chapters) as item(
    chapter_id smallint, min_card_count smallint,
    target_card_count smallint, max_card_count smallint
  )
  where chapters.project_id = v_project_id and chapters.chapter_id = item.chapter_id;

  update public.work_units as units
  set card_minimum = item.card_minimum,
      card_target = item.card_target
  from jsonb_to_recordset(p_work_units) as item(
    work_unit_id smallint, card_minimum smallint, card_target smallint
  )
  where units.project_id = v_project_id and units.work_unit_id = item.work_unit_id;

  update public.project_outline_versions
  set status = 'CONFIRMED', confirmed_at = now()
  where project_id = v_project_id and version = p_outline_version;
  update public.learning_projects set creation_intent = p_creation_intent
  where project_id = v_project_id;
  return true;
end;
$$;

create or replace function public.claim_next_work_unit_v2(p_worker_address text)
returns setof public.work_units
language plpgsql
security definer
set search_path = public
as $$
declare
  v_project_id text;
  v_work_unit_id smallint;
  v_chapter_id smallint;
  v_status text;
begin
  if lower(p_worker_address) !~ '^0x[0-9a-f]{40}$' then raise exception 'invalid Worker address'; end if;
  select units.project_id, units.work_unit_id, units.chapter_id, units.status
  into v_project_id, v_work_unit_id, v_chapter_id, v_status
  from public.work_units as units
  join public.learning_projects as projects on projects.project_id = units.project_id
  join public.chapters as chapters
    on chapters.project_id = units.project_id and chapters.chapter_id = units.chapter_id
  where projects.status = 'GENERATING' and (
    (units.status in ('APPROVED', 'SUBMITTING') and units.worker_address = lower(p_worker_address))
    or (
      chapters.status in ('CONFIRMED', 'GENERATING', 'FAILED_RETRYABLE')
      and units.status in ('QUEUED', 'RETRYABLE', 'REPAIRING') and units.attempt < 3
    )
  )
  order by
    case units.status when 'SUBMITTING' then 0 when 'APPROVED' then 1
      when 'REPAIRING' then 2 when 'RETRYABLE' then 3 else 4 end,
    chapters.position, units.unit_index
  for update of units skip locked limit 1;
  if not found then return; end if;

  if v_status not in ('APPROVED', 'SUBMITTING') then
    update public.work_units
    set status = 'GENERATING', worker_address = lower(p_worker_address),
        attempt = attempt + 1, lease_until = now() + interval '90 seconds', last_error = null
    where project_id = v_project_id and work_unit_id = v_work_unit_id;
    update public.chapters set status = 'GENERATING', last_error = null
    where project_id = v_project_id and chapter_id = v_chapter_id
      and status in ('CONFIRMED', 'FAILED_RETRYABLE');
  end if;
  return query select * from public.work_units
  where project_id = v_project_id and work_unit_id = v_work_unit_id;
end;
$$;

create or replace function public.mark_work_unit_retryable_v2(
  p_project_id text, p_work_unit_id integer, p_error text
)
returns boolean language plpgsql security definer set search_path = public as $$
begin
  update public.work_units
  set status = case
        when cards_root is not null and status in ('APPROVED', 'SUBMITTING') then 'APPROVED'
        else 'RETRYABLE'
      end,
      lease_until = null, last_error = left(p_error, 500)
  where project_id = lower(p_project_id) and work_unit_id = p_work_unit_id::smallint
    and status <> 'CONFIRMED';
  return found;
end;
$$;

create function public.claim_next_chapter_quality_check_v2()
returns table (project_id text, chapter_id smallint)
language plpgsql security definer set search_path = public as $$
begin
  return query
  with candidate as (
    select chapters.project_id, chapters.chapter_id
    from public.chapters
    join public.learning_projects as projects on projects.project_id = chapters.project_id
    where projects.status = 'GENERATING'
      and chapters.status in ('GENERATING', 'FAILED_RETRYABLE')
      and exists (
        select 1 from public.work_units as units
        where units.project_id = chapters.project_id and units.chapter_id = chapters.chapter_id
      )
      and not exists (
        select 1 from public.work_units as units
        where units.project_id = chapters.project_id and units.chapter_id = chapters.chapter_id
          and units.status <> 'CANDIDATE_READY'
      )
    order by chapters.position for update of chapters skip locked limit 1
  )
  update public.chapters as chapters set status = 'QUALITY_CHECK', last_error = null
  from candidate
  where chapters.project_id = candidate.project_id and chapters.chapter_id = candidate.chapter_id
  returning chapters.project_id, chapters.chapter_id;
end;
$$;

create function public.approve_chapter_candidates_v2(
  p_project_id text, p_chapter_id integer, p_work_units jsonb
)
returns boolean
language plpgsql security definer set search_path = public as $$
declare
  v_project_id text := lower(p_project_id);
  v_expected_count integer;
  v_approved_count integer;
  v_min integer;
  v_max integer;
begin
  if jsonb_typeof(p_work_units) <> 'array' or jsonb_array_length(p_work_units) < 1 then
    raise exception 'approved Work Units must be a non-empty array';
  end if;
  select min_card_count, max_card_count into v_min, v_max from public.chapters
  where project_id = v_project_id and chapter_id = p_chapter_id::smallint
    and status = 'QUALITY_CHECK' for update;
  if not found then raise exception 'claimed Chapter quality check not found'; end if;
  select count(*)::integer into v_expected_count from public.work_units
  where project_id = v_project_id and chapter_id = p_chapter_id::smallint;
  if jsonb_array_length(p_work_units) <> v_expected_count or (
    select count(distinct item.work_unit_id)
    from jsonb_to_recordset(p_work_units) as item(work_unit_id integer)
  ) <> v_expected_count or exists (
    select 1
    from jsonb_to_recordset(p_work_units) as item(
      work_unit_id integer, worker_cards jsonb, cards_root text, card_count integer
    )
    left join public.work_units as units
      on units.project_id = v_project_id and units.work_unit_id = item.work_unit_id::smallint
    where units.work_unit_id is null or units.chapter_id <> p_chapter_id::smallint
      or units.status <> 'CANDIDATE_READY' or item.card_count < 1
      or jsonb_typeof(item.worker_cards) <> 'array'
      or jsonb_array_length(item.worker_cards) <> item.card_count
      or item.cards_root !~ '^0x[0-9a-f]{64}$'
  ) then raise exception 'Chapter candidate approval is incomplete or invalid'; end if;
  select sum(item.card_count)::integer into v_approved_count
  from jsonb_to_recordset(p_work_units) as item(card_count integer);
  if v_approved_count not between v_min and v_max then
    raise exception 'approved Chapter card count must be between % and %', v_min, v_max;
  end if;

  update public.work_units as units
  set worker_cards = item.worker_cards, cards_root = lower(item.cards_root),
      card_count = item.card_count::smallint, status = 'APPROVED', lease_until = null,
      last_error = null
  from jsonb_to_recordset(p_work_units) as item(
    work_unit_id integer, worker_cards jsonb, cards_root text, card_count integer
  )
  where units.project_id = v_project_id and units.work_unit_id = item.work_unit_id::smallint;
  update public.chapters set status = 'GENERATING', last_error = null
  where project_id = v_project_id and chapter_id = p_chapter_id::smallint;
  return true;
end;
$$;

create function public.request_chapter_candidate_repair_v2(
  p_project_id text, p_chapter_id integer, p_error text
)
returns boolean
language plpgsql security definer set search_path = public as $$
begin
  perform 1 from public.chapters
  where project_id = lower(p_project_id) and chapter_id = p_chapter_id::smallint
    and status = 'QUALITY_CHECK' for update;
  if not found then raise exception 'claimed Chapter quality check not found'; end if;
  update public.work_units
  set status = 'REPAIRING', attempt = 0, worker_cards = '[]'::jsonb,
      cards_root = null, card_count = null, commit_tx_hash = null,
      lease_until = null, last_error = left(p_error, 500)
  where project_id = lower(p_project_id) and chapter_id = p_chapter_id::smallint
    and status = 'CANDIDATE_READY';
  update public.chapters set status = 'GENERATING', last_error = left(p_error, 500)
  where project_id = lower(p_project_id) and chapter_id = p_chapter_id::smallint;
  return true;
end;
$$;

create or replace function public.confirm_work_unit_and_enqueue_reward_v2(
  p_project_id text, p_work_unit_id integer, p_tx_hash text, p_block_number bigint,
  p_gas_used numeric, p_confirmation_ms integer, p_treasury_address text, p_amount_wei numeric
)
returns boolean
language plpgsql security definer set search_path = public as $$
declare v_recipient text;
begin
  update public.work_units
  set status = 'CONFIRMED', commit_tx_hash = coalesce(lower(p_tx_hash), commit_tx_hash),
      confirmed_block = p_block_number, gas_used = p_gas_used,
      confirmation_ms = p_confirmation_ms, lease_until = null, last_error = null
  where project_id = lower(p_project_id) and work_unit_id = p_work_unit_id::smallint
    and status in ('APPROVED', 'SUBMITTING', 'CONFIRMED')
    and cards_root is not null and card_count > 0
  returning worker_address into v_recipient;
  if not found or v_recipient is null then
    raise exception 'approved Work Unit confirmation target or Worker is missing';
  end if;
  insert into public.work_unit_rewards (
    project_id, work_unit_id, treasury_address, recipient_address, amount_wei, status
  ) values (
    lower(p_project_id), p_work_unit_id::smallint, lower(p_treasury_address),
    lower(v_recipient), p_amount_wei, 'PENDING'
  ) on conflict (project_id, work_unit_id) do nothing;
  return true;
end;
$$;

create or replace function public.recover_stale_work_units_v2()
returns integer
language plpgsql security definer set search_path = public as $$
declare v_count integer;
begin
  update public.work_units
  set status = 'RETRYABLE', lease_until = null, last_error = 'generation lease expired'
  where status in ('GENERATING', 'VALIDATING') and lease_until < now() and attempt < 3;
  get diagnostics v_count = row_count;
  return v_count;
end;
$$;

create or replace function public.claim_next_chapter_assembly_v2()
returns table (project_id text, chapter_id smallint)
language plpgsql security definer set search_path = public as $$
begin
  return query
  with candidate as (
    select chapters.project_id, chapters.chapter_id
    from public.chapters
    join public.learning_projects as projects on projects.project_id = chapters.project_id
    where projects.status = 'GENERATING'
      and (
        chapters.status in ('GENERATING', 'FAILED_RETRYABLE')
        or (chapters.status = 'ASSEMBLING' and chapters.assembly_lease_until < now())
      )
      and exists (
        select 1 from public.work_units as units
        where units.project_id = chapters.project_id and units.chapter_id = chapters.chapter_id
      )
      and not exists (
        select 1 from public.work_units as units
        where units.project_id = chapters.project_id and units.chapter_id = chapters.chapter_id
          and units.status <> 'CONFIRMED'
      )
    order by chapters.position for update of chapters skip locked limit 1
  )
  update public.chapters as chapters
  set status = 'ASSEMBLING', assembly_attempt = least(chapters.assembly_attempt + 1, 10),
      assembly_lease_until = now() + interval '90 seconds', last_error = null
  from candidate
  where chapters.project_id = candidate.project_id and chapters.chapter_id = candidate.chapter_id
  returning chapters.project_id, chapters.chapter_id;
end;
$$;

create or replace function public.save_chapter_assembly_v2(
  p_project_id text, p_chapter_id integer, p_cards_root text, p_cards jsonb
)
returns boolean
language plpgsql security definer set search_path = public as $$
declare v_count integer; v_min integer; v_max integer;
begin
  if jsonb_typeof(p_cards) <> 'array' then raise exception 'Chapter cards must be an array'; end if;
  v_count := jsonb_array_length(p_cards);
  select min_card_count, max_card_count into v_min, v_max from public.chapters
  where project_id = lower(p_project_id) and chapter_id = p_chapter_id::smallint
    and status = 'ASSEMBLING' for update;
  if not found then raise exception 'claimed Chapter assembly not found'; end if;
  if v_count not between v_min and v_max then
    raise exception 'Chapter cards must contain between % and % entries', v_min, v_max;
  end if;
  if exists (
    select 1
    from jsonb_to_recordset(p_cards) as card(
      card_id text, project_id text, chapter_id integer, work_unit_id integer, position integer
    )
    left join public.work_units as units
      on units.project_id = lower(p_project_id) and units.work_unit_id = card.work_unit_id::smallint
    where units.work_unit_id is null or lower(card.project_id) <> lower(p_project_id)
      or card.chapter_id <> p_chapter_id or card.position < 0 or card.position >= v_count
      or units.chapter_id <> p_chapter_id::smallint or units.status <> 'CONFIRMED'
  ) then raise exception 'Chapter card provenance is invalid'; end if;
  delete from public.knowledge_cards
  where project_id = lower(p_project_id) and chapter_id = p_chapter_id::smallint;
  insert into public.knowledge_cards (
    card_id, project_id, chapter_id, work_unit_id, position, content,
    card_hash, worker_proof, chapter_proof
  )
  select lower(card.card_id), lower(p_project_id), p_chapter_id::smallint,
    card.work_unit_id::smallint, card.position::smallint, card.content,
    lower(card.card_hash), card.worker_proof, card.chapter_proof
  from jsonb_to_recordset(p_cards) as card(
    card_id text, work_unit_id integer, position integer, content jsonb,
    card_hash text, worker_proof jsonb, chapter_proof jsonb
  );
  update public.chapters set cards_root = lower(p_cards_root), card_count = v_count
  where project_id = lower(p_project_id) and chapter_id = p_chapter_id::smallint;
  return true;
end;
$$;

create or replace function public.mark_chapter_ready_v2(
  p_project_id text, p_chapter_id integer, p_tx_hash text
)
returns boolean
language plpgsql security definer set search_path = public as $$
begin
  update public.chapters
  set status = 'READY', finalize_tx_hash = coalesce(lower(p_tx_hash), finalize_tx_hash),
      assembly_lease_until = null, last_error = null
  where project_id = lower(p_project_id) and chapter_id = p_chapter_id::smallint
    and status in ('ASSEMBLING', 'READY') and cards_root is not null
    and card_count between min_card_count and max_card_count;
  if not found then raise exception 'assembled Chapter does not meet its card policy'; end if;
  update public.work_units set source_text = null, source_blocks = null, worker_cards = '[]'::jsonb
  where project_id = lower(p_project_id) and chapter_id = p_chapter_id::smallint;
  return true;
end;
$$;

create or replace function public.get_project_summaries_v2(
  p_owner text, p_now timestamptz default now()
)
returns table (
  project_id text, title text, goal text, status text, registry_version smallint,
  chapter_count bigint, ready_chapter_count bigint, card_count bigint,
  due_count bigint, updated_at timestamptz
)
language sql stable security definer set search_path = public as $$
  select projects.project_id, projects.title, projects.goal, projects.status,
    projects.registry_version, count(distinct chapters.chapter_id),
    count(distinct chapters.chapter_id) filter (where chapters.status = 'READY'),
    count(distinct cards.card_id),
    count(distinct states.card_id) filter (where states.reps > 0 and states.due_at <= p_now),
    projects.updated_at
  from public.learning_projects as projects
  left join public.chapters on chapters.project_id = projects.project_id
  left join public.knowledge_cards as cards on cards.project_id = projects.project_id
  left join public.card_learning_states as states
    on states.card_id = cards.card_id and states.owner_address = lower(p_owner)
  where projects.owner_address = lower(p_owner)
    and projects.status not in ('UPLOADED', 'OUTLINING', 'OUTLINE_READY')
  group by projects.project_id, projects.title, projects.goal, projects.status,
    projects.registry_version, projects.updated_at
  order by projects.updated_at desc;
$$;

create function public.submit_scoped_project_review_v2(
  p_project_id text,
  p_chapter_id integer,
  p_owner text,
  p_session_id uuid,
  p_card_id text,
  p_rating text,
  p_response_ms integer,
  p_reviewed_at timestamptz,
  p_expected_state jsonb,
  p_next_state jsonb,
  p_scope_type text
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_current_state jsonb;
  v_duplicate_state jsonb;
begin
  if p_scope_type not in ('CHAPTER', 'PROJECT') then raise exception 'invalid review scope'; end if;
  if p_rating not in ('again', 'hard', 'good', 'easy') then raise exception 'invalid review rating'; end if;
  if p_response_ms not between 0 and 3600000 then raise exception 'invalid response time'; end if;
  if jsonb_typeof(p_next_state) <> 'object' then raise exception 'next FSRS state must be an object'; end if;

  perform 1
  from public.knowledge_cards as cards
  join public.chapters on chapters.project_id = cards.project_id and chapters.chapter_id = cards.chapter_id
  join public.learning_projects as projects on projects.project_id = cards.project_id
  where cards.project_id = lower(p_project_id)
    and cards.chapter_id = p_chapter_id::smallint
    and cards.card_id = lower(p_card_id)
    and chapters.status = 'READY'
    and projects.owner_address = lower(p_owner);
  if not found then raise exception 'ready owned Chapter card not found'; end if;

  select fsrs_after into v_duplicate_state
  from public.project_review_logs
  where session_id = p_session_id and card_id = lower(p_card_id);
  if found then
    return jsonb_build_object(
      'accepted', true, 'duplicate', true, 'nextReviewAt', v_duplicate_state->>'due'
    );
  end if;

  insert into public.review_sessions (
    session_id, owner_address, project_id, scope_type, chapter_id, status
  ) values (
    p_session_id, lower(p_owner), lower(p_project_id), p_scope_type,
    case when p_scope_type = 'CHAPTER' then p_chapter_id::smallint else null end,
    'ACTIVE'
  ) on conflict (session_id) do nothing;

  perform 1 from public.review_sessions
  where session_id = p_session_id and owner_address = lower(p_owner)
    and project_id = lower(p_project_id) and scope_type = p_scope_type and status = 'ACTIVE'
    and (
      (p_scope_type = 'PROJECT' and chapter_id is null)
      or (p_scope_type = 'CHAPTER' and chapter_id = p_chapter_id::smallint)
    );
  if not found then raise exception 'active owned scoped session not found'; end if;

  select fsrs_state into v_current_state
  from public.card_learning_states
  where owner_address = lower(p_owner) and card_id = lower(p_card_id)
  for update;
  if v_current_state is distinct from p_expected_state then
    raise exception 'card learning state changed concurrently';
  end if;

  insert into public.project_review_logs (
    session_id, owner_address, project_id, chapter_id, card_id, rating,
    response_ms, reviewed_at, fsrs_before, fsrs_after
  ) values (
    p_session_id, lower(p_owner), lower(p_project_id), p_chapter_id::smallint,
    lower(p_card_id), p_rating, p_response_ms, p_reviewed_at,
    p_expected_state, p_next_state
  );

  insert into public.card_learning_states (
    owner_address, project_id, chapter_id, card_id, fsrs_state, due_at,
    reps, lapses, last_reviewed_at
  ) values (
    lower(p_owner), lower(p_project_id), p_chapter_id::smallint, lower(p_card_id),
    p_next_state, (p_next_state->>'due')::timestamptz,
    (p_next_state->>'reps')::integer, (p_next_state->>'lapses')::integer, p_reviewed_at
  ) on conflict (owner_address, card_id) do update
  set fsrs_state = excluded.fsrs_state,
      due_at = excluded.due_at,
      reps = excluded.reps,
      lapses = excluded.lapses,
      last_reviewed_at = excluded.last_reviewed_at;

  update public.review_sessions
  set reviewed_count = reviewed_count + 1,
      forgotten_count = forgotten_count + case when p_rating = 'again' then 1 else 0 end
  where session_id = p_session_id;

  return jsonb_build_object(
    'accepted', true, 'duplicate', false, 'nextReviewAt', p_next_state->>'due'
  );
end;
$$;

create or replace function public.complete_project_review_session_v2(
  p_owner text,
  p_session_id uuid
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_session public.review_sessions%rowtype;
  v_average integer;
begin
  select * into v_session from public.review_sessions
  where session_id = p_session_id and owner_address = lower(p_owner) for update;
  if not found then raise exception 'owned review session not found'; end if;
  select coalesce(round(avg(response_ms)), 0)::integer into v_average
  from public.project_review_logs where session_id = p_session_id;
  if v_session.status = 'ACTIVE' then
    update public.review_sessions
    set status = 'COMPLETED', average_response_ms = v_average, completed_at = now()
    where session_id = p_session_id returning * into v_session;
  end if;
  return jsonb_build_object(
    'sessionId', v_session.session_id,
    'reviewedCount', v_session.reviewed_count,
    'forgottenCount', v_session.forgotten_count,
    'averageResponseMs', coalesce(v_session.average_response_ms, v_average),
    'completedAt', v_session.completed_at
  );
end;
$$;

alter table public.project_outline_versions enable row level security;
alter table public.project_outline_items enable row level security;
alter table public.project_outline_versions force row level security;
alter table public.project_outline_items force row level security;
revoke all on table public.project_outline_versions from public;
revoke all on table public.project_outline_items from public;
revoke execute on function public.register_learning_project_source_v2(jsonb, jsonb) from public;
revoke execute on function public.save_project_outline_draft_v2(text, text, integer, text, text, jsonb) from public;
revoke execute on function public.confirm_project_outline_draft_v2(
  text, text, integer, text, text, jsonb, jsonb, jsonb
) from public;
revoke execute on function public.claim_next_chapter_quality_check_v2() from public;
revoke execute on function public.approve_chapter_candidates_v2(text, integer, jsonb) from public;
revoke execute on function public.request_chapter_candidate_repair_v2(text, integer, text) from public;
revoke execute on function public.submit_scoped_project_review_v2(
  text, integer, text, uuid, text, text, integer, timestamptz, jsonb, jsonb, text
) from public;

do $$
begin
  if exists (select 1 from pg_roles where rolname = 'anon') then
    revoke all on table public.project_outline_versions from anon;
    revoke all on table public.project_outline_items from anon;
  end if;
  if exists (select 1 from pg_roles where rolname = 'authenticated') then
    revoke all on table public.project_outline_versions from authenticated;
    revoke all on table public.project_outline_items from authenticated;
  end if;
  if exists (select 1 from pg_roles where rolname = 'service_role') then
    grant all on table public.project_outline_versions to service_role;
    grant all on table public.project_outline_items to service_role;
    grant execute on function public.register_learning_project_source_v2(jsonb, jsonb) to service_role;
    grant execute on function public.save_project_outline_draft_v2(text, text, integer, text, text, jsonb)
      to service_role;
    grant execute on function public.confirm_project_outline_draft_v2(
      text, text, integer, text, text, jsonb, jsonb, jsonb
    ) to service_role;
    grant execute on function public.claim_next_chapter_quality_check_v2() to service_role;
    grant execute on function public.approve_chapter_candidates_v2(text, integer, jsonb) to service_role;
    grant execute on function public.request_chapter_candidate_repair_v2(text, integer, text) to service_role;
    grant execute on function public.submit_scoped_project_review_v2(
      text, integer, text, uuid, text, text, integer, timestamptz, jsonb, jsonb, text
    ) to service_role;
  end if;
end;
$$;

commit;
