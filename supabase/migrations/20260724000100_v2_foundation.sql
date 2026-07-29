begin;

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

alter table public.auth_nonces enable row level security;
alter table public.wallet_sessions enable row level security;
alter table public.auth_nonces force row level security;
alter table public.wallet_sessions force row level security;
revoke all on table public.auth_nonces from public;
revoke all on table public.wallet_sessions from public;
revoke execute on function public.consume_auth_nonce(text, text) from public;

do $$
begin
  if exists (select 1 from pg_roles where rolname = 'anon') then
    revoke all on table public.auth_nonces from anon;
    revoke all on table public.wallet_sessions from anon;
  end if;
  if exists (select 1 from pg_roles where rolname = 'authenticated') then
    revoke all on table public.auth_nonces from authenticated;
    revoke all on table public.wallet_sessions from authenticated;
  end if;
  if exists (select 1 from pg_roles where rolname = 'service_role') then
    grant all on table public.auth_nonces to service_role;
    grant all on table public.wallet_sessions to service_role;
    grant usage, select on all sequences in schema public to service_role;
    grant execute on function public.consume_auth_nonce(text, text) to service_role;
  end if;
end;
$$;

commit;
