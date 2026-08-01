begin;

drop index if exists public.learning_projects_owner_source_unique_idx;

create index if not exists learning_projects_owner_source_idx
  on public.learning_projects (owner_address, source_hash);

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

comment on function public.register_learning_project_source_v2(jsonb, jsonb) is
  'Registers one Learning Project per owner-scoped client request; identical source content may back multiple Projects.';

commit;
