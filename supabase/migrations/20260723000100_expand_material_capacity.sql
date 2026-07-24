begin;

alter table public.learning_journeys
  drop constraint if exists learning_journeys_chunk_count_check;
alter table public.learning_journeys
  add constraint learning_journeys_chunk_count_check
  check (chunk_count between 2 and 12);

alter table public.source_chunks
  drop constraint if exists source_chunks_chunk_id_check;
alter table public.source_chunks
  add constraint source_chunks_chunk_id_check
  check (chunk_id between 0 and 11);

alter table public.agent_events
  drop constraint if exists agent_events_chunk_id_check;
alter table public.agent_events
  add constraint agent_events_chunk_id_check
  check (chunk_id is null or chunk_id between 0 and 11);

create or replace function public.claim_chunk_generation(
  p_journey_id text,
  p_chunk_id integer,
  p_worker_address text
)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
begin
  update public.source_chunks
  set status = 'GENERATING',
      worker_address = lower(p_worker_address),
      attempt = attempt + 1,
      chunk_lease_until = now() + interval '60 seconds',
      last_error = null
  where journey_id = lower(p_journey_id)
    and p_chunk_id between 0 and 11
    and chunk_id = p_chunk_id::smallint
    and status in ('QUEUED', 'RETRYABLE')
    and attempt < 2;
  return found;
end;
$$;

create or replace function public.mark_chunk_retryable(
  p_journey_id text,
  p_chunk_id integer,
  p_error text
)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
begin
  update public.source_chunks
  set status = case when cards_root is null then 'RETRYABLE' else 'SAVED' end,
      chunk_lease_until = null,
      last_error = left(p_error, 500)
  where journey_id = lower(p_journey_id)
    and p_chunk_id between 0 and 11
    and chunk_id = p_chunk_id::smallint
    and status in ('GENERATING', 'VALIDATING', 'SAVED', 'SUBMITTING', 'RETRYABLE');
  return found;
end;
$$;

commit;
