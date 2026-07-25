begin;

alter table public.agent_events
  drop constraint if exists agent_events_agent_role_check;
alter table public.agent_events
  add constraint agent_events_agent_role_check
  check (agent_role in ('coordinator', 'worker-0', 'worker-1', 'worker-2', 'finalizer', 'settlement'));

create table public.worker_rewards (
  journey_id text not null,
  chunk_id smallint not null,
  treasury_address text not null check (treasury_address ~ '^0x[0-9a-f]{40}$'),
  recipient_address text not null check (recipient_address ~ '^0x[0-9a-f]{40}$'),
  amount_wei numeric(78, 0) not null check (amount_wei > 0),
  status text not null check (
    status in ('PENDING', 'PROCESSING', 'PREPARED', 'SUBMITTING', 'CONFIRMED', 'RETRYABLE', 'BLOCKED')
  ),
  attempt smallint not null default 0 check (attempt between 0 and 20),
  lease_until timestamptz,
  last_error text,
  moss_stage text not null default 'PENDING'
    check (moss_stage in ('PENDING', 'DISCOVERED', 'LOADED', 'BUILT', 'SIMULATED')),
  discovered_at timestamptz,
  loaded_at timestamptz,
  built_at timestamptz,
  simulated_at timestamptz,
  moss_plan_hash text check (moss_plan_hash is null or moss_plan_hash ~ '^0x[0-9a-f]{64}$'),
  simulation_status text not null default 'NOT_RUN'
    check (simulation_status in ('NOT_RUN', 'PASSED', 'FAILED')),
  simulation_warning_codes jsonb not null default '[]'::jsonb
    check (jsonb_typeof(simulation_warning_codes) = 'array'),
  simulation_warning_count smallint not null default 0 check (simulation_warning_count >= 0),
  simulation_gas numeric(78, 0) check (simulation_gas is null or simulation_gas >= 0),
  treasury_nonce bigint check (treasury_nonce is null or treasury_nonce >= 0),
  signed_transaction text check (signed_transaction is null or signed_transaction ~ '^0x[0-9a-fA-F]+$'),
  tx_hash text unique check (tx_hash is null or tx_hash ~ '^0x[0-9a-f]{64}$'),
  submitted_at timestamptz,
  confirmed_block bigint check (confirmed_block is null or confirmed_block >= 0),
  gas_used numeric(78, 0) check (gas_used is null or gas_used >= 0),
  confirmation_ms integer check (confirmation_ms is null or confirmation_ms >= 0),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (journey_id, chunk_id),
  foreign key (journey_id, chunk_id) references public.source_chunks(journey_id, chunk_id) on delete cascade
);

create index worker_rewards_queue_idx
  on public.worker_rewards (status, lease_until, created_at);
create index worker_rewards_journey_idx
  on public.worker_rewards (journey_id, chunk_id);

create trigger worker_rewards_set_updated_at
before update on public.worker_rewards
for each row execute function public.set_updated_at();

create or replace function public.confirm_chunk_and_enqueue_reward(
  p_journey_id text,
  p_chunk_id integer,
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
  update public.source_chunks
  set status = 'CONFIRMED',
      commit_tx_hash = p_tx_hash,
      confirmed_block = p_block_number,
      gas_used = p_gas_used,
      confirmation_ms = p_confirmation_ms,
      chunk_lease_until = null,
      last_error = null
  where journey_id = lower(p_journey_id)
    and chunk_id = p_chunk_id::smallint;
  if not found then
    raise exception 'chunk confirmation target does not exist';
  end if;

  select worker_address into v_recipient
  from public.source_chunks
  where journey_id = lower(p_journey_id)
    and chunk_id = p_chunk_id::smallint;
  if v_recipient is null then
    raise exception 'confirmed chunk has no Worker address';
  end if;

  insert into public.worker_rewards (
    journey_id, chunk_id, treasury_address, recipient_address, amount_wei, status
  ) values (
    lower(p_journey_id), p_chunk_id::smallint, lower(p_treasury_address), lower(v_recipient), p_amount_wei, 'PENDING'
  ) on conflict (journey_id, chunk_id) do nothing;
  return true;
end;
$$;

create or replace function public.claim_worker_reward()
returns setof public.worker_rewards
language plpgsql
security definer
set search_path = public
as $$
begin
  lock table public.worker_rewards in share row exclusive mode;

  update public.worker_rewards
  set status = 'BLOCKED',
      lease_until = null,
      last_error = 'Worker reward retry limit exhausted before signing'
  where status in ('PENDING', 'PROCESSING', 'RETRYABLE')
    and signed_transaction is null
    and attempt >= 20
    and (lease_until is null or lease_until < now());

  if exists (
    select 1
    from public.worker_rewards
    where status in ('PROCESSING', 'PREPARED', 'SUBMITTING')
      and lease_until > now()
  ) then
    return;
  end if;

  return query
  with candidate as (
    select rewards.journey_id, rewards.chunk_id
    from public.worker_rewards as rewards
    where rewards.status in ('PENDING', 'RETRYABLE', 'PROCESSING', 'PREPARED', 'SUBMITTING')
      and (rewards.lease_until is null or rewards.lease_until < now())
      and (
        rewards.status in ('PREPARED', 'SUBMITTING')
        or rewards.attempt < 20
      )
    order by case rewards.status when 'SUBMITTING' then 0 when 'PREPARED' then 1 else 2 end,
      rewards.created_at
    for update skip locked
    limit 1
  )
  update public.worker_rewards as rewards
  set status = case
        when rewards.status in ('PENDING', 'RETRYABLE', 'PROCESSING') then 'PROCESSING'
        else rewards.status
      end,
      attempt = least(rewards.attempt + 1, 20),
      lease_until = now() + interval '90 seconds'
  from candidate
  where rewards.journey_id = candidate.journey_id
    and rewards.chunk_id = candidate.chunk_id
  returning rewards.*;
end;
$$;

create or replace function public.release_worker_reward(
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
  update public.worker_rewards
  set status = case
        when signed_transaction is not null and tx_hash is not null then 'PREPARED'
        when attempt >= 20 then 'BLOCKED'
        else 'RETRYABLE'
      end,
      lease_until = case
        when signed_transaction is null and attempt >= 20 then null
        else now() + interval '20 seconds'
      end,
      last_error = left(p_error, 500)
  where journey_id = lower(p_journey_id)
    and chunk_id = p_chunk_id::smallint
    and status in ('PROCESSING', 'PREPARED', 'SUBMITTING', 'RETRYABLE');
  return found;
end;
$$;

alter table public.worker_rewards enable row level security;
alter table public.worker_rewards force row level security;
revoke all on table public.worker_rewards from public;
revoke execute on function public.confirm_chunk_and_enqueue_reward(text, integer, text, bigint, numeric, integer, text, numeric) from public;
revoke execute on function public.claim_worker_reward() from public;
revoke execute on function public.release_worker_reward(text, integer, text) from public;

do $$
begin
  if exists (select 1 from pg_roles where rolname = 'service_role') then
    grant all on table public.worker_rewards to service_role;
    grant execute on function public.confirm_chunk_and_enqueue_reward(text, integer, text, bigint, numeric, integer, text, numeric) to service_role;
    grant execute on function public.claim_worker_reward() to service_role;
    grant execute on function public.release_worker_reward(text, integer, text) to service_role;
  end if;
end;
$$;

comment on table public.worker_rewards is
  'Independent, idempotent Worker compensation queue. Moss verifies the native MON transfer; Moss never signs or broadcasts it.';
comment on column public.worker_rewards.signed_transaction is
  'A pre-signed immutable transaction persisted before broadcast so recovery can replay the same hash without double-paying.';

commit;
