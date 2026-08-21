-- ---------------------------------------------------------------------------
-- SecureDoc Portal — schema
--
-- Design note: portal rows are NOT readable with the anon key, not even by
-- their owner's viewers. Every read goes through the resolve-portal Edge
-- Function, which holds the service-role key. That is what makes revocation,
-- expiry, view limits and passcodes actually enforceable — if the browser
-- could SELECT the config directly, all four would be advisory only.
-- ---------------------------------------------------------------------------

create extension if not exists pgcrypto;

-- ---------------------------------------------------------------------------
-- portals
-- ---------------------------------------------------------------------------
create table if not exists public.portals (
    id              text primary key
                    check (id ~ '^[A-Za-z0-9_-]{8,32}$'),
    owner_id        uuid not null references auth.users (id) on delete cascade,

    -- The PortalConfig object (see lib/types.ts). Kept as jsonb so the shape
    -- can grow without a migration; validated in the Edge Function.
    config          jsonb not null,

    -- Denormalised for the owner's dashboard, so listing portals never has to
    -- expose config (which contains the document URL).
    title           text not null default 'Untitled',
    classification  text not null default 'Confidential',

    -- Access controls, all enforced server-side in resolve-portal.
    passcode_hash   text,                       -- crypt()ed; null = no passcode
    expires_at      timestamptz,                -- null = never expires
    max_views       integer check (max_views is null or max_views > 0),
    view_count      integer not null default 0,
    revoked_at      timestamptz,

    created_at      timestamptz not null default now(),
    updated_at      timestamptz not null default now()
);

comment on table public.portals is
    'Protected document portals. Readable only via the resolve-portal Edge Function.';
comment on column public.portals.config is
    'PortalConfig JSON: document URL, metadata and the feature bitmask.';

create index if not exists portals_owner_created_idx
    on public.portals (owner_id, created_at desc);

-- ---------------------------------------------------------------------------
-- portal_views — the audit trail
-- ---------------------------------------------------------------------------
create table if not exists public.portal_views (
    id          bigint generated always as identity primary key,
    portal_id   text not null references public.portals (id) on delete cascade,
    viewed_at   timestamptz not null default now(),

    -- 'granted' plus every refusal reason, so the owner can see attempts that
    -- were blocked rather than only successful opens.
    outcome     text not null
                check (outcome in ('granted','revoked','expired','exhausted','bad_passcode','not_found')),

    user_agent  text,
    -- Salted hash, never a raw address: enough to spot one person opening a
    -- link fifty times without storing anything personally identifying.
    ip_hash     text
);

create index if not exists portal_views_portal_idx
    on public.portal_views (portal_id, viewed_at desc);

-- ---------------------------------------------------------------------------
-- updated_at maintenance
-- ---------------------------------------------------------------------------
create or replace function public.touch_updated_at()
returns trigger
language plpgsql
as $$
begin
    new.updated_at = now();
    return new;
end;
$$;

drop trigger if exists portals_touch_updated_at on public.portals;
create trigger portals_touch_updated_at
    before update on public.portals
    for each row execute function public.touch_updated_at();

-- ---------------------------------------------------------------------------
-- Convenience view for the owner dashboard: counts without exposing config.
-- security_invoker keeps the caller's RLS in force rather than the definer's.
-- ---------------------------------------------------------------------------
create or replace view public.portal_summary
with (security_invoker = true) as
select
    p.id,
    p.owner_id,
    p.title,
    p.classification,
    p.created_at,
    p.expires_at,
    p.revoked_at,
    p.max_views,
    p.view_count,
    (p.passcode_hash is not null) as has_passcode,
    (
        p.revoked_at is null
        and (p.expires_at is null or p.expires_at > now())
        and (p.max_views is null or p.view_count < p.max_views)
    ) as is_active
from public.portals p;
