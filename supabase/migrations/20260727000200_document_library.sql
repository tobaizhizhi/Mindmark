begin;

create table public.project_folders (
  folder_id uuid primary key default gen_random_uuid(),
  owner_address text not null check (owner_address ~ '^0x[0-9a-f]{40}$'),
  name text not null check (char_length(btrim(name)) between 1 and 100),
  parent_folder_id uuid references public.project_folders(folder_id) on delete restrict,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create unique index project_folders_owner_parent_name_unique_idx
  on public.project_folders (
    owner_address,
    coalesce(parent_folder_id, '00000000-0000-0000-0000-000000000000'::uuid),
    lower(name)
  );
create index project_folders_owner_parent_idx
  on public.project_folders (owner_address, parent_folder_id, updated_at desc);

alter table public.learning_projects
  add column folder_id uuid references public.project_folders(folder_id) on delete restrict;
create index learning_projects_owner_folder_updated_idx
  on public.learning_projects (owner_address, folder_id, updated_at desc);

create trigger project_folders_set_updated_at
before update on public.project_folders
for each row execute function public.set_updated_at();

create function public.create_project_folder_v2(
  p_owner text,
  p_name text,
  p_parent_folder_id uuid default null
)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_owner text := lower(p_owner);
  v_name text := btrim(p_name);
  v_folder_id uuid;
begin
  if v_owner !~ '^0x[0-9a-f]{40}$' then raise exception 'invalid folder owner'; end if;
  if char_length(v_name) not between 1 and 100 then raise exception 'folder name must contain 1 to 100 characters'; end if;
  if p_parent_folder_id is not null and not exists (
    select 1 from public.project_folders
    where folder_id = p_parent_folder_id and owner_address = v_owner
  ) then
    raise exception 'parent folder was not found';
  end if;

  insert into public.project_folders (owner_address, name, parent_folder_id)
  values (v_owner, v_name, p_parent_folder_id)
  returning folder_id into v_folder_id;
  return v_folder_id;
end;
$$;

create function public.rename_project_folder_v2(
  p_owner text,
  p_folder_id uuid,
  p_name text
)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare
  v_name text := btrim(p_name);
begin
  if char_length(v_name) not between 1 and 100 then raise exception 'folder name must contain 1 to 100 characters'; end if;
  update public.project_folders
  set name = v_name
  where folder_id = p_folder_id and owner_address = lower(p_owner);
  if not found then raise exception 'folder was not found'; end if;
  return true;
end;
$$;

create function public.move_learning_project_to_folder_v2(
  p_owner text,
  p_project_id text,
  p_folder_id uuid default null
)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare
  v_owner text := lower(p_owner);
begin
  if p_folder_id is not null and not exists (
    select 1 from public.project_folders
    where folder_id = p_folder_id and owner_address = v_owner
  ) then
    raise exception 'destination folder was not found';
  end if;
  update public.learning_projects
  set folder_id = p_folder_id
  where project_id = lower(p_project_id) and owner_address = v_owner;
  if not found then raise exception 'Learning Project was not found'; end if;
  return true;
end;
$$;

create function public.delete_project_folder_v2(
  p_owner text,
  p_folder_id uuid
)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
begin
  if not exists (
    select 1 from public.project_folders
    where folder_id = p_folder_id and owner_address = lower(p_owner)
  ) then
    raise exception 'folder was not found';
  end if;
  if exists (select 1 from public.project_folders where parent_folder_id = p_folder_id)
    or exists (select 1 from public.learning_projects where folder_id = p_folder_id) then
    raise exception 'folder is not empty';
  end if;
  delete from public.project_folders
  where folder_id = p_folder_id and owner_address = lower(p_owner);
  if not found then raise exception 'folder was not found'; end if;
  return true;
end;
$$;

create function public.get_document_library_v2(
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

create or replace function public.register_learning_project_source_v2(
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
  v_folder_id uuid := nullif(p_project->>'folder_id', '')::uuid;
  v_existing public.learning_projects%rowtype;
  v_block_count integer;
begin
  if v_folder_id is not null and not exists (
    select 1 from public.project_folders
    where folder_id = v_folder_id and owner_address = v_owner
  ) then
    raise exception 'destination folder was not found';
  end if;
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
    source_mime_type, source_page_count, source_character_count, folder_id
  ) values (
    v_project_id, v_owner, v_request_id, btrim(p_project->>'title'),
    nullif(btrim(p_project->>'goal'), ''), v_source_hash, lower(p_project->>'goal_hash'),
    1, null, 2, 'UPLOADED', nullif(btrim(p_project->>'source_filename'), ''),
    nullif(btrim(p_project->>'source_mime_type'), ''),
    (p_project->>'source_page_count')::smallint,
    (p_project->>'source_character_count')::integer,
    v_folder_id
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

alter table public.project_folders enable row level security;
alter table public.project_folders force row level security;
revoke all on table public.project_folders from public;
revoke execute on function public.create_project_folder_v2(text, text, uuid) from public;
revoke execute on function public.rename_project_folder_v2(text, uuid, text) from public;
revoke execute on function public.move_learning_project_to_folder_v2(text, text, uuid) from public;
revoke execute on function public.delete_project_folder_v2(text, uuid) from public;
revoke execute on function public.get_document_library_v2(text, uuid, timestamptz) from public;
revoke execute on function public.register_learning_project_source_v2(jsonb, jsonb) from public;

do $$
begin
  if exists (select 1 from pg_roles where rolname = 'anon') then
    revoke all on table public.project_folders from anon;
  end if;
  if exists (select 1 from pg_roles where rolname = 'authenticated') then
    revoke all on table public.project_folders from authenticated;
  end if;
  if exists (select 1 from pg_roles where rolname = 'service_role') then
    grant all on table public.project_folders to service_role;
    grant execute on function public.create_project_folder_v2(text, text, uuid) to service_role;
    grant execute on function public.rename_project_folder_v2(text, uuid, text) to service_role;
    grant execute on function public.move_learning_project_to_folder_v2(text, text, uuid) to service_role;
    grant execute on function public.delete_project_folder_v2(text, uuid) to service_role;
    grant execute on function public.get_document_library_v2(text, uuid, timestamptz) to service_role;
    grant execute on function public.register_learning_project_source_v2(jsonb, jsonb) to service_role;
  end if;
end;
$$;

commit;
