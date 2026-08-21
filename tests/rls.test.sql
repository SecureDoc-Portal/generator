\set ON_ERROR_STOP off
-- two users
insert into auth.users (id, email) values
  ('11111111-1111-1111-1111-111111111111','alice@example.com'),
  ('22222222-2222-2222-2222-222222222222','bob@example.com');

-- grants Supabase issues by default
grant usage on schema public to anon, authenticated, service_role;
grant select, insert, update, delete on public.portals to authenticated;
grant select on public.portal_views to authenticated;
grant select on public.portal_summary to authenticated;
grant all on public.portals, public.portal_views to service_role;

-- seed as service_role (the Edge Function's role)
set role service_role;
insert into public.portals (id, owner_id, config, title) values
  ('alice_doc_1','11111111-1111-1111-1111-111111111111','{"u":"https://docs.google.com/x/preview"}','Alice Report'),
  ('bob_doc_1','22222222-2222-2222-2222-222222222222','{"u":"https://docs.google.com/y/preview"}','Bob Report');
insert into public.portal_views (portal_id, outcome) values ('alice_doc_1','granted');
reset role;

\echo '=== 1. anon SELECT on portals (must be 0 rows: config is not public) ==='
set role anon;
select count(*) as anon_visible_portals from public.portals;
\echo '=== 2. anon INSERT into portal_views (must FAIL: audit cannot be forged) ==='
insert into public.portal_views (portal_id, outcome) values ('alice_doc_1','granted');
\echo '=== 3. anon UPDATE to un-revoke (must FAIL or affect 0 rows) ==='
update public.portals set revoked_at = null where id = 'alice_doc_1';
reset role;

\echo '=== 4. alice sees only her own portal ==='
set role authenticated;
set request.jwt.claim.sub = '11111111-1111-1111-1111-111111111111';
select id, title from public.portals order by id;
\echo '=== 5. alice cannot see bob rows even when naming them ==='
select count(*) as bob_rows_visible_to_alice from public.portals where id = 'bob_doc_1';
\echo '=== 6. alice cannot steal a row by reassigning owner_id (must FAIL) ==='
update public.portals set owner_id = '11111111-1111-1111-1111-111111111111' where id = 'bob_doc_1';
\echo '=== 7. alice CAN revoke her own portal ==='
update public.portals set revoked_at = now() where id = 'alice_doc_1';
select id, (revoked_at is not null) as revoked from public.portals where id='alice_doc_1';
\echo '=== 8. alice sees only her own audit rows ==='
select portal_id, outcome from public.portal_views;
\echo '=== 9. alice cannot insert an audit row herself (must FAIL) ==='
insert into public.portal_views (portal_id, outcome) values ('alice_doc_1','granted');
\echo '=== 10. alice cannot create a portal owned by bob (must FAIL) ==='
insert into public.portals (id, owner_id, config, title)
  values ('sneaky','22222222-2222-2222-2222-222222222222','{"u":"https://x/preview"}','Sneaky');
reset role;

\echo '=== 11. bob sees only his own via the summary view ==='
set role authenticated;
set request.jwt.claim.sub = '22222222-2222-2222-2222-222222222222';
select id, title, is_active, has_passcode from public.portal_summary order by id;
reset role;

\echo '=== 12. service_role (Edge Function) can read everything ==='
set role service_role;
select count(*) as service_role_visible from public.portals;
reset role;

\echo '=== 13. id format constraint rejects junk ==='
set role service_role;
insert into public.portals (id, owner_id, config) values ('bad id!','11111111-1111-1111-1111-111111111111','{}');
reset role;
