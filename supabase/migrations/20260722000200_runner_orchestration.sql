begin;

alter table public.learning_journeys
  add column if not exists goal text check (goal is null or char_length(goal) between 1 and 500),
  add column if not exists runner_lease_until timestamptz,
  add column if not exists runner_error text,
  add column if not exists finalizer_attempt smallint not null default 0
    check (finalizer_attempt between 0 and 2);

alter table public.source_chunks
  add column if not exists source_pages jsonb
    check (source_pages is null or jsonb_typeof(source_pages) = 'array'),
  add column if not exists chunk_lease_until timestamptz,
  add column if not exists last_error text;

create or replace function public.claim_journey_generation(p_journey_id text)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
begin
  update public.learning_journeys
  set status = 'GENERATING',
      runner_lease_until = now() + interval '90 seconds',
      runner_error = null
  where journey_id = lower(p_journey_id)
    and (
      status in ('CREATED', 'FAILED_RETRYABLE')
      or (
        status = 'GENERATING'
        and (runner_lease_until is null or runner_lease_until < now())
      )
    );
  return found;
end;
$$;

create or replace function public.renew_journey_lease(p_journey_id text)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
begin
  update public.learning_journeys
  set runner_lease_until = now() + interval '90 seconds'
  where journey_id = lower(p_journey_id)
    and status in ('GENERATING', 'FINALIZING');
  return found;
end;
$$;

create or replace function public.recover_stale_chunks()
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  v_count integer;
begin
  update public.source_chunks
  set status = 'RETRYABLE',
      chunk_lease_until = null,
      last_error = 'generation lease expired'
  where status in ('GENERATING', 'VALIDATING')
    and coalesce(chunk_lease_until, updated_at + interval '60 seconds') < now()
    and attempt < 2;
  get diagnostics v_count = row_count;
  return v_count;
end;
$$;

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
    and p_chunk_id between 0 and 3
    and chunk_id = p_chunk_id::smallint
    and status in ('QUEUED', 'RETRYABLE')
    and attempt < 2;
  return found;
end;
$$;

create or replace function public.claim_journey_finalization(p_journey_id text)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
begin
  update public.learning_journeys as journeys
  set status = 'FINALIZING',
      finalizer_attempt = finalizer_attempt + 1,
      runner_lease_until = now() + interval '60 seconds',
      runner_error = null
  where journeys.journey_id = lower(p_journey_id)
    and journeys.finalizer_attempt < 2
    and (
      journeys.status = 'GENERATING'
      or (
        journeys.status = 'FINALIZING'
        and (
          journeys.runner_lease_until is null
          or journeys.runner_lease_until < now()
        )
      )
    )
    and not exists (
      select 1
      from public.source_chunks as chunks
      where chunks.journey_id = journeys.journey_id
        and chunks.status <> 'CONFIRMED'
    );
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
    and p_chunk_id between 0 and 3
    and chunk_id = p_chunk_id::smallint
    and status in ('GENERATING', 'VALIDATING', 'SAVED', 'SUBMITTING', 'RETRYABLE');
  return found;
end;
$$;

revoke execute on function public.claim_journey_generation(text) from public;
revoke execute on function public.renew_journey_lease(text) from public;
revoke execute on function public.recover_stale_chunks() from public;
revoke execute on function public.claim_chunk_generation(text, integer, text) from public;
revoke execute on function public.claim_journey_finalization(text) from public;
revoke execute on function public.mark_chunk_retryable(text, integer, text) from public;

do $$
begin
  if exists (select 1 from pg_roles where rolname = 'service_role') then
    grant execute on function public.claim_journey_generation(text) to service_role;
    grant execute on function public.renew_journey_lease(text) to service_role;
    grant execute on function public.recover_stale_chunks() to service_role;
    grant execute on function public.claim_chunk_generation(text, integer, text) to service_role;
    grant execute on function public.claim_journey_finalization(text) to service_role;
    grant execute on function public.mark_chunk_retryable(text, integer, text) to service_role;
  end if;
end;
$$;

commit;
