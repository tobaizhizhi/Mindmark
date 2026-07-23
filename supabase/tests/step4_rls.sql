begin;

select plan(8);

select ok(
  (select relrowsecurity from pg_class where oid = 'public.learning_journeys'::regclass),
  'learning_journeys has RLS enabled'
);
select ok(
  (select relrowsecurity from pg_class where oid = 'public.source_chunks'::regclass),
  'source_chunks has RLS enabled'
);
select ok(
  (select relrowsecurity from pg_class where oid = 'public.review_logs'::regclass),
  'review_logs has RLS enabled'
);
select ok(
  (select relrowsecurity from pg_class where oid = 'public.agent_events'::regclass),
  'agent_events has RLS enabled'
);
select ok(
  (select relrowsecurity from pg_class where oid = 'public.auth_nonces'::regclass),
  'auth_nonces has RLS enabled'
);
select ok(
  (select relrowsecurity from pg_class where oid = 'public.wallet_sessions'::regclass),
  'wallet_sessions has RLS enabled'
);
select is(
  (select count(*)::integer from pg_policies where schemaname = 'public'),
  0,
  'browser roles have no direct table policy'
);
select has_unique('public', 'review_logs', array['journey_id', 'session_id', 'card_id']);

select * from finish();
rollback;

