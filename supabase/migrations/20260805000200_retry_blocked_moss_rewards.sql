begin;

create function public.retry_blocked_work_unit_reward_v2(
  p_project_id text,
  p_work_unit_id integer
)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare
  v_job_id uuid;
begin
  update public.work_unit_rewards
  set status = 'RETRYABLE',
      attempt = 0,
      lease_until = null,
      moss_stage = 'PENDING',
      moss_plan_hash = null,
      simulation_status = 'NOT_RUN',
      simulation_warning_codes = '[]'::jsonb,
      simulation_gas = null,
      signed_transaction = null,
      treasury_nonce = null,
      tx_hash = null,
      confirmed_block = null,
      gas_used = null,
      confirmation_ms = null,
      last_error = null
  where project_id = lower(p_project_id)
    and work_unit_id = p_work_unit_id::smallint
    and status = 'BLOCKED';

  if not found then return false; end if;

  v_job_id := public.enqueue_workflow_job_v2(
    lower(p_project_id),
    'SETTLE_WORK_UNIT_REWARD',
    null,
    p_work_unit_id
  );
  return v_job_id is not null;
end;
$$;

revoke execute on function public.retry_blocked_work_unit_reward_v2(text, integer) from public;

do $$
begin
  if exists (select 1 from pg_roles where rolname = 'service_role') then
    grant execute on function public.retry_blocked_work_unit_reward_v2(text, integer) to service_role;
  end if;
end;
$$;

commit;
