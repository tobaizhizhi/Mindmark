begin;

create table public.card_pack_chapter_reading_blocks (
  pack_version_id uuid not null references public.card_pack_versions(pack_version_id) on delete restrict,
  chapter_id smallint not null,
  block_id text not null check (block_id ~ '^[a-z0-9]+(?:-[a-z0-9]+)*$'),
  position smallint not null check (position between 0 and 199),
  kind text not null check (kind in ('heading', 'paragraph', 'code', 'callout')),
  text text not null check (char_length(btrim(text)) between 1 and 30000),
  language text,
  primary key (pack_version_id, chapter_id, block_id),
  unique (pack_version_id, chapter_id, position),
  foreign key (pack_version_id, chapter_id)
    references public.card_pack_chapters(pack_version_id, chapter_id) on delete restrict,
  check ((kind = 'code' and language is not null) or (kind <> 'code' and language is null))
);

create index card_pack_reading_blocks_order_idx
  on public.card_pack_chapter_reading_blocks (pack_version_id, chapter_id, position);

create function public.reject_published_card_pack_reading_block_mutation_v1()
returns trigger
language plpgsql
set search_path = public
as $$
declare
  v_pack_version_id uuid := case when tg_op = 'DELETE' then old.pack_version_id else new.pack_version_id end;
begin
  if exists (
    select 1 from public.card_pack_versions as versions
    where versions.pack_version_id = v_pack_version_id
      and versions.status in ('PUBLISHED', 'RETIRED')
  ) then
    raise exception 'published Card Pack reading content is immutable';
  end if;
  if tg_op = 'DELETE' then return old; end if;
  return new;
end;
$$;

create trigger card_pack_reading_blocks_reject_published_mutation
before insert or update or delete on public.card_pack_chapter_reading_blocks
for each row execute function public.reject_published_card_pack_reading_block_mutation_v1();

create or replace function public.publish_card_pack_v5(
  p_manifest jsonb,
  p_chapters jsonb,
  p_manifest_hash text,
  p_content_hash text
)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_pack_id uuid;
  v_pack_version_id uuid;
  v_chapter_count integer;
  v_card_count integer;
  v_existing public.card_pack_versions%rowtype;
begin
  if jsonb_typeof(p_manifest) <> 'object'
    or jsonb_typeof(p_manifest->'chapters') <> 'array'
    or jsonb_typeof(p_chapters) <> 'array'
    or p_manifest_hash !~ '^0x[0-9a-f]{64}$'
    or p_content_hash !~ '^0x[0-9a-f]{64}$' then
    raise exception 'Card Pack manifest, chapters, or hashes are invalid';
  end if;

  v_chapter_count := jsonb_array_length(p_chapters);
  select coalesce(sum(jsonb_array_length(chapter.value->'cards')), 0)::integer
  into v_card_count
  from jsonb_array_elements(p_chapters) as chapter(value);
  if v_chapter_count not between 1 and 16
    or jsonb_array_length(p_manifest->'chapters') <> v_chapter_count
    or v_card_count not between 1 and 200 then
    raise exception 'Card Pack size is invalid';
  end if;

  if exists (
    select 1
    from jsonb_array_elements(p_chapters) as chapter(value)
    where (chapter.value->>'chapterId')::integer <> (chapter.value->>'position')::integer
      or (chapter.value->>'chapterId')::integer not between 0 and v_chapter_count - 1
      or jsonb_typeof(chapter.value->'cards') <> 'array'
      or jsonb_array_length(chapter.value->'cards') not between 5 and 30
      or jsonb_typeof(chapter.value->'readingBlocks') <> 'array'
      or jsonb_array_length(chapter.value->'readingBlocks') not between 1 and 200
      or jsonb_typeof(chapter.value->'learningObjectives') is distinct from 'array'
      or jsonb_typeof(chapter.value->'prerequisiteChapterIds') is distinct from 'array'
      or jsonb_typeof(chapter.value->'stageId') is distinct from 'number'
      or jsonb_typeof(chapter.value->'stageTitle') is distinct from 'string'
      or jsonb_typeof(chapter.value->'newConcepts') is distinct from 'array'
      or jsonb_typeof(chapter.value->'prerequisiteConcepts') is distinct from 'array'
      or jsonb_typeof(chapter.value->'practiceFocus') is distinct from 'string'
      or jsonb_typeof(chapter.value->'projectMilestone') is distinct from 'string'
      or exists (
        select 1
        from jsonb_array_elements(chapter.value->'cards') as card(value)
        where card.value->>'readingBlockId' is null
          or not exists (
            select 1 from jsonb_array_elements(chapter.value->'readingBlocks') as block(value)
            where block.value->>'blockId' = card.value->>'readingBlockId'
          )
      )
  ) then
    raise exception 'Readable Card Pack Chapter metadata or anchors are invalid';
  end if;

  if exists (
    select 1
    from jsonb_array_elements(p_chapters) as chapter(value)
    cross join lateral jsonb_array_elements(chapter.value->'cards') as card(value)
    where (card.value->>'position')::integer < 0
      or (card.value->>'position')::integer >= jsonb_array_length(chapter.value->'cards')
      or card.value->>'type' not in (
        'concept', 'qa', 'comparison', 'process', 'application', 'misconception',
        'code_read', 'code_write', 'code_complete', 'code_debug', 'output_trace', 'security_review'
      )
      or card.value->'sourceReference'->>'kind' <> 'pack_reference'
      or (card.value->>'type' in ('code_read', 'code_write', 'code_complete', 'code_debug', 'output_trace', 'security_review') and jsonb_typeof(card.value->'code') is distinct from 'object')
      or (card.value->>'type' not in ('code_read', 'code_write', 'code_complete', 'code_debug', 'output_trace', 'security_review') and card.value ? 'code')
  ) then
    raise exception 'Card Pack contains an invalid code exercise';
  end if;

  select versions.* into v_existing
  from public.card_pack_versions as versions
  join public.card_packs as packs on packs.pack_id = versions.pack_id
  where packs.slug = p_manifest->>'slug' and versions.version = p_manifest->>'version';
  if found then
    if v_existing.manifest_hash <> p_manifest_hash or v_existing.content_hash <> p_content_hash then
      raise exception 'Card Pack Version already exists with different content';
    end if;
    return v_existing.pack_version_id;
  end if;

  insert into public.card_packs (slug, title, description, subject, language, level, status, owner_type)
  values (p_manifest->>'slug', p_manifest->>'title', p_manifest->>'description', p_manifest->>'subject', p_manifest->>'language', p_manifest->>'level', 'DRAFT', 'SYSTEM')
  on conflict (slug) do nothing;
  select pack_id into v_pack_id from public.card_packs where slug = p_manifest->>'slug' for update;
  update public.card_packs
  set title = p_manifest->>'title', description = p_manifest->>'description', subject = p_manifest->>'subject', language = p_manifest->>'language', level = p_manifest->>'level', updated_at = now()
  where pack_id = v_pack_id;

  insert into public.card_pack_versions (pack_id, version, manifest_hash, content_hash, card_count, chapter_count, license, attribution, status)
  values (v_pack_id, p_manifest->>'version', p_manifest_hash, p_content_hash, v_card_count, v_chapter_count, p_manifest->>'license', p_manifest->>'attribution', 'DRAFT')
  returning pack_version_id into v_pack_version_id;

  insert into public.card_pack_chapters (
    pack_version_id, chapter_id, position, slug, title, summary, estimated_minutes, card_count,
    learning_objectives, prerequisite_chapter_ids, stage_id, stage_title, new_concepts,
    prerequisite_concepts, practice_focus, project_milestone
  ) select
    v_pack_version_id, (chapter.value->>'chapterId')::smallint, (chapter.value->>'position')::smallint,
    chapter.value->>'slug', chapter.value->>'title', chapter.value->>'summary', (chapter.value->>'estimatedMinutes')::smallint,
    jsonb_array_length(chapter.value->'cards')::smallint, chapter.value->'learningObjectives', chapter.value->'prerequisiteChapterIds',
    (chapter.value->>'stageId')::smallint, chapter.value->>'stageTitle', chapter.value->'newConcepts', chapter.value->'prerequisiteConcepts',
    chapter.value->>'practiceFocus', chapter.value->>'projectMilestone'
  from jsonb_array_elements(p_chapters) as chapter(value);

  insert into public.card_pack_chapter_reading_blocks (pack_version_id, chapter_id, block_id, position, kind, text, language)
  select v_pack_version_id, (chapter.value->>'chapterId')::smallint, block.value->>'blockId', (block.value->>'position')::smallint,
    block.value->>'kind', block.value->>'text', block.value->>'language'
  from jsonb_array_elements(p_chapters) as chapter(value)
  cross join lateral jsonb_array_elements(chapter.value->'readingBlocks') as block(value);

  insert into public.card_pack_cards (pack_card_id, pack_version_id, chapter_id, position, content, content_hash, source_reference)
  select card.value->>'packCardId', v_pack_version_id, (chapter.value->>'chapterId')::smallint, (card.value->>'position')::smallint,
    jsonb_strip_nulls(jsonb_build_object(
      'type', card.value->>'type', 'question', card.value->>'question', 'answer', card.value->>'answer', 'keyPoint', card.value->>'keyPoint',
      'source', card.value->'sourceReference', 'tags', card.value->'tags', 'importance', (card.value->>'importance')::integer,
      'initialDifficulty', (card.value->>'initialDifficulty')::integer, 'readingBlockId', card.value->>'readingBlockId', 'code', card.value->'code'
    )), '0x' || md5(card.value::text) || md5('MINDMARK_PACK_CARD_V5:' || card.value::text), card.value->'sourceReference'
  from jsonb_array_elements(p_chapters) as chapter(value)
  cross join lateral jsonb_array_elements(chapter.value->'cards') as card(value);

  update public.card_pack_versions set status = 'PUBLISHED', published_at = now() where pack_version_id = v_pack_version_id;
  update public.card_packs set status = 'PUBLISHED' where pack_id = v_pack_id;
  return v_pack_version_id;
end;
$$;

create or replace function public.get_published_card_pack_v1(p_pack_version_id uuid, p_owner text default null)
returns jsonb language sql stable security definer set search_path = public as $$
  select jsonb_build_object(
    'packId', packs.pack_id, 'packVersionId', versions.pack_version_id, 'slug', packs.slug, 'title', packs.title,
    'description', packs.description, 'subject', packs.subject, 'language', packs.language, 'level', packs.level,
    'version', versions.version, 'chapterCount', versions.chapter_count, 'cardCount', versions.card_count,
    'estimatedMinutes', (select coalesce(sum(chapters.estimated_minutes), 0) from public.card_pack_chapters as chapters where chapters.pack_version_id = versions.pack_version_id),
    'license', versions.license, 'attribution', versions.attribution,
    'installedProjectId', case when p_owner is null then null else (select installations.project_id from public.card_pack_installations as installations where installations.owner_address = lower(p_owner) and installations.pack_version_id = versions.pack_version_id) end,
    'chapters', coalesce((select jsonb_agg(jsonb_strip_nulls(jsonb_build_object(
      'chapterId', chapters.chapter_id, 'position', chapters.position, 'slug', chapters.slug, 'title', chapters.title, 'summary', chapters.summary,
      'estimatedMinutes', chapters.estimated_minutes, 'learningObjectives', chapters.learning_objectives, 'prerequisiteChapterIds', chapters.prerequisite_chapter_ids,
      'stageId', chapters.stage_id, 'stageTitle', chapters.stage_title, 'newConcepts', chapters.new_concepts, 'prerequisiteConcepts', chapters.prerequisite_concepts,
      'practiceFocus', chapters.practice_focus, 'projectMilestone', chapters.project_milestone, 'cardCount', chapters.card_count,
      'readingBlocks', coalesce((select jsonb_agg(jsonb_build_object('blockId', blocks.block_id, 'position', blocks.position, 'kind', blocks.kind, 'text', blocks.text) || case when blocks.language is null then '{}'::jsonb else jsonb_build_object('language', blocks.language) end order by blocks.position) from public.card_pack_chapter_reading_blocks as blocks where blocks.pack_version_id = chapters.pack_version_id and blocks.chapter_id = chapters.chapter_id), '[]'::jsonb),
      'cards', coalesce((select jsonb_agg(jsonb_build_object('packCardId', cards.pack_card_id, 'position', cards.position) || cards.content order by cards.position) from public.card_pack_cards as cards where cards.pack_version_id = chapters.pack_version_id and cards.chapter_id = chapters.chapter_id), '[]'::jsonb)
    )) order by chapters.position) from public.card_pack_chapters as chapters where chapters.pack_version_id = versions.pack_version_id), '[]'::jsonb)
  ) from public.card_pack_versions as versions join public.card_packs as packs on packs.pack_id = versions.pack_id
  where versions.pack_version_id = p_pack_version_id and versions.status = 'PUBLISHED' and packs.status = 'PUBLISHED';
$$;

alter table public.card_pack_chapter_reading_blocks enable row level security;
alter table public.card_pack_chapter_reading_blocks force row level security;
revoke all on table public.card_pack_chapter_reading_blocks from public;
revoke execute on function public.publish_card_pack_v5(jsonb, jsonb, text, text) from public;
do $$
begin
  if exists (select 1 from pg_roles where rolname = 'service_role') then
    grant all on table public.card_pack_chapter_reading_blocks to service_role;
    grant execute on function public.publish_card_pack_v5(jsonb, jsonb, text, text) to service_role;
  end if;
end;
$$;

commit;
