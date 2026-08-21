-- ---------------------------------------------------------------------------
-- Row Level Security
--
-- The rule that matters: there is no SELECT policy on public.portals for
-- anon or authenticated roles that exposes `config`. Owners manage their own
-- rows; viewers never touch the table directly. The Edge Function uses the
-- service-role key, which bypasses RLS by design.
-- ---------------------------------------------------------------------------

alter table public.portals      enable row level security;
alter table public.portal_views enable row level security;

-- force RLS even for the table owner role, so a mistake elsewhere cannot leak
alter table public.portals      force row level security;
alter table public.portal_views force row level security;

-- --------------------------- portals ---------------------------------------

drop policy if exists portals_owner_select on public.portals;
create policy portals_owner_select
    on public.portals for select
    to authenticated
    using (owner_id = (select auth.uid()));

drop policy if exists portals_owner_insert on public.portals;
create policy portals_owner_insert
    on public.portals for insert
    to authenticated
    with check (owner_id = (select auth.uid()));

-- Owners may revoke and adjust limits. owner_id is pinned by the WITH CHECK so
-- a row cannot be handed to somebody else.
drop policy if exists portals_owner_update on public.portals;
create policy portals_owner_update
    on public.portals for update
    to authenticated
    using (owner_id = (select auth.uid()))
    with check (owner_id = (select auth.uid()));

drop policy if exists portals_owner_delete on public.portals;
create policy portals_owner_delete
    on public.portals for delete
    to authenticated
    using (owner_id = (select auth.uid()));

-- Deliberately absent: any policy granting anon SELECT. A viewer opening a
-- short link reaches the config only through resolve-portal.

-- ------------------------- portal_views ------------------------------------

drop policy if exists portal_views_owner_select on public.portal_views;
create policy portal_views_owner_select
    on public.portal_views for select
    to authenticated
    using (
        exists (
            select 1 from public.portals p
            where p.id = portal_views.portal_id
              and p.owner_id = (select auth.uid())
        )
    );

-- No INSERT policy: only the Edge Function (service role) writes audit rows,
-- so a viewer cannot forge or suppress them.
