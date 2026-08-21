-- Server-side routine checks. Run after tests/rls.test.sql setup.
-- Expected failures (the pass condition) are marked MUST FAIL.
insert into auth.users (id,email) values ('33333333-3333-3333-3333-333333333333','carol@example.com')
  on conflict do nothing;

set role service_role;
insert into public.portals (id, owner_id, config, title, max_views)
  values ('pass_test_1','33333333-3333-3333-3333-333333333333','{"u":"https://x/preview"}','Secret',2)
  on conflict (id) do nothing;
reset role;

\echo '=== owner sets a passcode ==='
set role authenticated;
set request.jwt.claim.sub = '33333333-3333-3333-3333-333333333333';
select public.set_portal_passcode('pass_test_1','hunter2');
reset role;

\echo '=== stored as bcrypt, never plaintext ==='
select substring(passcode_hash for 7) as algo, (passcode_hash = 'hunter2') as stores_plaintext
  from public.portals where id='pass_test_1';

\echo '=== verify correct / wrong / null ==='
set role service_role;
select public.verify_portal_passcode('pass_test_1','hunter2') as correct,
       public.verify_portal_passcode('pass_test_1','wrong')   as wrong,
       public.verify_portal_passcode('pass_test_1', null)     as null_pass;
reset role;

\echo '=== MUST FAIL: non-owner sets a passcode ==='
set role authenticated;
set request.jwt.claim.sub = '11111111-1111-1111-1111-111111111111';
select public.set_portal_passcode('pass_test_1','pwned');
reset role;

\echo '=== MUST FAIL: authenticated calls verify (service_role only) ==='
set role authenticated;
set request.jwt.claim.sub = '33333333-3333-3333-3333-333333333333';
select public.verify_portal_passcode('pass_test_1','hunter2');
reset role;

\echo '=== atomic increment honours max_views ==='
set role service_role;
select public.increment_portal_view('pass_test_1') as after_1;
select public.increment_portal_view('pass_test_1') as after_2;
select view_count, max_views, (view_count >= max_views) as exhausted
  from public.portals where id='pass_test_1';
reset role;

\echo '=== MUST FAIL: anon calls increment ==='
set role anon;
select public.increment_portal_view('pass_test_1');
reset role;
