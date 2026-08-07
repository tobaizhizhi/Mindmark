begin;

create table public.card_packs (
  pack_id uuid primary key default gen_random_uuid(),
  slug text not null unique check (slug ~ '^[a-z0-9]+(-[a-z0-9]+)*$'),
  title text not null check (char_length(btrim(title)) between 1 and 200),
  description text not null check (char_length(btrim(description)) between 1 and 1000),
  subject text not null check (char_length(btrim(subject)) between 1 and 100),
  language text not null check (language ~ '^[a-z]{2}(-[A-Z]{2})?$'),
  level text not null check (level in ('beginner', 'intermediate', 'advanced')),
  status text not null check (status in ('DRAFT', 'PUBLISHED', 'RETIRED')),
  owner_type text not null check (owner_type in ('SYSTEM', 'CONTRIBUTOR')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table public.card_pack_versions (
  pack_version_id uuid primary key default gen_random_uuid(),
  pack_id uuid not null references public.card_packs(pack_id) on delete restrict,
  version text not null check (version ~ '^\d+\.\d+\.\d+$'),
  manifest_hash text not null check (manifest_hash ~ '^0x[0-9a-f]{64}$'),
  content_hash text not null check (content_hash ~ '^0x[0-9a-f]{64}$'),
  card_count smallint not null check (card_count between 1 and 200),
  chapter_count smallint not null check (chapter_count between 1 and 16),
  license text not null check (char_length(btrim(license)) between 1 and 100),
  attribution text not null check (char_length(btrim(attribution)) between 1 and 300),
  status text not null check (status in ('DRAFT', 'PUBLISHED', 'RETIRED')),
  published_at timestamptz,
  created_at timestamptz not null default now(),
  unique (pack_id, version),
  check ((status = 'DRAFT' and published_at is null) or (status <> 'DRAFT' and published_at is not null))
);

create table public.card_pack_chapters (
  pack_version_id uuid not null references public.card_pack_versions(pack_version_id) on delete restrict,
  chapter_id smallint not null check (chapter_id between 0 and 15),
  position smallint not null check (position between 0 and 15),
  slug text not null check (slug ~ '^[a-z0-9]+(-[a-z0-9]+)*$'),
  title text not null check (char_length(btrim(title)) between 1 and 200),
  summary text not null check (char_length(btrim(summary)) between 1 and 500),
  estimated_minutes smallint not null check (estimated_minutes between 1 and 600),
  card_count smallint not null check (card_count between 5 and 30),
  primary key (pack_version_id, chapter_id),
  unique (pack_version_id, position),
  unique (pack_version_id, slug)
);

create table public.card_pack_cards (
  pack_card_id text primary key check (pack_card_id ~ '^[a-z0-9]+(-[a-z0-9]+)*$'),
  pack_version_id uuid not null,
  chapter_id smallint not null,
  position smallint not null check (position between 0 and 199),
  content jsonb not null check (
    jsonb_typeof(content) = 'object'
    and content->'source'->>'kind' = 'pack_reference'
  ),
  content_hash text not null check (content_hash ~ '^0x[0-9a-f]{64}$'),
  source_reference jsonb not null check (
    jsonb_typeof(source_reference) = 'object'
    and source_reference->>'kind' = 'pack_reference'
  ),
  unique (pack_version_id, chapter_id, position),
  foreign key (pack_version_id, chapter_id)
    references public.card_pack_chapters(pack_version_id, chapter_id) on delete restrict
);

alter table public.learning_projects
  add column project_kind text not null default 'UPLOAD'
    check (project_kind in ('UPLOAD', 'PACK')),
  add column pack_version_id uuid references public.card_pack_versions(pack_version_id) on delete restrict,
  add constraint learning_projects_content_origin_check check (
    (project_kind = 'UPLOAD' and pack_version_id is null)
    or (project_kind = 'PACK' and pack_version_id is not null)
  );

alter table public.chapters
  alter column start_block drop not null,
  alter column end_block drop not null,
  alter column page_start drop not null,
  alter column page_end drop not null,
  add column pack_chapter_id smallint,
  add constraint chapters_content_origin_check check (
    (pack_chapter_id is null and start_block is not null and end_block is not null
      and page_start is not null and page_end is not null)
    or (pack_chapter_id is not null and start_block is null and end_block is null
      and page_start is null and page_end is null)
  );

alter table public.knowledge_cards
  alter column work_unit_id drop not null,
  add column origin_type text not null default 'WORK_UNIT'
    check (origin_type in ('WORK_UNIT', 'PACK')),
  add column origin_pack_card_id text references public.card_pack_cards(pack_card_id) on delete restrict,
  add constraint knowledge_cards_content_origin_check check (
    (origin_type = 'WORK_UNIT' and work_unit_id is not null and origin_pack_card_id is null)
    or (origin_type = 'PACK' and work_unit_id is null and origin_pack_card_id is not null)
  );

create table public.card_pack_installations (
  installation_id uuid primary key default gen_random_uuid(),
  owner_address text not null check (owner_address ~ '^0x[0-9a-f]{40}$'),
  pack_version_id uuid not null references public.card_pack_versions(pack_version_id) on delete restrict,
  project_id text not null unique references public.learning_projects(project_id) on delete cascade,
  folder_id uuid references public.project_folders(folder_id) on delete restrict,
  installed_at timestamptz not null default now(),
  last_opened_at timestamptz,
  unique (owner_address, pack_version_id)
);

create index card_pack_versions_catalog_idx
  on public.card_pack_versions (status, published_at desc);
create index card_pack_cards_chapter_idx
  on public.card_pack_cards (pack_version_id, chapter_id, position);
create index card_pack_installations_owner_idx
  on public.card_pack_installations (owner_address, installed_at desc);
create index learning_projects_kind_owner_idx
  on public.learning_projects (project_kind, owner_address, updated_at desc);

create trigger card_packs_set_updated_at
before update on public.card_packs
for each row execute function public.set_updated_at();

create function public.reject_published_card_pack_mutation_v1()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  if tg_table_name = 'card_pack_versions' then
    if old.status in ('PUBLISHED', 'RETIRED') and (
      new.pack_id is distinct from old.pack_id
      or new.version is distinct from old.version
      or new.manifest_hash is distinct from old.manifest_hash
      or new.content_hash is distinct from old.content_hash
      or new.card_count is distinct from old.card_count
      or new.chapter_count is distinct from old.chapter_count
      or new.license is distinct from old.license
      or new.attribution is distinct from old.attribution
      or new.published_at is distinct from old.published_at
    ) then
      raise exception 'published Card Pack Versions are immutable';
    end if;
  elsif exists (
    select 1 from public.card_pack_versions as versions
    where versions.pack_version_id = old.pack_version_id
      and versions.status in ('PUBLISHED', 'RETIRED')
  ) then
    raise exception 'published Card Pack content is immutable';
  end if;
  if tg_op = 'DELETE' then return old; end if;
  return new;
end;
$$;

create trigger card_pack_versions_reject_published_mutation
before update on public.card_pack_versions
for each row execute function public.reject_published_card_pack_mutation_v1();
create trigger card_pack_chapters_reject_published_mutation
before update or delete on public.card_pack_chapters
for each row execute function public.reject_published_card_pack_mutation_v1();
create trigger card_pack_cards_reject_published_mutation
before update or delete on public.card_pack_cards
for each row execute function public.reject_published_card_pack_mutation_v1();

create function public.enforce_pack_project_isolation_v1()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  if new.project_kind = 'PACK' and (
    new.status not in ('READY', 'CANCELLED')
    or new.pack_version_id is null
    or new.work_unit_manifest_root is not null
    or new.creation_intent is not null
    or new.create_tx_hash is not null
    or new.finalize_tx_hash is not null
  ) then
    raise exception 'PACK Project cannot enter the AI or Monad execution lifecycle';
  end if;
  return new;
end;
$$;

create trigger learning_projects_enforce_pack_isolation
before insert or update on public.learning_projects
for each row execute function public.enforce_pack_project_isolation_v1();

create function public.reject_pack_execution_record_v1()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  if exists (
    select 1 from public.learning_projects
    where project_id = new.project_id and project_kind = 'PACK'
  ) then
    raise exception 'PACK Project cannot create Work Units or Workflow Jobs';
  end if;
  return new;
end;
$$;

create trigger work_units_reject_pack_project
before insert or update of project_id on public.work_units
for each row execute function public.reject_pack_execution_record_v1();
create trigger workflow_jobs_reject_pack_project
before insert or update of project_id on public.workflow_jobs
for each row execute function public.reject_pack_execution_record_v1();

create or replace function public.queue_chapter_workflow_v2()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if new.status = 'READY' and (tg_op = 'INSERT' or old.status is distinct from new.status)
    and exists (
      select 1 from public.learning_projects
      where project_id = new.project_id and project_kind = 'UPLOAD'
    )
    and exists (
      select 1 from public.chapters where project_id = new.project_id
    )
    and not exists (
      select 1 from public.chapters where project_id = new.project_id and status <> 'READY'
    ) then
    perform public.enqueue_workflow_job_v2(new.project_id, 'FINALIZE_PROJECT');
  end if;
  return new;
end;
$$;

create function public.publish_card_pack_v1(
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
    or jsonb_typeof(p_chapters) <> 'array' then
    raise exception 'Card Pack manifest and Chapters must be structured JSON';
  end if;
  if p_manifest_hash !~ '^0x[0-9a-f]{64}$' or p_content_hash !~ '^0x[0-9a-f]{64}$' then
    raise exception 'Card Pack hashes must be lowercase bytes32 values';
  end if;
  v_chapter_count := jsonb_array_length(p_chapters);
  if v_chapter_count not between 1 and 16
    or jsonb_array_length(p_manifest->'chapters') <> v_chapter_count then
    raise exception 'Card Pack Chapter count is invalid';
  end if;
  select coalesce(sum(jsonb_array_length(chapter.value->'cards')), 0)::integer
  into v_card_count from jsonb_array_elements(p_chapters) as chapter(value);
  if v_card_count not between 1 and 200 then raise exception 'Card Pack card count is invalid'; end if;

  if (
    select count(distinct (chapter.value->>'chapterId')::integer)
    from jsonb_array_elements(p_chapters) as chapter(value)
  ) <> v_chapter_count or exists (
    select 1 from jsonb_array_elements(p_chapters) as chapter(value)
    where (chapter.value->>'chapterId')::integer <> (chapter.value->>'position')::integer
      or (chapter.value->>'chapterId')::integer not between 0 and v_chapter_count - 1
      or jsonb_typeof(chapter.value->'cards') <> 'array'
      or jsonb_array_length(chapter.value->'cards') not between 5 and 30
  ) then
    raise exception 'Card Pack Chapter IDs and positions must be contiguous';
  end if;

  if exists (
    select 1
    from jsonb_array_elements(p_chapters) as chapter(value)
    cross join lateral jsonb_array_elements(chapter.value->'cards') as card(value)
    where (card.value->>'position')::integer < 0
      or (card.value->>'position')::integer >= jsonb_array_length(chapter.value->'cards')
      or card.value->>'type' not in ('concept', 'qa', 'comparison', 'process', 'application', 'misconception')
      or card.value->'sourceReference'->>'kind' <> 'pack_reference'
  ) or exists (
    select 1
    from jsonb_array_elements(p_chapters) as chapter(value)
    cross join lateral (
      select count(*) as total, count(distinct (card.value->>'position')::integer) as positions
      from jsonb_array_elements(chapter.value->'cards') as card(value)
    ) as counts
    where counts.total <> counts.positions
  ) then
    raise exception 'Card Pack Cards have invalid positions, types, or references';
  end if;
  if exists (
    select 1
    from jsonb_array_elements(p_chapters) as chapter(value)
    where not exists (
      select 1 from jsonb_array_elements(chapter.value->'cards') as card(value)
      where card.value->>'type' in ('concept', 'qa')
    )
    or not exists (
      select 1 from jsonb_array_elements(chapter.value->'cards') as card(value)
      where card.value->>'type' in ('comparison', 'process')
    )
    or not exists (
      select 1 from jsonb_array_elements(chapter.value->'cards') as card(value)
      where card.value->>'type' = 'application'
    )
    or not exists (
      select 1 from jsonb_array_elements(chapter.value->'cards') as card(value)
      where card.value->>'type' = 'misconception'
    )
  ) then
    raise exception 'Every Card Pack Chapter must cover concepts, comparison or process, application, and misconception';
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
    jsonb_build_object(
      'type', card.value->>'type', 'question', card.value->>'question',
      'answer', card.value->>'answer', 'keyPoint', card.value->>'keyPoint',
      'source', card.value->'sourceReference', 'tags', card.value->'tags',
      'importance', (card.value->>'importance')::integer,
      'initialDifficulty', (card.value->>'initialDifficulty')::integer
    ),
    '0x' || md5(card.value::text) || md5('MINDMARK_PACK_CARD_V1:' || card.value::text),
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

create function public.install_card_pack_v1(
  p_owner text,
  p_pack_version_id uuid,
  p_folder_id uuid default null
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_owner text := lower(p_owner);
  v_version record;
  v_existing public.card_pack_installations%rowtype;
  v_project_id text;
  v_installation_id uuid;
begin
  if v_owner !~ '^0x[0-9a-f]{40}$' then raise exception 'invalid Card Pack owner'; end if;
  if p_folder_id is not null and not exists (
    select 1 from public.project_folders
    where folder_id = p_folder_id and owner_address = v_owner
  ) then
    raise exception 'destination folder was not found';
  end if;

  select versions.*, packs.title, packs.description
  into v_version
  from public.card_pack_versions as versions
  join public.card_packs as packs on packs.pack_id = versions.pack_id
  where versions.pack_version_id = p_pack_version_id
    and versions.status = 'PUBLISHED' and packs.status = 'PUBLISHED'
  for update of versions;
  if not found then raise exception 'Card Pack Version is not available'; end if;

  select * into v_existing from public.card_pack_installations
  where owner_address = v_owner and pack_version_id = p_pack_version_id;
  if found then
    return jsonb_build_object(
      'installationId', v_existing.installation_id,
      'projectId', v_existing.project_id,
      'projectKind', 'PACK', 'packVersionId', p_pack_version_id,
      'status', 'READY', 'chapterCount', v_version.chapter_count,
      'cardCount', v_version.card_count, 'idempotent', true
    );
  end if;

  v_project_id := '0x'
    || md5('MINDMARK_PACK_PROJECT_V1:' || v_owner || ':' || p_pack_version_id::text)
    || md5('MINDMARK_PACK_PROJECT_V1_SECOND_HALF:' || v_owner || ':' || p_pack_version_id::text);

  insert into public.learning_projects (
    project_id, owner_address, title, goal, source_hash, goal_hash, outline_version,
    outline_hash, registry_version, status, total_card_count, folder_id,
    project_kind, pack_version_id
  ) values (
    v_project_id, v_owner, v_version.title, left(v_version.description, 500),
    v_version.content_hash, v_version.manifest_hash, 1, v_version.manifest_hash,
    2, 'READY', v_version.card_count, p_folder_id, 'PACK', p_pack_version_id
  );

  insert into public.chapters (
    project_id, chapter_id, position, title, summary, start_block, end_block,
    page_start, page_end, source_hash, importance, status, card_count,
    min_card_count, target_card_count, max_card_count, pack_chapter_id
  ) select
    v_project_id, chapters.chapter_id, chapters.position, chapters.title, chapters.summary,
    null, null, null, null, v_version.content_hash, 4, 'READY', chapters.card_count,
    least(2, chapters.card_count), chapters.card_count, chapters.card_count, chapters.chapter_id
  from public.card_pack_chapters as chapters
  where chapters.pack_version_id = p_pack_version_id
  order by chapters.position;

  insert into public.knowledge_cards (
    card_id, project_id, chapter_id, work_unit_id, position, content, card_hash,
    worker_proof, chapter_proof, origin_type, origin_pack_card_id
  ) select
    '0x' || md5('MINDMARK_PACK_CARD_INSTANCE_V1:' || v_project_id || ':' || cards.pack_card_id)
      || md5('MINDMARK_PACK_CARD_INSTANCE_V1_SECOND_HALF:' || v_project_id || ':' || cards.pack_card_id),
    v_project_id, cards.chapter_id, null, cards.position, cards.content,
    cards.content_hash, '[]'::jsonb, '[]'::jsonb, 'PACK', cards.pack_card_id
  from public.card_pack_cards as cards
  where cards.pack_version_id = p_pack_version_id
  order by cards.chapter_id, cards.position;

  insert into public.card_pack_installations (
    owner_address, pack_version_id, project_id, folder_id
  ) values (
    v_owner, p_pack_version_id, v_project_id, p_folder_id
  ) returning installation_id into v_installation_id;

  return jsonb_build_object(
    'installationId', v_installation_id, 'projectId', v_project_id,
    'projectKind', 'PACK', 'packVersionId', p_pack_version_id,
    'status', 'READY', 'chapterCount', v_version.chapter_count,
    'cardCount', v_version.card_count, 'idempotent', false
  );
end;
$$;

create function public.list_published_card_packs_v1(p_owner text default null)
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
  where versions.status = 'PUBLISHED' and packs.status = 'PUBLISHED';
$$;

create function public.get_published_card_pack_v1(
  p_pack_version_id uuid,
  p_owner text default null
)
returns jsonb
language sql
stable
security definer
set search_path = public
as $$
  select jsonb_build_object(
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
    ) end,
    'chapters', coalesce((
      select jsonb_agg(jsonb_build_object(
        'chapterId', chapters.chapter_id,
        'position', chapters.position,
        'slug', chapters.slug,
        'title', chapters.title,
        'summary', chapters.summary,
        'estimatedMinutes', chapters.estimated_minutes,
        'cardCount', chapters.card_count,
        'cards', coalesce((
          select jsonb_agg(
            jsonb_build_object('packCardId', cards.pack_card_id, 'position', cards.position)
              || cards.content
            order by cards.position
          )
          from public.card_pack_cards as cards
          where cards.pack_version_id = chapters.pack_version_id
            and cards.chapter_id = chapters.chapter_id
        ), '[]'::jsonb)
      ) order by chapters.position)
      from public.card_pack_chapters as chapters
      where chapters.pack_version_id = versions.pack_version_id
    ), '[]'::jsonb)
  )
  from public.card_pack_versions as versions
  join public.card_packs as packs on packs.pack_id = versions.pack_id
  where versions.pack_version_id = p_pack_version_id
    and versions.status = 'PUBLISHED' and packs.status = 'PUBLISHED';
$$;

create function public.delete_card_pack_installation_v1(
  p_owner text,
  p_installation_id uuid
)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare
  v_owner text := lower(p_owner);
  v_project_id text;
begin
  if v_owner !~ '^0x[0-9a-f]{40}$' then raise exception 'invalid Card Pack owner'; end if;
  select project_id into v_project_id
  from public.card_pack_installations
  where installation_id = p_installation_id and owner_address = v_owner
  for update;
  if not found then raise exception 'Card Pack installation was not found'; end if;
  delete from public.learning_projects where project_id = v_project_id;
  return true;
end;
$$;

create or replace function public.get_document_library_v2(
  p_owner text,
  p_folder_id uuid default null,
  p_now timestamptz default now()
)
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_owner text := lower(p_owner);
  v_result jsonb;
begin
  if p_folder_id is not null and not exists (
    select 1 from public.project_folders
    where folder_id = p_folder_id and owner_address = v_owner
  ) then
    raise exception 'folder was not found';
  end if;

  select jsonb_build_object(
    'folders', coalesce((
      select jsonb_agg(jsonb_build_object(
        'folderId', folders.folder_id,
        'name', folders.name,
        'parentFolderId', folders.parent_folder_id,
        'documentCount', (
          select count(*) from public.learning_projects as child_projects
          where child_projects.folder_id = folders.folder_id
            and child_projects.owner_address = v_owner
        ),
        'updatedAt', folders.updated_at
      ) order by lower(folders.name))
      from public.project_folders as folders
      where folders.owner_address = v_owner
    ), '[]'::jsonb),
    'documents', coalesce((
      select jsonb_agg(jsonb_build_object(
        'projectId', projects.project_id,
        'folderId', projects.folder_id,
        'title', projects.title,
        'projectKind', projects.project_kind,
        'packVersionId', projects.pack_version_id,
        'sourceFilename', projects.source_filename,
        'sourceMimeType', projects.source_mime_type,
        'sourcePageCount', projects.source_page_count,
        'status', projects.status,
        'chapterCount', (
          select count(*) from public.chapters
          where chapters.project_id = projects.project_id
        ),
        'readyChapterCount', (
          select count(*) from public.chapters
          where chapters.project_id = projects.project_id and chapters.status = 'READY'
        ),
        'cardCount', (
          select count(*) from public.knowledge_cards
          where knowledge_cards.project_id = projects.project_id
        ),
        'dueCount', (
          select count(*)
          from public.card_learning_states
          where card_learning_states.project_id = projects.project_id
            and card_learning_states.owner_address = v_owner
            and card_learning_states.reps > 0
            and card_learning_states.due_at <= p_now
        ),
        'updatedAt', projects.updated_at
      ) order by projects.updated_at desc)
      from public.learning_projects as projects
      where projects.owner_address = v_owner
        and projects.folder_id is not distinct from p_folder_id
        and projects.status <> 'CANCELLED'
    ), '[]'::jsonb)
  ) into v_result;
  return v_result;
end;
$$;

drop function public.get_project_summaries_v2(text, timestamptz);
create function public.get_project_summaries_v2(
  p_owner text,
  p_now timestamptz default now()
)
returns table (
  project_id text,
  title text,
  goal text,
  status text,
  project_kind text,
  pack_version_id uuid,
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
    projects.project_kind,
    projects.pack_version_id,
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
    projects.project_kind, projects.pack_version_id, projects.registry_version, projects.updated_at
  order by projects.updated_at desc;
$$;

alter table public.card_packs enable row level security;
alter table public.card_pack_versions enable row level security;
alter table public.card_pack_chapters enable row level security;
alter table public.card_pack_cards enable row level security;
alter table public.card_pack_installations enable row level security;
alter table public.card_packs force row level security;
alter table public.card_pack_versions force row level security;
alter table public.card_pack_chapters force row level security;
alter table public.card_pack_cards force row level security;
alter table public.card_pack_installations force row level security;

revoke all on table public.card_packs from public;
revoke all on table public.card_pack_versions from public;
revoke all on table public.card_pack_chapters from public;
revoke all on table public.card_pack_cards from public;
revoke all on table public.card_pack_installations from public;
revoke execute on function public.publish_card_pack_v1(jsonb, jsonb, text, text) from public;
revoke execute on function public.install_card_pack_v1(text, uuid, uuid) from public;
revoke execute on function public.list_published_card_packs_v1(text) from public;
revoke execute on function public.get_published_card_pack_v1(uuid, text) from public;
revoke execute on function public.delete_card_pack_installation_v1(text, uuid) from public;
revoke execute on function public.get_project_summaries_v2(text, timestamptz) from public;

do $$
begin
  if exists (select 1 from pg_roles where rolname = 'anon') then
    revoke all on table public.card_packs from anon;
    revoke all on table public.card_pack_versions from anon;
    revoke all on table public.card_pack_chapters from anon;
    revoke all on table public.card_pack_cards from anon;
    revoke all on table public.card_pack_installations from anon;
  end if;
  if exists (select 1 from pg_roles where rolname = 'authenticated') then
    revoke all on table public.card_packs from authenticated;
    revoke all on table public.card_pack_versions from authenticated;
    revoke all on table public.card_pack_chapters from authenticated;
    revoke all on table public.card_pack_cards from authenticated;
    revoke all on table public.card_pack_installations from authenticated;
  end if;
  if exists (select 1 from pg_roles where rolname = 'service_role') then
    grant all on table public.card_packs to service_role;
    grant all on table public.card_pack_versions to service_role;
    grant all on table public.card_pack_chapters to service_role;
    grant all on table public.card_pack_cards to service_role;
    grant all on table public.card_pack_installations to service_role;
    grant execute on function public.publish_card_pack_v1(jsonb, jsonb, text, text) to service_role;
    grant execute on function public.install_card_pack_v1(text, uuid, uuid) to service_role;
    grant execute on function public.list_published_card_packs_v1(text) to service_role;
    grant execute on function public.get_published_card_pack_v1(uuid, text) to service_role;
    grant execute on function public.delete_card_pack_installation_v1(text, uuid) to service_role;
    grant execute on function public.get_project_summaries_v2(text, timestamptz) to service_role;
  end if;
end;
$$;

comment on table public.card_pack_versions is
  'Immutable published Card Pack releases. User review state never belongs to this table.';
comment on function public.install_card_pack_v1(text, uuid, uuid) is
  'Atomically copies one published Card Pack Version into an owner-scoped READY PACK Learning Project.';

commit;
