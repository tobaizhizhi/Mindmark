begin;

-- This is deliberately aggregate-only: no source text, card content, learner reason,
-- correction, prompt, or model transcript is included in the operations payload.
create function public.get_learning_quality_operations_v3()
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_feedback jsonb;
  v_chapters jsonb;
  v_slots jsonb;
  v_failure_categories jsonb;
begin
  select jsonb_build_object(
    'totalCount', count(*),
    'upCount', count(*) filter (where rating = 'UP'),
    'downCount', count(*) filter (where rating = 'DOWN'),
    'incorrectCount', count(*) filter (where rating = 'INCORRECT'),
    'unclearCount', count(*) filter (where rating = 'UNCLEAR')
  ) into v_feedback
  from public.knowledge_card_feedback;

  select coalesce(jsonb_agg(jsonb_build_object(
    'code', failures.code,
    'count', failures.count
  ) order by failures.count desc, failures.code), '[]'::jsonb)
  into v_failure_categories
  from (
    select failure.code, count(*)::integer as count
    from public.card_quality_evaluations as evaluations
    cross join lateral jsonb_array_elements_text(evaluations.hard_failures) as failure(code)
    group by failure.code
    order by count(*) desc, failure.code
    limit 20
  ) as failures;

  with chapter_keys as (
    select project_id, chapter_id from public.card_blueprint_slots
    union
    select project_id, chapter_id from public.card_quality_evaluations
    union
    select project_id, chapter_id from public.knowledge_card_feedback
  ),
  slot_counts as (
    select
      project_id,
      chapter_id,
      count(*)::integer as slot_count,
      count(*) filter (where required)::integer as required_slot_count,
      count(*) filter (where status = 'ACCEPTED')::integer as accepted_slot_count
    from public.card_blueprint_slots
    group by project_id, chapter_id
  ),
  evaluation_counts as (
    select
      project_id,
      chapter_id,
      count(*)::integer as evaluation_count,
      count(*) filter (where verdict = 'APPROVED')::integer as approved_evaluation_count,
      count(*) filter (where verdict = 'REPAIR_REQUESTED')::integer as repair_requested_evaluation_count,
      count(*) filter (where verdict = 'FAILED')::integer as failed_evaluation_count
    from public.card_quality_evaluations
    group by project_id, chapter_id
  ),
  feedback_counts as (
    select
      project_id,
      chapter_id,
      count(*)::integer as total_count,
      count(*) filter (where rating = 'UP')::integer as up_count,
      count(*) filter (where rating = 'DOWN')::integer as down_count,
      count(*) filter (where rating = 'INCORRECT')::integer as incorrect_count,
      count(*) filter (where rating = 'UNCLEAR')::integer as unclear_count
    from public.knowledge_card_feedback
    group by project_id, chapter_id
  ),
  chapter_rows as (
    select
      chapter_keys.project_id,
      chapter_keys.chapter_id,
      coalesce(slot_counts.slot_count, 0) as slot_count,
      coalesce(slot_counts.required_slot_count, 0) as required_slot_count,
      coalesce(slot_counts.accepted_slot_count, 0) as accepted_slot_count,
      coalesce(evaluation_counts.evaluation_count, 0) as evaluation_count,
      coalesce(evaluation_counts.approved_evaluation_count, 0) as approved_evaluation_count,
      coalesce(evaluation_counts.repair_requested_evaluation_count, 0) as repair_requested_evaluation_count,
      coalesce(evaluation_counts.failed_evaluation_count, 0) as failed_evaluation_count,
      coalesce(feedback_counts.total_count, 0) as total_count,
      coalesce(feedback_counts.up_count, 0) as up_count,
      coalesce(feedback_counts.down_count, 0) as down_count,
      coalesce(feedback_counts.incorrect_count, 0) as incorrect_count,
      coalesce(feedback_counts.unclear_count, 0) as unclear_count
    from chapter_keys
    left join slot_counts using (project_id, chapter_id)
    left join evaluation_counts using (project_id, chapter_id)
    left join feedback_counts using (project_id, chapter_id)
    order by chapter_keys.project_id, chapter_keys.chapter_id
    limit 384
  )
  select coalesce(jsonb_agg(jsonb_build_object(
    'projectId', chapter_rows.project_id,
    'chapterId', chapter_rows.chapter_id,
    'slotCount', chapter_rows.slot_count,
    'requiredSlotCount', chapter_rows.required_slot_count,
    'acceptedSlotCount', chapter_rows.accepted_slot_count,
    'evaluationCount', chapter_rows.evaluation_count,
    'approvedEvaluationCount', chapter_rows.approved_evaluation_count,
    'repairRequestedEvaluationCount', chapter_rows.repair_requested_evaluation_count,
    'failedEvaluationCount', chapter_rows.failed_evaluation_count,
    'feedback', jsonb_build_object(
      'totalCount', chapter_rows.total_count,
      'upCount', chapter_rows.up_count,
      'downCount', chapter_rows.down_count,
      'incorrectCount', chapter_rows.incorrect_count,
      'unclearCount', chapter_rows.unclear_count
    )
  ) order by chapter_rows.project_id, chapter_rows.chapter_id), '[]'::jsonb)
  into v_chapters
  from chapter_rows;

  with evaluation_counts as (
    select
      project_id,
      chapter_id,
      design_run_id,
      slot_id,
      count(*)::integer as evaluation_count,
      count(*) filter (where verdict = 'APPROVED')::integer as approved_evaluation_count,
      count(*) filter (where verdict = 'REPAIR_REQUESTED')::integer as repair_requested_evaluation_count,
      count(*) filter (where verdict = 'FAILED')::integer as failed_evaluation_count
    from public.card_quality_evaluations
    where slot_id is not null
    group by project_id, chapter_id, design_run_id, slot_id
  ),
  feedback_counts as (
    select
      candidates.project_id,
      candidates.chapter_id,
      candidates.design_run_id,
      candidates.slot_id,
      count(*)::integer as total_count,
      count(*) filter (where feedback.rating = 'UP')::integer as up_count,
      count(*) filter (where feedback.rating = 'DOWN')::integer as down_count,
      count(*) filter (where feedback.rating = 'INCORRECT')::integer as incorrect_count,
      count(*) filter (where feedback.rating = 'UNCLEAR')::integer as unclear_count
    from public.card_slot_candidates as candidates
    join public.knowledge_card_feedback as feedback
      on feedback.project_id = candidates.project_id
      and feedback.chapter_id = candidates.chapter_id
      and feedback.card_id = candidates.card_id
    where candidates.status = 'ACCEPTED'
    group by candidates.project_id, candidates.chapter_id, candidates.design_run_id, candidates.slot_id
  ),
  slot_rows as (
    select
      slots.project_id,
      slots.chapter_id,
      slots.slot_id,
      slots.card_type,
      slots.required,
      slots.status,
      coalesce(evaluation_counts.evaluation_count, 0) as evaluation_count,
      coalesce(evaluation_counts.approved_evaluation_count, 0) as approved_evaluation_count,
      coalesce(evaluation_counts.repair_requested_evaluation_count, 0) as repair_requested_evaluation_count,
      coalesce(evaluation_counts.failed_evaluation_count, 0) as failed_evaluation_count,
      coalesce(feedback_counts.total_count, 0) as total_count,
      coalesce(feedback_counts.up_count, 0) as up_count,
      coalesce(feedback_counts.down_count, 0) as down_count,
      coalesce(feedback_counts.incorrect_count, 0) as incorrect_count,
      coalesce(feedback_counts.unclear_count, 0) as unclear_count
    from public.card_blueprint_slots as slots
    left join evaluation_counts
      on evaluation_counts.project_id = slots.project_id
      and evaluation_counts.chapter_id = slots.chapter_id
      and evaluation_counts.design_run_id = slots.design_run_id
      and evaluation_counts.slot_id = slots.slot_id
    left join feedback_counts
      on feedback_counts.project_id = slots.project_id
      and feedback_counts.chapter_id = slots.chapter_id
      and feedback_counts.design_run_id = slots.design_run_id
      and feedback_counts.slot_id = slots.slot_id
    order by slots.project_id, slots.chapter_id, slots.slot_id
    limit 480
  )
  select coalesce(jsonb_agg(jsonb_build_object(
    'projectId', slot_rows.project_id,
    'chapterId', slot_rows.chapter_id,
    'slotId', slot_rows.slot_id,
    'cardType', slot_rows.card_type,
    'required', slot_rows.required,
    'status', slot_rows.status,
    'evaluationCount', slot_rows.evaluation_count,
    'approvedEvaluationCount', slot_rows.approved_evaluation_count,
    'repairRequestedEvaluationCount', slot_rows.repair_requested_evaluation_count,
    'failedEvaluationCount', slot_rows.failed_evaluation_count,
    'feedback', jsonb_build_object(
      'totalCount', slot_rows.total_count,
      'upCount', slot_rows.up_count,
      'downCount', slot_rows.down_count,
      'incorrectCount', slot_rows.incorrect_count,
      'unclearCount', slot_rows.unclear_count
    )
  ) order by slot_rows.project_id, slot_rows.chapter_id, slot_rows.slot_id), '[]'::jsonb)
  into v_slots
  from slot_rows;

  return jsonb_build_object(
    'generatedAt', now(),
    'feedback', v_feedback,
    'chapters', v_chapters,
    'slots', v_slots,
    'failureCategories', v_failure_categories
  );
end;
$$;

revoke execute on function public.get_learning_quality_operations_v3() from public;

do $$
begin
  if exists (select 1 from pg_roles where rolname = 'service_role') then
    grant execute on function public.get_learning_quality_operations_v3() to service_role;
  end if;
end;
$$;

commit;
