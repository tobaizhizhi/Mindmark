begin;

create table public.session_summaries (
  journey_id text not null references public.learning_journeys(journey_id) on delete cascade,
  session_id uuid not null,
  reviewed_at timestamptz not null,
  reviewed_count smallint not null check (reviewed_count between 0 and 15),
  forgotten_count smallint not null check (forgotten_count between 0 and reviewed_count),
  average_response_ms integer not null check (average_response_ms >= 0),
  due_forecast jsonb not null check (
    jsonb_typeof(due_forecast) = 'array'
    and jsonb_array_length(due_forecast) = 7
  ),
  weak_tags jsonb not null default '[]'::jsonb check (jsonb_typeof(weak_tags) = 'array'),
  trigger_reasons jsonb not null default '[]'::jsonb check (jsonb_typeof(trigger_reasons) = 'array'),
  plan_updated boolean not null default false,
  plan_version integer not null check (plan_version > 0),
  created_at timestamptz not null default now(),
  primary key (journey_id, session_id)
);

create index session_summaries_journey_reviewed_idx
  on public.session_summaries (journey_id, reviewed_at desc);

alter table public.session_summaries enable row level security;
alter table public.session_summaries force row level security;
revoke all on table public.session_summaries from public;

create function public.submit_learning_review(
  p_journey_id text,
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
  v_existing_state jsonb;
begin
  select journeys.fsrs_states->lower(p_card_id)
  into v_current_state
  from public.learning_journeys as journeys
  where journeys.journey_id = lower(p_journey_id)
    and journeys.learner_address = lower(p_owner)
    and journeys.status = 'READY'
    and exists (
      select 1
      from jsonb_array_elements(coalesce(journeys.deck, '[]'::jsonb)) as card
      where card->>'id' = lower(p_card_id)
    )
  for update;

  if not found then
    raise exception 'ready owned journey card not found';
  end if;

  select logs.fsrs_after
  into v_existing_state
  from public.review_logs as logs
  where logs.journey_id = lower(p_journey_id)
    and logs.session_id = p_session_id
    and logs.card_id = lower(p_card_id);

  if found then
    return jsonb_build_object(
      'accepted', true,
      'duplicate', true,
      'nextReviewAt', v_existing_state->>'due'
    );
  end if;

  if v_current_state is distinct from p_expected_state then
    raise exception 'fsrs state conflict';
  end if;

  insert into public.review_logs (
    journey_id,
    session_id,
    card_id,
    rating,
    response_ms,
    reviewed_at,
    fsrs_before,
    fsrs_after
  ) values (
    lower(p_journey_id),
    p_session_id,
    lower(p_card_id),
    p_rating,
    p_response_ms,
    p_reviewed_at,
    p_expected_state,
    p_next_state
  );

  update public.learning_journeys
  set fsrs_states = jsonb_set(
    fsrs_states,
    array[lower(p_card_id)],
    p_next_state,
    true
  )
  where journey_id = lower(p_journey_id);

  return jsonb_build_object(
    'accepted', true,
    'duplicate', false,
    'nextReviewAt', p_next_state->>'due'
  );
end;
$$;

create function public.complete_learning_session(
  p_journey_id text,
  p_owner text,
  p_session_id uuid,
  p_summary jsonb,
  p_plan jsonb,
  p_expected_plan_version integer
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_existing public.session_summaries%rowtype;
  v_plan_version integer;
begin
  select plan_version into v_plan_version
  from public.learning_journeys
  where journey_id = lower(p_journey_id)
    and learner_address = lower(p_owner)
    and status = 'READY'
  for update;
  if not found then raise exception 'ready owned journey not found'; end if;

  select * into v_existing
  from public.session_summaries
  where journey_id = lower(p_journey_id)
    and session_id = p_session_id;
  if found then
    return jsonb_build_object(
      'summary', jsonb_build_object(
        'sessionId', v_existing.session_id,
        'journeyId', v_existing.journey_id,
        'reviewedAt', v_existing.reviewed_at,
        'reviewedCount', v_existing.reviewed_count,
        'forgottenCount', v_existing.forgotten_count,
        'averageResponseMs', v_existing.average_response_ms,
        'dueForecast', v_existing.due_forecast
      ),
      'planUpdated', v_existing.plan_updated,
      'planVersion', v_existing.plan_version,
      'triggerReasons', v_existing.trigger_reasons
    );
  end if;

  if v_plan_version <> p_expected_plan_version then
    raise exception 'plan version conflict';
  end if;

  if p_plan is not null then
    v_plan_version := v_plan_version + 1;
    update public.learning_journeys
    set plan = p_plan,
        plan_version = v_plan_version
    where journey_id = lower(p_journey_id);
  end if;

  insert into public.session_summaries (
    journey_id, session_id, reviewed_at, reviewed_count, forgotten_count,
    average_response_ms, due_forecast, weak_tags, trigger_reasons,
    plan_updated, plan_version
  ) values (
    lower(p_journey_id), p_session_id, (p_summary->>'reviewedAt')::timestamptz,
    (p_summary->>'reviewedCount')::smallint,
    (p_summary->>'forgottenCount')::smallint,
    (p_summary->>'averageResponseMs')::integer,
    p_summary->'dueForecast', coalesce(p_summary->'weakTags', '[]'::jsonb),
    coalesce(p_summary->'triggerReasons', '[]'::jsonb), p_plan is not null,
    v_plan_version
  );

  return jsonb_build_object(
    'summary', p_summary - 'weakTags' - 'triggerReasons',
    'planUpdated', p_plan is not null,
    'planVersion', v_plan_version,
    'triggerReasons', coalesce(p_summary->'triggerReasons', '[]'::jsonb)
  );
end;
$$;

revoke execute on function public.submit_learning_review(
  text, text, uuid, text, text, integer, timestamptz, jsonb, jsonb
) from public;
revoke execute on function public.complete_learning_session(
  text, text, uuid, jsonb, jsonb, integer
) from public;

do $$
begin
  if exists (select 1 from pg_roles where rolname = 'anon') then
    revoke all on table public.session_summaries from anon;
  end if;
  if exists (select 1 from pg_roles where rolname = 'authenticated') then
    revoke all on table public.session_summaries from authenticated;
  end if;
  if exists (select 1 from pg_roles where rolname = 'service_role') then
    grant all on table public.session_summaries to service_role;
    grant execute on function public.submit_learning_review(
      text, text, uuid, text, text, integer, timestamptz, jsonb, jsonb
    ) to service_role;
    grant execute on function public.complete_learning_session(
      text, text, uuid, jsonb, jsonb, integer
    ) to service_role;
  end if;
end;
$$;

commit;
