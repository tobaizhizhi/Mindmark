begin;

alter table public.learning_projects
  add column initial_plan jsonb check (initial_plan is null or jsonb_typeof(initial_plan) = 'object'),
  add column runner_lease_until timestamptz,
  add column last_error text check (last_error is null or char_length(last_error) <= 500);

alter table public.chapters
  add column assembly_attempt smallint not null default 0 check (assembly_attempt between 0 and 10),
  add column assembly_lease_until timestamptz,
  add column last_error text check (last_error is null or char_length(last_error) <= 500);

create table public.work_unit_rewards (
  project_id text not null,
  work_unit_id smallint not null,
  treasury_address text not null check (treasury_address ~ '^0x[0-9a-f]{40}$'),
  recipient_address text not null check (recipient_address ~ '^0x[0-9a-f]{40}$'),
  amount_wei numeric(78, 0) not null check (amount_wei > 0),
  status text not null check (
    status in ('PENDING', 'PROCESSING', 'PREPARED', 'SUBMITTING', 'CONFIRMED', 'RETRYABLE', 'BLOCKED')
  ),
  attempt smallint not null default 0 check (attempt between 0 and 20),
  lease_until timestamptz,
  moss_stage text not null default 'PENDING' check (
    moss_stage in ('PENDING', 'DISCOVERED', 'LOADED', 'BUILT', 'SIMULATED')
  ),
  moss_plan_hash text check (moss_plan_hash is null or moss_plan_hash ~ '^0x[0-9a-f]{64}$'),
  simulation_status text not null default 'NOT_RUN' check (
    simulation_status in ('NOT_RUN', 'PASSED', 'FAILED')
  ),
  simulation_warning_codes jsonb not null default '[]'::jsonb check (
    jsonb_typeof(simulation_warning_codes) = 'array'
  ),
  simulation_gas numeric(30, 0) check (simulation_gas is null or simulation_gas >= 0),
  signed_transaction text check (signed_transaction is null or signed_transaction ~ '^0x[0-9a-f]+$'),
  treasury_nonce numeric(30, 0) check (treasury_nonce is null or treasury_nonce >= 0),
  tx_hash text check (tx_hash is null or tx_hash ~ '^0x[0-9a-f]{64}$'),
  confirmed_block bigint check (confirmed_block is null or confirmed_block >= 0),
  gas_used numeric(30, 0) check (gas_used is null or gas_used >= 0),
  confirmation_ms integer check (confirmation_ms is null or confirmation_ms >= 0),
  last_error text check (last_error is null or char_length(last_error) <= 500),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (project_id, work_unit_id),
  foreign key (project_id, work_unit_id)
    references public.work_units(project_id, work_unit_id) on delete cascade
);

create index work_unit_rewards_queue_idx
  on public.work_unit_rewards (status, lease_until, created_at);

create trigger work_unit_rewards_set_updated_at
before update on public.work_unit_rewards
for each row execute function public.set_updated_at();

create or replace function public.claim_next_work_unit_v2(p_worker_address text)
returns setof public.work_units
language plpgsql
security definer
set search_path = public
as $$
declare
  v_project_id text;
  v_work_unit_id smallint;
  v_chapter_id smallint;
  v_status text;
begin
  if lower(p_worker_address) !~ '^0x[0-9a-f]{40}$' then
    raise exception 'invalid Worker address';
  end if;

  select units.project_id, units.work_unit_id, units.chapter_id, units.status
  into v_project_id, v_work_unit_id, v_chapter_id, v_status
  from public.work_units as units
  join public.learning_projects as projects on projects.project_id = units.project_id
  join public.chapters as chapters
    on chapters.project_id = units.project_id and chapters.chapter_id = units.chapter_id
  where projects.status = 'GENERATING'
    and (
      (units.status in ('SAVED', 'SUBMITTING') and units.worker_address = lower(p_worker_address))
      or (
        chapters.status in ('CONFIRMED', 'GENERATING', 'FAILED_RETRYABLE')
        and units.status in ('QUEUED', 'RETRYABLE')
        and units.attempt < 3
      )
    )
  order by
    case units.status when 'SUBMITTING' then 0 when 'SAVED' then 1 when 'RETRYABLE' then 2 else 3 end,
    exists (
      select 1 from public.work_units as completed
      where completed.project_id = units.project_id
        and completed.chapter_id = units.chapter_id
        and completed.status = 'CONFIRMED'
    ) desc,
    chapters.position,
    units.unit_index
  for update of units skip locked
  limit 1;

  if not found then return; end if;
  if v_status not in ('SAVED', 'SUBMITTING') then
    update public.work_units
    set status = 'GENERATING',
        worker_address = lower(p_worker_address),
        attempt = attempt + 1,
        lease_until = now() + interval '90 seconds',
        last_error = null
    where project_id = v_project_id and work_unit_id = v_work_unit_id;

    update public.chapters
    set status = 'GENERATING', last_error = null
    where project_id = v_project_id
      and chapter_id = v_chapter_id
      and status in ('CONFIRMED', 'FAILED_RETRYABLE');
  end if;

  return query select * from public.work_units
  where project_id = v_project_id and work_unit_id = v_work_unit_id;
end;
$$;

create function public.mark_work_unit_retryable_v2(
  p_project_id text,
  p_work_unit_id integer,
  p_error text
)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
begin
  update public.work_units
  set status = case when cards_root is null then 'RETRYABLE' else 'SAVED' end,
      lease_until = null,
      last_error = left(p_error, 500)
  where project_id = lower(p_project_id)
    and work_unit_id = p_work_unit_id::smallint
    and status <> 'CONFIRMED';
  return found;
end;
$$;

create function public.confirm_work_unit_and_enqueue_reward_v2(
  p_project_id text,
  p_work_unit_id integer,
  p_tx_hash text,
  p_block_number bigint,
  p_gas_used numeric,
  p_confirmation_ms integer,
  p_treasury_address text,
  p_amount_wei numeric
)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare
  v_recipient text;
begin
  update public.work_units
  set status = 'CONFIRMED', commit_tx_hash = coalesce(lower(p_tx_hash), commit_tx_hash),
      confirmed_block = p_block_number, gas_used = p_gas_used,
      confirmation_ms = p_confirmation_ms, lease_until = null, last_error = null
  where project_id = lower(p_project_id) and work_unit_id = p_work_unit_id::smallint
    and status in ('SAVED', 'SUBMITTING', 'CONFIRMED')
    and cards_root is not null and card_count > 0
  returning worker_address into v_recipient;
  if not found or v_recipient is null then
    raise exception 'Work Unit confirmation target or Worker is missing';
  end if;

  insert into public.work_unit_rewards (
    project_id, work_unit_id, treasury_address, recipient_address, amount_wei, status
  ) values (
    lower(p_project_id), p_work_unit_id::smallint, lower(p_treasury_address),
    lower(v_recipient), p_amount_wei, 'PENDING'
  ) on conflict (project_id, work_unit_id) do nothing;
  return true;
end;
$$;

create function public.claim_next_chapter_assembly_v2()
returns table (project_id text, chapter_id smallint)
language plpgsql
security definer
set search_path = public
as $$
begin
  return query
  with candidate as (
    select chapters.project_id, chapters.chapter_id
    from public.chapters
    join public.learning_projects as projects on projects.project_id = chapters.project_id
    where projects.status = 'GENERATING'
      and (
        chapters.status in ('GENERATING', 'FAILED_RETRYABLE')
        or (chapters.status = 'ASSEMBLING' and chapters.assembly_lease_until < now())
      )
      and not exists (
        select 1 from public.work_units as units
        where units.project_id = chapters.project_id
          and units.chapter_id = chapters.chapter_id
          and units.status <> 'CONFIRMED'
      )
      and exists (
        select 1 from public.work_units as units
        where units.project_id = chapters.project_id and units.chapter_id = chapters.chapter_id
      )
    order by chapters.position
    for update of chapters skip locked
    limit 1
  )
  update public.chapters as chapters
  set status = 'ASSEMBLING', assembly_attempt = least(chapters.assembly_attempt + 1, 10),
      assembly_lease_until = now() + interval '90 seconds', last_error = null
  from candidate
  where chapters.project_id = candidate.project_id and chapters.chapter_id = candidate.chapter_id
  returning chapters.project_id, chapters.chapter_id;
end;
$$;

create function public.save_chapter_assembly_v2(
  p_project_id text,
  p_chapter_id integer,
  p_cards_root text,
  p_cards jsonb
)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare
  v_count integer;
begin
  if jsonb_typeof(p_cards) <> 'array' or jsonb_array_length(p_cards) not between 1 and 30 then
    raise exception 'Chapter cards must contain between 1 and 30 entries';
  end if;
  v_count := jsonb_array_length(p_cards);
  perform 1 from public.chapters
  where project_id = lower(p_project_id) and chapter_id = p_chapter_id::smallint
    and status = 'ASSEMBLING' for update;
  if not found then raise exception 'claimed Chapter assembly not found'; end if;

  if exists (
    select 1
    from jsonb_to_recordset(p_cards) as card(
      card_id text, project_id text, chapter_id integer, work_unit_id integer, position integer
    )
    left join public.work_units as units
      on units.project_id = lower(p_project_id) and units.work_unit_id = card.work_unit_id::smallint
    where units.work_unit_id is null
      or lower(card.project_id) <> lower(p_project_id)
      or card.chapter_id <> p_chapter_id
      or card.position < 0 or card.position >= v_count
      or units.chapter_id <> p_chapter_id::smallint
      or units.status <> 'CONFIRMED'
  ) then raise exception 'Chapter card provenance is invalid'; end if;

  delete from public.knowledge_cards
  where project_id = lower(p_project_id) and chapter_id = p_chapter_id::smallint;

  insert into public.knowledge_cards (
    card_id, project_id, chapter_id, work_unit_id, position, content,
    card_hash, worker_proof, chapter_proof
  )
  select lower(card.card_id), lower(p_project_id), p_chapter_id::smallint,
    card.work_unit_id::smallint, card.position::smallint, card.content,
    lower(card.card_hash), card.worker_proof, card.chapter_proof
  from jsonb_to_recordset(p_cards) as card(
    card_id text, work_unit_id integer, position integer, content jsonb,
    card_hash text, worker_proof jsonb, chapter_proof jsonb
  );

  update public.chapters
  set cards_root = lower(p_cards_root), card_count = v_count
  where project_id = lower(p_project_id) and chapter_id = p_chapter_id::smallint;
  return true;
end;
$$;

create function public.mark_chapter_ready_v2(
  p_project_id text,
  p_chapter_id integer,
  p_tx_hash text
)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
begin
  update public.chapters
  set status = 'READY', finalize_tx_hash = coalesce(lower(p_tx_hash), finalize_tx_hash),
      assembly_lease_until = null, last_error = null
  where project_id = lower(p_project_id) and chapter_id = p_chapter_id::smallint
    and status in ('ASSEMBLING', 'READY') and cards_root is not null and card_count > 0;
  if not found then raise exception 'assembled Chapter not found'; end if;

  update public.work_units
  set source_text = null, source_blocks = null, worker_cards = '[]'::jsonb
  where project_id = lower(p_project_id) and chapter_id = p_chapter_id::smallint;
  return true;
end;
$$;

create function public.mark_chapter_retryable_v2(
  p_project_id text,
  p_chapter_id integer,
  p_error text
)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
begin
  update public.chapters
  set status = 'FAILED_RETRYABLE', assembly_lease_until = null, last_error = left(p_error, 500)
  where project_id = lower(p_project_id) and chapter_id = p_chapter_id::smallint
    and status <> 'READY';
  return found;
end;
$$;

create function public.claim_next_project_finalization_v2()
returns text
language plpgsql
security definer
set search_path = public
as $$
declare v_project_id text;
begin
  select projects.project_id into v_project_id
  from public.learning_projects as projects
  where (
      projects.status = 'GENERATING'
      or (projects.status in ('FINALIZING', 'FAILED_RETRYABLE')
        and (projects.runner_lease_until is null or projects.runner_lease_until < now()))
    )
    and exists (select 1 from public.chapters where chapters.project_id = projects.project_id)
    and not exists (
      select 1 from public.chapters
      where chapters.project_id = projects.project_id and chapters.status <> 'READY'
    )
  order by projects.updated_at
  for update skip locked limit 1;
  if not found then return null; end if;
  update public.learning_projects
  set status = 'FINALIZING', runner_lease_until = now() + interval '90 seconds', last_error = null
  where project_id = v_project_id;
  return v_project_id;
end;
$$;

create function public.save_project_finalization_v2(
  p_project_id text,
  p_project_deck_root text,
  p_initial_plan jsonb,
  p_initial_plan_hash text,
  p_total_card_count integer
)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
begin
  if jsonb_typeof(p_initial_plan) <> 'object' then raise exception 'initial plan must be an object'; end if;
  update public.learning_projects
  set project_deck_root = lower(p_project_deck_root), initial_plan = p_initial_plan,
      initial_plan_hash = lower(p_initial_plan_hash), total_card_count = p_total_card_count::smallint,
      runner_lease_until = now() + interval '90 seconds'
  where project_id = lower(p_project_id) and status = 'FINALIZING'
    and (project_deck_root is null or project_deck_root = lower(p_project_deck_root))
    and (initial_plan_hash is null or initial_plan_hash = lower(p_initial_plan_hash));
  if not found then raise exception 'claimed Project finalization not found or changed'; end if;
  return true;
end;
$$;

create function public.mark_project_ready_v2(
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
  update public.source_blocks set text = null where project_id = lower(p_project_id);
  return true;
end;
$$;

create function public.mark_project_retryable_v2(p_project_id text, p_error text)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
begin
  update public.learning_projects
  set status = 'FAILED_RETRYABLE', runner_lease_until = null, last_error = left(p_error, 500)
  where project_id = lower(p_project_id) and status <> 'READY';
  return found;
end;
$$;

create function public.claim_work_unit_reward_v2()
returns setof public.work_unit_rewards
language plpgsql
security definer
set search_path = public
as $$
begin
  return query
  with candidate as (
    select rewards.project_id, rewards.work_unit_id
    from public.work_unit_rewards as rewards
    where rewards.status in ('PENDING', 'RETRYABLE', 'PROCESSING', 'PREPARED', 'SUBMITTING')
      and (rewards.lease_until is null or rewards.lease_until < now())
      and (rewards.status in ('PREPARED', 'SUBMITTING') or rewards.attempt < 20)
    order by case rewards.status when 'SUBMITTING' then 0 when 'PREPARED' then 1 else 2 end,
      rewards.created_at
    for update skip locked limit 1
  )
  update public.work_unit_rewards as rewards
  set status = case when rewards.status in ('PENDING', 'RETRYABLE', 'PROCESSING') then 'PROCESSING' else rewards.status end,
      attempt = least(rewards.attempt + 1, 20), lease_until = now() + interval '90 seconds'
  from candidate
  where rewards.project_id = candidate.project_id and rewards.work_unit_id = candidate.work_unit_id
  returning rewards.*;
end;
$$;

create function public.release_work_unit_reward_v2(
  p_project_id text,
  p_work_unit_id integer,
  p_error text
)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
begin
  update public.work_unit_rewards
  set status = case
        when signed_transaction is not null and tx_hash is not null then 'PREPARED'
        when attempt >= 20 then 'BLOCKED'
        else 'RETRYABLE'
      end,
      lease_until = null,
      last_error = left(p_error, 500)
  where project_id = lower(p_project_id) and work_unit_id = p_work_unit_id::smallint
    and status <> 'CONFIRMED';
  return found;
end;
$$;

create function public.submit_project_review_v2(
  p_project_id text,
  p_chapter_id integer,
  p_owner text,
  p_session_id uuid,
  p_card_id text,
  p_rating text,
  p_response_ms integer,
  p_reviewed_at timestamptz,
  p_expected_state jsonb,
  p_next_state jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_current_state jsonb;
  v_duplicate_state jsonb;
begin
  if p_rating not in ('again', 'hard', 'good', 'easy') then raise exception 'invalid review rating'; end if;
  if p_response_ms not between 0 and 3600000 then raise exception 'invalid response time'; end if;
  if jsonb_typeof(p_next_state) <> 'object' then raise exception 'next FSRS state must be an object'; end if;

  perform 1
  from public.knowledge_cards as cards
  join public.chapters on chapters.project_id = cards.project_id and chapters.chapter_id = cards.chapter_id
  join public.learning_projects as projects on projects.project_id = cards.project_id
  where cards.project_id = lower(p_project_id)
    and cards.chapter_id = p_chapter_id::smallint
    and cards.card_id = lower(p_card_id)
    and chapters.status = 'READY'
    and projects.owner_address = lower(p_owner);
  if not found then raise exception 'ready owned Chapter card not found'; end if;

  select fsrs_after into v_duplicate_state
  from public.project_review_logs
  where session_id = p_session_id and card_id = lower(p_card_id);
  if found then
    return jsonb_build_object(
      'accepted', true,
      'duplicate', true,
      'nextReviewAt', v_duplicate_state->>'due'
    );
  end if;

  insert into public.review_sessions (
    session_id, owner_address, project_id, scope_type, chapter_id, status
  ) values (
    p_session_id, lower(p_owner), lower(p_project_id), 'CHAPTER', p_chapter_id::smallint, 'ACTIVE'
  ) on conflict (session_id) do nothing;

  perform 1 from public.review_sessions
  where session_id = p_session_id and owner_address = lower(p_owner)
    and project_id = lower(p_project_id) and chapter_id = p_chapter_id::smallint
    and scope_type = 'CHAPTER' and status = 'ACTIVE';
  if not found then raise exception 'active owned Chapter session not found'; end if;

  select fsrs_state into v_current_state
  from public.card_learning_states
  where owner_address = lower(p_owner) and card_id = lower(p_card_id)
  for update;
  if v_current_state is distinct from p_expected_state then
    raise exception 'card learning state changed concurrently';
  end if;

  insert into public.project_review_logs (
    session_id, owner_address, project_id, chapter_id, card_id, rating,
    response_ms, reviewed_at, fsrs_before, fsrs_after
  ) values (
    p_session_id, lower(p_owner), lower(p_project_id), p_chapter_id::smallint,
    lower(p_card_id), p_rating, p_response_ms, p_reviewed_at,
    p_expected_state, p_next_state
  );

  insert into public.card_learning_states (
    owner_address, project_id, chapter_id, card_id, fsrs_state, due_at,
    reps, lapses, last_reviewed_at
  ) values (
    lower(p_owner), lower(p_project_id), p_chapter_id::smallint, lower(p_card_id),
    p_next_state, (p_next_state->>'due')::timestamptz,
    (p_next_state->>'reps')::integer, (p_next_state->>'lapses')::integer, p_reviewed_at
  ) on conflict (owner_address, card_id) do update
  set fsrs_state = excluded.fsrs_state,
      due_at = excluded.due_at,
      reps = excluded.reps,
      lapses = excluded.lapses,
      last_reviewed_at = excluded.last_reviewed_at;

  update public.review_sessions
  set reviewed_count = reviewed_count + 1,
      forgotten_count = forgotten_count + case when p_rating = 'again' then 1 else 0 end
  where session_id = p_session_id;

  return jsonb_build_object(
    'accepted', true,
    'duplicate', false,
    'nextReviewAt', p_next_state->>'due'
  );
end;
$$;

create function public.complete_project_review_session_v2(
  p_owner text,
  p_session_id uuid
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_session public.review_sessions%rowtype;
  v_average integer;
begin
  select * into v_session from public.review_sessions
  where session_id = p_session_id and owner_address = lower(p_owner)
    and scope_type = 'CHAPTER' for update;
  if not found then raise exception 'owned Chapter session not found'; end if;

  select coalesce(round(avg(response_ms)), 0)::integer into v_average
  from public.project_review_logs where session_id = p_session_id;
  if v_session.status = 'ACTIVE' then
    update public.review_sessions
    set status = 'COMPLETED', average_response_ms = v_average, completed_at = now()
    where session_id = p_session_id
    returning * into v_session;
  end if;
  return jsonb_build_object(
    'sessionId', v_session.session_id,
    'reviewedCount', v_session.reviewed_count,
    'forgottenCount', v_session.forgotten_count,
    'averageResponseMs', coalesce(v_session.average_response_ms, v_average),
    'completedAt', v_session.completed_at
  );
end;
$$;

alter table public.work_unit_rewards enable row level security;
alter table public.work_unit_rewards force row level security;
revoke all on table public.work_unit_rewards from public;
revoke execute on function public.mark_work_unit_retryable_v2(text, integer, text) from public;
revoke execute on function public.confirm_work_unit_and_enqueue_reward_v2(text, integer, text, bigint, numeric, integer, text, numeric) from public;
revoke execute on function public.claim_next_chapter_assembly_v2() from public;
revoke execute on function public.save_chapter_assembly_v2(text, integer, text, jsonb) from public;
revoke execute on function public.mark_chapter_ready_v2(text, integer, text) from public;
revoke execute on function public.mark_chapter_retryable_v2(text, integer, text) from public;
revoke execute on function public.claim_next_project_finalization_v2() from public;
revoke execute on function public.save_project_finalization_v2(text, text, jsonb, text, integer) from public;
revoke execute on function public.mark_project_ready_v2(text, text, jsonb, text, integer, text) from public;
revoke execute on function public.mark_project_retryable_v2(text, text) from public;
revoke execute on function public.claim_work_unit_reward_v2() from public;
revoke execute on function public.release_work_unit_reward_v2(text, integer, text) from public;
revoke execute on function public.submit_project_review_v2(text, integer, text, uuid, text, text, integer, timestamptz, jsonb, jsonb) from public;
revoke execute on function public.complete_project_review_session_v2(text, uuid) from public;

do $$
begin
  if exists (select 1 from pg_roles where rolname = 'anon') then
    revoke all on table public.work_unit_rewards from anon;
  end if;
  if exists (select 1 from pg_roles where rolname = 'authenticated') then
    revoke all on table public.work_unit_rewards from authenticated;
  end if;
  if exists (select 1 from pg_roles where rolname = 'service_role') then
    grant all on table public.work_unit_rewards to service_role;
    grant execute on function public.mark_work_unit_retryable_v2(text, integer, text) to service_role;
    grant execute on function public.confirm_work_unit_and_enqueue_reward_v2(text, integer, text, bigint, numeric, integer, text, numeric) to service_role;
    grant execute on function public.claim_next_chapter_assembly_v2() to service_role;
    grant execute on function public.save_chapter_assembly_v2(text, integer, text, jsonb) to service_role;
    grant execute on function public.mark_chapter_ready_v2(text, integer, text) to service_role;
    grant execute on function public.mark_chapter_retryable_v2(text, integer, text) to service_role;
    grant execute on function public.claim_next_project_finalization_v2() to service_role;
    grant execute on function public.save_project_finalization_v2(text, text, jsonb, text, integer) to service_role;
    grant execute on function public.mark_project_ready_v2(text, text, jsonb, text, integer, text) to service_role;
    grant execute on function public.mark_project_retryable_v2(text, text) to service_role;
    grant execute on function public.claim_work_unit_reward_v2() to service_role;
    grant execute on function public.release_work_unit_reward_v2(text, integer, text) to service_role;
    grant execute on function public.submit_project_review_v2(text, integer, text, uuid, text, text, integer, timestamptz, jsonb, jsonb) to service_role;
    grant execute on function public.complete_project_review_session_v2(text, uuid) to service_role;
  end if;
end;
$$;

commit;
