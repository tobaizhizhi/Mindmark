begin;

create or replace function public.mark_project_ready_v2(
  p_project_id text,
  p_project_deck_root text,
  p_initial_plan jsonb,
  p_initial_plan_hash text,
  p_total_card_count integer,
  p_tx_hash text
)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
begin
  update public.learning_projects
  set status = 'READY', project_deck_root = lower(p_project_deck_root),
      initial_plan = p_initial_plan, initial_plan_hash = lower(p_initial_plan_hash),
      total_card_count = p_total_card_count::smallint,
      finalize_tx_hash = coalesce(lower(p_tx_hash), finalize_tx_hash),
      runner_lease_until = null, last_error = null
  where project_id = lower(p_project_id) and status in ('FINALIZING', 'READY');
  if not found then raise exception 'finalizing Project not found'; end if;
  return true;
end;
$$;

comment on function public.mark_project_ready_v2(text, text, jsonb, text, integer, text) is
  'Marks a finalized Project ready while retaining Source Block text for reading and grounded AI tutoring.';

commit;

notify pgrst, 'reload schema';
