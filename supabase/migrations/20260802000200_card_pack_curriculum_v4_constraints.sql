begin;

-- The v4 migration may already have been applied through the Supabase SQL API.
-- Add the same table constraints idempotently so managed environments converge.
do $$
begin
  if not exists (
    select 1 from pg_constraint
    where conname = 'card_pack_chapters_stage_id_v4_check'
      and conrelid = 'public.card_pack_chapters'::regclass
  ) then
    alter table public.card_pack_chapters
      add constraint card_pack_chapters_stage_id_v4_check
      check (stage_id is null or stage_id between 0 and 7);
  end if;
  if not exists (
    select 1 from pg_constraint
    where conname = 'card_pack_chapters_new_concepts_v4_check'
      and conrelid = 'public.card_pack_chapters'::regclass
  ) then
    alter table public.card_pack_chapters
      add constraint card_pack_chapters_new_concepts_v4_check
      check (new_concepts is null or jsonb_typeof(new_concepts) = 'array');
  end if;
  if not exists (
    select 1 from pg_constraint
    where conname = 'card_pack_chapters_prerequisite_concepts_v4_check'
      and conrelid = 'public.card_pack_chapters'::regclass
  ) then
    alter table public.card_pack_chapters
      add constraint card_pack_chapters_prerequisite_concepts_v4_check
      check (prerequisite_concepts is null or jsonb_typeof(prerequisite_concepts) = 'array');
  end if;
end;
$$;

commit;
