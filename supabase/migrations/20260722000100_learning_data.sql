begin;

create table public.learning_journeys (
  id uuid primary key default gen_random_uuid(),
  journey_id text not null unique check (journey_id ~ '^0x[0-9a-f]{64}$'),
  learner_address text not null check (learner_address ~ '^0x[0-9a-f]{40}$'),
  goal text check (goal is null or char_length(goal) between 1 and 500),
  source_hash text not null check (source_hash ~ '^0x[0-9a-f]{64}$'),
  goal_hash text not null check (goal_hash ~ '^0x[0-9a-f]{64}$'),
  chunk_manifest_root text not null check (chunk_manifest_root ~ '^0x[0-9a-f]{64}$'),
  chunk_count smallint not null check (chunk_count between 2 and 4),
  status text not null check (
    status in (
      'PREPARING',
      'AWAITING_CREATE_TX',
      'CREATED',
      'GENERATING',
      'FINALIZING',
      'READY',
      'FAILED_RETRYABLE',
      'CANCELLED'
    )
  ),
  deck jsonb,
  card_provenance jsonb,
  deck_root text check (deck_root is null or deck_root ~ '^0x[0-9a-f]{64}$'),
  plan jsonb,
  plan_hash text check (plan_hash is null or plan_hash ~ '^0x[0-9a-f]{64}$'),
  plan_version integer not null default 1 check (plan_version > 0),
  fsrs_states jsonb not null default '{}'::jsonb,
  create_tx_hash text check (create_tx_hash is null or create_tx_hash ~ '^0x[0-9a-f]{64}$'),
  finalize_tx_hash text check (finalize_tx_hash is null or finalize_tx_hash ~ '^0x[0-9a-f]{64}$'),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table public.source_chunks (
  journey_id text not null references public.learning_journeys(journey_id) on delete cascade,
  chunk_id smallint not null check (chunk_id between 0 and 3),
  page_start smallint not null check (page_start > 0),
  page_end smallint not null check (page_end >= page_start),
  title text not null check (char_length(title) between 1 and 200),
  source_text text,
  source_pages jsonb check (source_pages is null or jsonb_typeof(source_pages) = 'array'),
  source_chunk_hash text not null check (source_chunk_hash ~ '^0x[0-9a-f]{64}$'),
  manifest_proof jsonb not null check (jsonb_typeof(manifest_proof) = 'array'),
  card_budget smallint not null check (card_budget between 1 and 30),
  worker_address text check (worker_address is null or worker_address ~ '^0x[0-9a-f]{40}$'),
  attempt integer not null default 0 check (attempt between 0 and 2),
  status text not null check (
    status in (
      'QUEUED',
      'GENERATING',
      'VALIDATING',
      'SAVED',
      'SUBMITTING',
      'CONFIRMED',
      'MERGED',
      'RETRYABLE'
    )
  ),
  cards jsonb not null default '[]'::jsonb check (jsonb_typeof(cards) = 'array'),
  cards_root text check (cards_root is null or cards_root ~ '^0x[0-9a-f]{64}$'),
  card_count smallint check (card_count is null or card_count between 1 and 30),
  commit_tx_hash text check (commit_tx_hash is null or commit_tx_hash ~ '^0x[0-9a-f]{64}$'),
  confirmed_block bigint check (confirmed_block is null or confirmed_block >= 0),
  gas_used numeric(30, 0) check (gas_used is null or gas_used >= 0),
  generation_ms integer check (generation_ms is null or generation_ms >= 0),
  confirmation_ms integer check (confirmation_ms is null or confirmation_ms >= 0),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (journey_id, chunk_id)
);

create table public.review_logs (
  id uuid primary key default gen_random_uuid(),
  journey_id text not null references public.learning_journeys(journey_id) on delete cascade,
  session_id uuid not null,
  card_id text not null check (card_id ~ '^0x[0-9a-f]{64}$'),
  rating text not null check (rating in ('again', 'hard', 'good', 'easy')),
  response_ms integer not null check (response_ms between 0 and 3600000),
  reviewed_at timestamptz not null,
  fsrs_before jsonb,
  fsrs_after jsonb,
  created_at timestamptz not null default now(),
  unique (journey_id, session_id, card_id)
);

create table public.agent_events (
  id bigint generated always as identity primary key,
  journey_id text not null references public.learning_journeys(journey_id) on delete cascade,
  chunk_id smallint check (chunk_id is null or chunk_id between 0 and 3),
  agent_role text not null check (
    agent_role in ('coordinator', 'worker-0', 'worker-1', 'worker-2', 'finalizer')
  ),
  event_type text not null check (char_length(event_type) between 1 and 80),
  payload jsonb not null default '{}'::jsonb,
  tx_hash text check (tx_hash is null or tx_hash ~ '^0x[0-9a-f]{64}$'),
  created_at timestamptz not null default now()
);

create table public.auth_nonces (
  nonce text primary key check (char_length(nonce) between 8 and 64),
  wallet_address text not null check (wallet_address ~ '^0x[0-9a-f]{40}$'),
  expires_at timestamptz not null,
  used_at timestamptz,
  created_at timestamptz not null default now()
);

create table public.wallet_sessions (
  id uuid primary key default gen_random_uuid(),
  wallet_address text not null check (wallet_address ~ '^0x[0-9a-f]{40}$'),
  token_hash text not null unique check (token_hash ~ '^[0-9a-f]{64}$'),
  expires_at timestamptz not null,
  revoked_at timestamptz,
  created_at timestamptz not null default now()
);

create index learning_journeys_owner_updated_idx
  on public.learning_journeys (learner_address, updated_at desc);
create index learning_journeys_status_updated_idx
  on public.learning_journeys (status, updated_at);
create index source_chunks_status_updated_idx
  on public.source_chunks (status, updated_at);
create index review_logs_journey_reviewed_idx
  on public.review_logs (journey_id, reviewed_at desc);
create index agent_events_journey_created_idx
  on public.agent_events (journey_id, created_at);
create index auth_nonces_expiry_idx on public.auth_nonces (expires_at);
create index wallet_sessions_expiry_idx on public.wallet_sessions (expires_at);

create function public.set_updated_at()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

create trigger learning_journeys_set_updated_at
before update on public.learning_journeys
for each row execute function public.set_updated_at();

create trigger source_chunks_set_updated_at
before update on public.source_chunks
for each row execute function public.set_updated_at();

create function public.prepare_learning_journey(p_journey jsonb, p_chunks jsonb)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_id uuid;
  v_chunk_count smallint := (p_journey->>'chunk_count')::smallint;
begin
  if jsonb_typeof(p_chunks) <> 'array' or jsonb_array_length(p_chunks) <> v_chunk_count then
    raise exception 'chunk payload does not match chunk_count';
  end if;

  if exists (
    select 1
    from jsonb_to_recordset(p_chunks) as item(chunk_id smallint)
    where item.chunk_id < 0 or item.chunk_id >= v_chunk_count
  ) then
    raise exception 'chunk_id outside manifest range';
  end if;

  if (
    select count(distinct item.chunk_id)
    from jsonb_to_recordset(p_chunks) as item(chunk_id smallint)
  ) <> v_chunk_count then
    raise exception 'chunk_id values must be unique and contiguous';
  end if;

  insert into public.learning_journeys (
    journey_id,
    learner_address,
    goal,
    source_hash,
    goal_hash,
    chunk_manifest_root,
    chunk_count,
    status
  ) values (
    lower(p_journey->>'journey_id'),
    lower(p_journey->>'learner_address'),
    nullif(btrim(p_journey->>'goal'), ''),
    lower(p_journey->>'source_hash'),
    lower(p_journey->>'goal_hash'),
    lower(p_journey->>'chunk_manifest_root'),
    v_chunk_count,
    'AWAITING_CREATE_TX'
  )
  returning id into v_id;

  insert into public.source_chunks (
    journey_id,
    chunk_id,
    page_start,
    page_end,
    title,
    source_text,
    source_pages,
    source_chunk_hash,
    manifest_proof,
    card_budget,
    status
  )
  select
    lower(p_journey->>'journey_id'),
    item.chunk_id,
    item.page_start,
    item.page_end,
    item.title,
    item.source_text,
    item.source_pages,
    lower(item.source_chunk_hash),
    item.manifest_proof,
    item.card_budget,
    'QUEUED'
  from jsonb_to_recordset(p_chunks) as item(
    chunk_id smallint,
    page_start smallint,
    page_end smallint,
    title text,
    source_text text,
    source_pages jsonb,
    source_chunk_hash text,
    manifest_proof jsonb,
    card_budget smallint
  );

  return v_id;
end;
$$;

create function public.consume_auth_nonce(p_nonce text, p_wallet_address text)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
begin
  update public.auth_nonces
  set used_at = now()
  where nonce = p_nonce
    and wallet_address = lower(p_wallet_address)
    and used_at is null
    and expires_at > now();
  return found;
end;
$$;

create function public.cleanup_journey_sources(p_journey_id text)
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  v_count integer;
begin
  update public.source_chunks
  set source_text = null,
      source_pages = null,
      cards = '[]'::jsonb
  where journey_id = lower(p_journey_id)
    and (source_text is not null or source_pages is not null or cards <> '[]'::jsonb);
  get diagnostics v_count = row_count;
  return v_count;
end;
$$;

create function public.cleanup_expired_source_data()
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  v_count integer;
begin
  update public.source_chunks as chunks
  set source_text = null,
      source_pages = null,
      cards = '[]'::jsonb
  from public.learning_journeys as journeys
  where journeys.journey_id = chunks.journey_id
    and journeys.updated_at < now() - interval '24 hours'
    and (
      chunks.source_text is not null
      or chunks.source_pages is not null
      or chunks.cards <> '[]'::jsonb
    );
  get diagnostics v_count = row_count;
  return v_count;
end;
$$;

create function public.cleanup_ready_journey_sources()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if new.status = 'READY' and old.status is distinct from 'READY' then
    perform public.cleanup_journey_sources(new.journey_id);
  end if;
  return new;
end;
$$;

create trigger learning_journeys_cleanup_ready
after update of status on public.learning_journeys
for each row execute function public.cleanup_ready_journey_sources();

alter table public.learning_journeys enable row level security;
alter table public.source_chunks enable row level security;
alter table public.review_logs enable row level security;
alter table public.agent_events enable row level security;
alter table public.auth_nonces enable row level security;
alter table public.wallet_sessions enable row level security;

alter table public.learning_journeys force row level security;
alter table public.source_chunks force row level security;
alter table public.review_logs force row level security;
alter table public.agent_events force row level security;
alter table public.auth_nonces force row level security;
alter table public.wallet_sessions force row level security;

revoke all on table public.learning_journeys from public;
revoke all on table public.source_chunks from public;
revoke all on table public.review_logs from public;
revoke all on table public.agent_events from public;
revoke all on table public.auth_nonces from public;
revoke all on table public.wallet_sessions from public;
revoke execute on function public.prepare_learning_journey(jsonb, jsonb) from public;
revoke execute on function public.consume_auth_nonce(text, text) from public;
revoke execute on function public.cleanup_journey_sources(text) from public;
revoke execute on function public.cleanup_expired_source_data() from public;

do $$
begin
  if exists (select 1 from pg_roles where rolname = 'anon') then
    revoke all on table public.learning_journeys from anon;
    revoke all on table public.source_chunks from anon;
    revoke all on table public.review_logs from anon;
    revoke all on table public.agent_events from anon;
    revoke all on table public.auth_nonces from anon;
    revoke all on table public.wallet_sessions from anon;
  end if;
  if exists (select 1 from pg_roles where rolname = 'authenticated') then
    revoke all on table public.learning_journeys from authenticated;
    revoke all on table public.source_chunks from authenticated;
    revoke all on table public.review_logs from authenticated;
    revoke all on table public.agent_events from authenticated;
    revoke all on table public.auth_nonces from authenticated;
    revoke all on table public.wallet_sessions from authenticated;
  end if;
  if exists (select 1 from pg_roles where rolname = 'service_role') then
    grant all on table public.learning_journeys to service_role;
    grant all on table public.source_chunks to service_role;
    grant all on table public.review_logs to service_role;
    grant all on table public.agent_events to service_role;
    grant all on table public.auth_nonces to service_role;
    grant all on table public.wallet_sessions to service_role;
    grant usage, select on all sequences in schema public to service_role;
    grant execute on function public.prepare_learning_journey(jsonb, jsonb) to service_role;
    grant execute on function public.consume_auth_nonce(text, text) to service_role;
    grant execute on function public.cleanup_journey_sources(text) to service_role;
    grant execute on function public.cleanup_expired_source_data() to service_role;
  end if;
end;
$$;

comment on table public.source_chunks is
  'Temporary source text and Worker drafts; never exposed directly to browser clients.';
comment on column public.agent_events.payload is
  'Redacted operational metadata only; never store source text, full prompts, hidden reasoning, or secrets.';

commit;
