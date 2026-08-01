begin;

create table public.project_outline_exclusions (
  project_id text not null,
  outline_version integer not null,
  exclusion_index smallint not null check (exclusion_index between 0 and 255),
  start_block integer not null check (start_block between 0 and 65535),
  end_block integer not null check (end_block between start_block and 65535),
  category text not null check (category in (
    'REPEATED_HEADER_FOOTER', 'PAGE_NUMBER', 'TABLE_OF_CONTENTS',
    'COPYRIGHT', 'PROMOTIONAL', 'ADMINISTRATIVE',
    'EXAM_UPDATE', 'VERSION_NOTICE', 'SCHEDULE_NOTICE', 'OTHER'
  )),
  reason text not null check (char_length(reason) between 1 and 300),
  primary key (project_id, outline_version, exclusion_index),
  foreign key (project_id, outline_version)
    references public.project_outline_versions(project_id, version) on delete cascade
);

create index project_outline_exclusions_lookup_idx
  on public.project_outline_exclusions (project_id, outline_version, start_block);

create function public.validate_outline_learning_ranges_v3(
  p_items jsonb,
  p_exclusions jsonb,
  p_block_count integer
)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_item_count integer;
begin
  if p_block_count < 1 then raise exception 'Project has no Source Blocks'; end if;
  if jsonb_typeof(p_items) <> 'array' or jsonb_array_length(p_items) not between 1 and 16 then
    raise exception 'outline items must contain between 1 and 16 entries';
  end if;
  if jsonb_typeof(p_exclusions) <> 'array' or jsonb_array_length(p_exclusions) > 256 then
    raise exception 'outline exclusions must contain at most 256 entries';
  end if;
  v_item_count := jsonb_array_length(p_items);

  if (
    select count(distinct item.position)
    from jsonb_to_recordset(p_items) as item(position integer)
  ) <> v_item_count or exists (
    select 1 from jsonb_to_recordset(p_items) as item(position integer)
    where item.position < 0 or item.position >= v_item_count
  ) then
    raise exception 'Outline positions must be unique and contiguous';
  end if;

  if exists (
    with ordered as (
      select item.position, item.start_block, item.end_block,
        lag(item.end_block) over (order by item.position) as previous_end
      from jsonb_to_recordset(p_items) as item(
        position integer, start_block integer, end_block integer
      )
    )
    select 1 from ordered
    where start_block is null or end_block is null
      or start_block < 0 or end_block >= p_block_count
      or end_block < start_block
      or (position > 0 and start_block <= previous_end)
  ) then raise exception 'Chapter ranges must be ordered and non-overlapping'; end if;

  if exists (
    with ordered as (
      select item.start_block, item.end_block,
        lag(item.end_block) over (order by item.start_block, item.end_block) as previous_end
      from jsonb_to_recordset(p_exclusions) as item(
        start_block integer, end_block integer, category text, reason text
      )
    )
    select 1 from ordered
    where start_block is null or end_block is null
      or start_block < 0 or end_block >= p_block_count
      or end_block < start_block
      or (previous_end is not null and start_block <= previous_end)
  ) then raise exception 'Outline exclusion ranges must be ordered and non-overlapping'; end if;

  if exists (
    select 1
    from jsonb_to_recordset(p_items) as item(start_block integer, end_block integer)
    where not exists (
      select 1
      from generate_series(item.start_block, item.end_block) as block(block_index)
      where not exists (
        select 1
        from jsonb_to_recordset(p_exclusions) as exclusion(
          start_block integer, end_block integer, category text, reason text
        )
        where block.block_index between exclusion.start_block and exclusion.end_block
      )
    )
  ) then raise exception 'Every Chapter must contain a learning Source Block'; end if;

  if exists (
    select 1
    from generate_series(0, p_block_count - 1) as block(block_index)
    where not exists (
      select 1
      from jsonb_to_recordset(p_exclusions) as exclusion(
        start_block integer, end_block integer, category text, reason text
      )
      where block.block_index between exclusion.start_block and exclusion.end_block
    )
    and (
      select count(*)
      from jsonb_to_recordset(p_items) as item(start_block integer, end_block integer)
      where block.block_index between item.start_block and item.end_block
    ) <> 1
  ) then raise exception 'Every learning Source Block must belong to exactly one Chapter'; end if;
end;
$$;

create function public.save_project_outline_draft_v2(
  p_project_id text,
  p_owner text,
  p_expected_head_version integer,
  p_outline_hash text,
  p_planner_version text,
  p_items jsonb,
  p_exclusions jsonb
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
  select count(*)::integer into v_block_count from public.source_blocks where project_id = v_project_id;
  perform public.validate_outline_learning_ranges_v3(p_items, p_exclusions, v_block_count);

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
  insert into public.project_outline_exclusions (
    project_id, outline_version, exclusion_index, start_block, end_block, category, reason
  )
  select v_project_id, v_next_version, entry.exclusion_index::smallint,
    item.start_block, item.end_block, item.category, item.reason
  from jsonb_array_elements(p_exclusions) with ordinality as entry(value, exclusion_index)
  cross join lateral jsonb_to_record(entry.value) as item(
    start_block integer, end_block integer, category text, reason text
  );
  update public.learning_projects
  set status = 'OUTLINE_READY', outline_version = v_next_version,
      outline_hash = lower(p_outline_hash)
  where project_id = v_project_id;
  return v_next_version;
end;
$$;

drop function public.confirm_project_outline_design_v3(text, text, integer, text, jsonb);

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
  v_exclusions jsonb;
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
  v_chapter_count := jsonb_array_length(p_chapters);
  select count(*)::integer into v_block_count
  from public.source_blocks where project_id = v_project_id;
  select coalesce(jsonb_agg(jsonb_build_object(
    'start_block', start_block, 'end_block', end_block,
    'category', category, 'reason', reason
  ) order by exclusion_index), '[]'::jsonb)
  into v_exclusions
  from public.project_outline_exclusions
  where project_id = v_project_id and outline_version = p_outline_version;
  perform public.validate_outline_learning_ranges_v3(p_chapters, v_exclusions, v_block_count);

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

alter table public.project_outline_exclusions enable row level security;
alter table public.project_outline_exclusions force row level security;
revoke all on table public.project_outline_exclusions from public;
revoke execute on function public.validate_outline_learning_ranges_v3(jsonb, jsonb, integer) from public;
revoke execute on function public.save_project_outline_draft_v2(text, text, integer, text, text, jsonb, jsonb) from public;
revoke execute on function public.confirm_project_outline_design_v3(text, text, integer, text, jsonb) from public;

do $$
begin
  if exists (select 1 from pg_roles where rolname = 'anon') then
    revoke all on table public.project_outline_exclusions from anon;
  end if;
  if exists (select 1 from pg_roles where rolname = 'authenticated') then
    revoke all on table public.project_outline_exclusions from authenticated;
  end if;
  if exists (select 1 from pg_roles where rolname = 'service_role') then
    grant all on table public.project_outline_exclusions to service_role;
    grant execute on function public.validate_outline_learning_ranges_v3(jsonb, jsonb, integer) to service_role;
    grant execute on function public.save_project_outline_draft_v2(text, text, integer, text, text, jsonb, jsonb) to service_role;
    grant execute on function public.confirm_project_outline_design_v3(text, text, integer, text, jsonb) to service_role;
  end if;
end;
$$;

notify pgrst, 'reload schema';

commit;
