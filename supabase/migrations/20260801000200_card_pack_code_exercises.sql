begin;

-- Code-heavy packs use a separate publisher contract so the original v1
-- release remains immutable while new exercise fields are preserved.
create function public.publish_card_pack_v2(
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
  if v_chapter_count not between 1 and 16 or v_card_count not between 1 and 200 then
    raise exception 'Card Pack size is invalid';
  end if;
  if exists (
    select 1
    from jsonb_array_elements(p_chapters) as chapter(value)
    cross join lateral jsonb_array_elements(chapter.value->'cards') as card(value)
    where card.value->>'type' not in (
      'concept', 'qa', 'comparison', 'process', 'application', 'misconception',
      'code_read', 'code_write', 'code_complete', 'code_debug', 'output_trace', 'security_review'
    )
    or card.value->'sourceReference'->>'kind' <> 'pack_reference'
    or (
      card.value->>'type' in ('code_read', 'code_write', 'code_complete', 'code_debug', 'output_trace', 'security_review')
      and jsonb_typeof(card.value->'code') is distinct from 'object'
    )
    or (
      card.value->>'type' not in ('code_read', 'code_write', 'code_complete', 'code_debug', 'output_trace', 'security_review')
      and card.value ? 'code'
    )
  ) then
    raise exception 'Card Pack contains an invalid code exercise';
  end if;
  if exists (
    select 1
    from jsonb_array_elements(p_chapters) as chapter(value)
    where not exists (
      select 1 from jsonb_array_elements(chapter.value->'cards') as card(value)
      where card.value->>'type' in ('code_read', 'code_write', 'code_complete', 'code_debug', 'output_trace', 'security_review')
    )
  ) then
    raise exception 'Every Card Pack Chapter must contain a code exercise';
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

  insert into public.card_packs (
    slug, title, description, subject, language, level, status, owner_type
  ) values (
    p_manifest->>'slug', p_manifest->>'title', p_manifest->>'description',
    p_manifest->>'subject', p_manifest->>'language', p_manifest->>'level', 'DRAFT', 'SYSTEM'
  ) on conflict (slug) do nothing;
  select pack_id into v_pack_id from public.card_packs where slug = p_manifest->>'slug' for update;
  update public.card_packs
  set title = p_manifest->>'title', description = p_manifest->>'description',
      subject = p_manifest->>'subject', language = p_manifest->>'language',
      level = p_manifest->>'level', updated_at = now()
  where pack_id = v_pack_id;

  insert into public.card_pack_versions (
    pack_id, version, manifest_hash, content_hash, card_count, chapter_count,
    license, attribution, status
  ) values (
    v_pack_id, p_manifest->>'version', p_manifest_hash, p_content_hash,
    v_card_count, v_chapter_count, p_manifest->>'license', p_manifest->>'attribution', 'DRAFT'
  ) returning pack_version_id into v_pack_version_id;

  insert into public.card_pack_chapters (
    pack_version_id, chapter_id, position, slug, title, summary, estimated_minutes, card_count
  ) select
    v_pack_version_id, (chapter.value->>'chapterId')::smallint,
    (chapter.value->>'position')::smallint, chapter.value->>'slug', chapter.value->>'title',
    chapter.value->>'summary', (chapter.value->>'estimatedMinutes')::smallint,
    jsonb_array_length(chapter.value->'cards')::smallint
  from jsonb_array_elements(p_chapters) as chapter(value);

  insert into public.card_pack_cards (
    pack_card_id, pack_version_id, chapter_id, position, content, content_hash, source_reference
  ) select
    card.value->>'packCardId', v_pack_version_id, (chapter.value->>'chapterId')::smallint,
    (card.value->>'position')::smallint,
    jsonb_strip_nulls(jsonb_build_object(
      'type', card.value->>'type', 'question', card.value->>'question',
      'answer', card.value->>'answer', 'keyPoint', card.value->>'keyPoint',
      'source', card.value->'sourceReference', 'tags', card.value->'tags',
      'importance', (card.value->>'importance')::integer,
      'initialDifficulty', (card.value->>'initialDifficulty')::integer,
      'code', card.value->'code'
    )),
    '0x' || md5(card.value::text) || md5('MINDMARK_PACK_CARD_V2:' || card.value::text),
    card.value->'sourceReference'
  from jsonb_array_elements(p_chapters) as chapter(value)
  cross join lateral jsonb_array_elements(chapter.value->'cards') as card(value);

  update public.card_pack_versions
  set status = 'PUBLISHED', published_at = now()
  where pack_version_id = v_pack_version_id;
  update public.card_packs set status = 'PUBLISHED' where pack_id = v_pack_id;
  return v_pack_version_id;
end;
$$;

-- The catalog shows the newest release by default. A learner who already
-- installed an older release can still see that installed version.
create or replace function public.list_published_card_packs_v1(p_owner text default null)
returns jsonb
language sql
stable
security definer
set search_path = public
as $$
  select jsonb_build_object(
    'packs', coalesce(jsonb_agg(jsonb_build_object(
      'packId', packs.pack_id,
      'packVersionId', versions.pack_version_id,
      'slug', packs.slug,
      'title', packs.title,
      'description', packs.description,
      'subject', packs.subject,
      'language', packs.language,
      'level', packs.level,
      'version', versions.version,
      'chapterCount', versions.chapter_count,
      'cardCount', versions.card_count,
      'estimatedMinutes', (
        select coalesce(sum(chapters.estimated_minutes), 0)
        from public.card_pack_chapters as chapters
        where chapters.pack_version_id = versions.pack_version_id
      ),
      'license', versions.license,
      'attribution', versions.attribution,
      'installedProjectId', case when p_owner is null then null else (
        select installations.project_id
        from public.card_pack_installations as installations
        where installations.owner_address = lower(p_owner)
          and installations.pack_version_id = versions.pack_version_id
      ) end
    ) order by versions.published_at desc), '[]'::jsonb)
  )
  from public.card_pack_versions as versions
  join public.card_packs as packs on packs.pack_id = versions.pack_id
  where versions.status = 'PUBLISHED' and packs.status = 'PUBLISHED'
    and (
      not exists (
        select 1 from public.card_pack_versions as newer
        where newer.pack_id = versions.pack_id
          and newer.status = 'PUBLISHED'
          and newer.published_at > versions.published_at
      )
      or (p_owner is not null and exists (
        select 1 from public.card_pack_installations as installations
        where installations.owner_address = lower(p_owner)
          and installations.pack_version_id = versions.pack_version_id
      ))
    );
$$;

revoke execute on function public.publish_card_pack_v2(jsonb, jsonb, text, text) from public;
revoke execute on function public.list_published_card_packs_v1(text) from public;
do $$
begin
  if exists (select 1 from pg_roles where rolname = 'service_role') then
    grant execute on function public.publish_card_pack_v2(jsonb, jsonb, text, text) to service_role;
    grant execute on function public.list_published_card_packs_v1(text) to service_role;
  end if;
end;
$$;

commit;
