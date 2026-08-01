begin;

create function public.enforce_blueprint_chapter_capacity_v3()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  if exists (
    select 1
    from (
      select distinct project_id, chapter_id, design_run_id
      from inserted_blueprint_slots
    ) as touched
    join public.chapters as chapters
      on chapters.project_id = touched.project_id
      and chapters.chapter_id = touched.chapter_id
    cross join lateral (
      select count(*)::integer as slot_count
      from public.card_blueprint_slots as slots
      where slots.project_id = touched.project_id
        and slots.chapter_id = touched.chapter_id
        and slots.design_run_id = touched.design_run_id
    ) as counts
    where counts.slot_count < chapters.min_card_count
      or counts.slot_count > chapters.max_card_count
  ) then
    raise exception 'V3 Card Blueprint Slot count is outside Chapter capacity';
  end if;
  return null;
end;
$$;

create trigger card_blueprint_slots_enforce_chapter_capacity
after insert on public.card_blueprint_slots
referencing new table as inserted_blueprint_slots
for each statement execute function public.enforce_blueprint_chapter_capacity_v3();

create function public.enforce_blueprint_work_unit_capacity_v3()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  if exists (
    select 1
    from (
      select distinct assigned.project_id, assigned.assigned_work_unit_id
      from assigned_blueprint_slots as assigned
      join previous_blueprint_slots as previous
        on previous.project_id = assigned.project_id
        and previous.chapter_id = assigned.chapter_id
        and previous.design_run_id = assigned.design_run_id
        and previous.slot_id = assigned.slot_id
      where assigned.assigned_work_unit_id is not null
        and assigned.assigned_work_unit_id is distinct from previous.assigned_work_unit_id
    ) as touched
    cross join lateral (
      select count(*)::integer as slot_count
      from public.card_blueprint_slots as slots
      where slots.project_id = touched.project_id
        and slots.assigned_work_unit_id = touched.assigned_work_unit_id
    ) as counts
    where counts.slot_count > 8
  ) then
    raise exception 'V3 Work Unit cannot contain more than 8 Blueprint Slots';
  end if;
  return null;
end;
$$;

create trigger card_blueprint_slots_enforce_work_unit_capacity
after update on public.card_blueprint_slots
referencing old table as previous_blueprint_slots new table as assigned_blueprint_slots
for each statement execute function public.enforce_blueprint_work_unit_capacity_v3();

revoke all on function public.enforce_blueprint_chapter_capacity_v3() from public;
revoke all on function public.enforce_blueprint_work_unit_capacity_v3() from public;

commit;
