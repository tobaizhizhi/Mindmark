begin;

create or replace function public.get_schema_capabilities_v1()
returns jsonb
language plpgsql
stable
security definer
set search_path = pg_catalog, public
as $$
declare
  v_core_learning_v2 boolean;
  v_learning_design_v3 boolean;
  v_card_pack_reading_v5 boolean;
  v_original_pdf_storage boolean;
  v_storage_bucket_contract boolean;
  v_learner_progress boolean;
  v_missing text[] := array[]::text[];
begin
  v_core_learning_v2 :=
    to_regclass('public.learning_projects') is not null
    and to_regclass('public.source_blocks') is not null
    and to_regclass('public.chapters') is not null
    and to_regclass('public.work_units') is not null
    and to_regclass('public.knowledge_cards') is not null
    and to_regclass('public.workflow_jobs') is not null
    and to_regclass('public.workflow_events') is not null
    and to_regprocedure('public.consume_auth_nonce(text,text)') is not null
    and to_regprocedure('public.get_document_library_v2(text,uuid,timestamptz)') is not null
    and to_regprocedure('public.create_project_folder_v2(text,text,uuid)') is not null
    and to_regprocedure('public.rename_project_folder_v2(text,uuid,text)') is not null
    and to_regprocedure('public.move_learning_project_to_folder_v2(text,text,uuid)') is not null
    and to_regprocedure('public.delete_project_folder_v2(text,uuid)') is not null
    and to_regprocedure('public.register_learning_project_source_v2(jsonb,jsonb)') is not null
    and to_regprocedure('public.save_project_outline_draft_v2(text,text,integer,text,text,jsonb,jsonb)') is not null
    and to_regprocedure('public.enqueue_outline_planning_v2(text,text)') is not null
    and to_regprocedure('public.get_project_summaries_v2(text,timestamptz)') is not null
    and to_regprocedure('public.get_chapter_summaries_v2(text,text,timestamptz)') is not null
    and to_regprocedure('public.recover_stale_workflow_jobs_v2()') is not null
    and to_regprocedure('public.claim_next_workflow_job_v2(text[])') is not null
    and to_regprocedure('public.complete_workflow_job_v2(uuid,jsonb)') is not null
    and to_regprocedure('public.retry_workflow_job_v2(uuid,text)') is not null
    and to_regprocedure('public.claim_work_unit_for_workflow_v2(text,integer,text)') is not null
    and to_regprocedure('public.claim_chapter_quality_check_for_workflow_v2(text,integer)') is not null
    and to_regprocedure('public.claim_chapter_assembly_for_workflow_v2(text,integer)') is not null
    and to_regprocedure('public.claim_project_finalization_for_workflow_v2(text)') is not null
    and to_regprocedure('public.claim_work_unit_reward_for_workflow_v2(text,integer)') is not null
    and to_regprocedure('public.approve_chapter_candidates_v2(text,integer,jsonb)') is not null
    and to_regprocedure('public.request_chapter_candidate_repair_v2(text,integer,text)') is not null
    and to_regprocedure('public.confirm_work_unit_and_enqueue_reward_v2(text,integer,text,bigint,numeric,integer,text,numeric)') is not null
    and to_regprocedure('public.mark_work_unit_retryable_v2(text,integer,text)') is not null
    and to_regprocedure('public.save_chapter_assembly_v2(text,integer,text,jsonb)') is not null
    and to_regprocedure('public.mark_chapter_ready_v2(text,integer,text)') is not null
    and to_regprocedure('public.mark_chapter_retryable_v2(text,integer,text)') is not null
    and to_regprocedure('public.save_project_finalization_v2(text,text,jsonb,text,integer)') is not null
    and to_regprocedure('public.mark_project_ready_v2(text,text,jsonb,text,integer,text)') is not null
    and to_regprocedure('public.mark_project_retryable_v2(text,text)') is not null
    and to_regprocedure('public.release_work_unit_reward_v2(text,integer,text)') is not null
    and to_regprocedure('public.submit_scoped_project_review_v2(text,integer,text,uuid,text,text,integer,timestamptz,jsonb,jsonb,text)') is not null
    and to_regprocedure('public.complete_project_review_session_v2(text,uuid)') is not null
    and to_regprocedure('public.get_workflow_operations_v2()') is not null;
  if not v_core_learning_v2 then
    v_missing := array_append(v_missing, 'core_learning_v2');
  end if;

  v_learning_design_v3 :=
    to_regprocedure('public.start_chapter_design_v3(text,integer,integer,integer)') is not null
    and to_regprocedure('public.freeze_project_design_v3(text,integer,text,jsonb,jsonb,text,jsonb)') is not null
    and to_regprocedure('public.complete_chapter_design_v3(uuid,jsonb,jsonb,text,text,text,text,jsonb)') is not null
    and to_regprocedure('public.fail_chapter_design_v3(uuid,text,boolean)') is not null
    and to_regprocedure('public.confirm_project_outline_design_v3(text,text,integer,text,jsonb)') is not null
    and to_regprocedure('public.save_work_unit_candidates_v3(text,integer,text,integer,jsonb)') is not null
    and to_regprocedure('public.record_chapter_quality_evaluations_v3(text,integer,uuid,jsonb,jsonb,jsonb,text,text)') is not null
    and to_regprocedure('public.approve_chapter_candidates_v3(text,integer,uuid,jsonb,jsonb,jsonb,jsonb,text,text)') is not null
    and to_regprocedure('public.request_chapter_slot_repairs_v3(text,integer,uuid,jsonb,jsonb,jsonb,jsonb,text,text)') is not null
    and to_regprocedure('public.get_learning_quality_operations_v3()') is not null
    and to_regclass('public.chapter_design_runs') is not null
    and to_regclass('public.card_blueprint_slots') is not null
    and to_regclass('public.card_slot_candidates') is not null
    and to_regclass('public.card_quality_evaluations') is not null;
  if not v_learning_design_v3 then
    v_missing := array_append(v_missing, 'learning_design_v3');
  end if;

  v_card_pack_reading_v5 :=
    to_regprocedure('public.publish_card_pack_v1(jsonb,jsonb,text,text)') is not null
    and to_regprocedure('public.install_card_pack_v1(text,uuid,uuid)') is not null
    and to_regprocedure('public.publish_card_pack_v5(jsonb,jsonb,text,text)') is not null
    and to_regprocedure('public.list_published_card_packs_v1(text)') is not null
    and to_regprocedure('public.get_published_card_pack_v1(uuid,text)') is not null
    and to_regprocedure('public.delete_card_pack_installation_v1(text,uuid)') is not null
    and to_regclass('public.card_packs') is not null
    and to_regclass('public.card_pack_versions') is not null
    and to_regclass('public.card_pack_chapters') is not null
    and to_regclass('public.card_pack_cards') is not null
    and to_regclass('public.card_pack_installations') is not null
    and to_regclass('public.card_pack_chapter_reading_blocks') is not null;
  if not v_card_pack_reading_v5 then
    v_missing := array_append(v_missing, 'card_pack_reading_v5');
  end if;

  select count(*) = 5 into v_original_pdf_storage
  from information_schema.columns
  where table_schema = 'public'
    and table_name = 'learning_projects'
    and column_name = any(array[
      'source_storage_bucket', 'source_storage_path', 'source_file_sha256',
      'source_file_size', 'source_file_status'
    ]);
  if v_original_pdf_storage and to_regclass('storage.buckets') is not null then
    select count(*) = 4 into v_storage_bucket_contract
    from information_schema.columns
    where table_schema = 'storage'
      and table_name = 'buckets'
      and column_name = any(array['id', 'public', 'file_size_limit', 'allowed_mime_types']);
    if v_storage_bucket_contract then
      execute $storage$
        select exists (
          select 1
          from storage.buckets
          where id = 'learning-source-files'
            and public = false
            and file_size_limit = 15728640
            and coalesce('application/pdf' = any(allowed_mime_types), false)
        )
      $storage$ into v_storage_bucket_contract;
    end if;
    v_original_pdf_storage := v_original_pdf_storage and v_storage_bucket_contract;
  end if;
  if not v_original_pdf_storage then
    v_missing := array_append(v_missing, 'original_pdf_storage');
  end if;

  v_learner_progress := to_regclass('public.workflow_jobs') is not null;
  select v_learner_progress and count(*) = 9 into v_learner_progress
  from information_schema.columns
  where table_schema = 'public'
    and (
      (table_name = 'learning_projects' and column_name = any(array['project_id', 'owner_address', 'status', 'updated_at']))
      or (table_name = 'chapters' and column_name = any(array[
        'project_id', 'chapter_id', 'title', 'status', 'position'
      ]))
    );
  select v_learner_progress and count(*) = 8 into v_learner_progress
  from information_schema.columns
  where table_schema = 'public'
    and table_name = 'workflow_jobs'
    and column_name = any(array[
      'job_id', 'project_id', 'kind', 'chapter_id', 'status', 'attempt', 'last_error', 'created_at'
    ]);
  if not v_learner_progress then
    v_missing := array_append(v_missing, 'learner_progress');
  end if;

  return jsonb_build_object(
    'schemaVersion', '2026-08-03.1',
    'capabilities', jsonb_build_object(
      'coreLearningV2', v_core_learning_v2,
      'learningDesignV3', v_learning_design_v3,
      'cardPackReadingV5', v_card_pack_reading_v5,
      'originalPdfStorage', v_original_pdf_storage,
      'learnerProgress', v_learner_progress
    ),
    'missing', to_jsonb(v_missing)
  );
end;
$$;

revoke execute on function public.get_schema_capabilities_v1() from public;

do $$
begin
  if exists (select 1 from pg_roles where rolname = 'anon') then
    revoke execute on function public.get_schema_capabilities_v1() from anon;
  end if;
  if exists (select 1 from pg_roles where rolname = 'authenticated') then
    revoke execute on function public.get_schema_capabilities_v1() from authenticated;
  end if;
  if exists (select 1 from pg_roles where rolname = 'service_role') then
    grant execute on function public.get_schema_capabilities_v1() to service_role;
  end if;
end;
$$;

comment on function public.get_schema_capabilities_v1() is
  'Reports the deployed Mindmark schema contract without reading learner content.';

commit;

notify pgrst, 'reload schema';
