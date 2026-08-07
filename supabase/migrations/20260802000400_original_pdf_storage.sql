begin;

alter table public.learning_projects
  add column source_storage_bucket text,
  add column source_storage_path text,
  add column source_file_sha256 text check (
    source_file_sha256 is null or source_file_sha256 ~ '^[0-9a-f]{64}$'
  ),
  add column source_file_size bigint check (
    source_file_size is null or source_file_size between 1 and 15728640
  ),
  add column source_file_status text not null default 'MISSING' check (
    source_file_status in ('MISSING', 'UPLOADING', 'READY', 'FAILED')
  ),
  add constraint learning_projects_source_storage_path_check check (
    source_storage_path is null or (
      source_storage_path like '%' || project_id || '/source.pdf'
      and source_storage_bucket = 'learning-source-files'
    )
  );

create unique index learning_projects_source_storage_path_unique_idx
  on public.learning_projects (source_storage_path)
  where source_storage_path is not null;

do $$
begin
  if to_regclass('storage.buckets') is not null then
    execute $sql$
      insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
      values ('learning-source-files', 'learning-source-files', false, 15728640, array['application/pdf']::text[])
      on conflict (id) do update set
        public = excluded.public,
        file_size_limit = excluded.file_size_limit,
        allowed_mime_types = excluded.allowed_mime_types
    $sql$;
  end if;
end
$$;

commit;

notify pgrst, 'reload schema';
