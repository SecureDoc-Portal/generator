-- ---------------------------------------------------------------------------
-- Server-side routines.
--
-- Passcode hashing and verification both live here, in pgcrypto, so there is
-- exactly one implementation and the plaintext never persists anywhere. The
-- Edge Function calls verify_portal_passcode rather than hashing in Deno.
-- ---------------------------------------------------------------------------

-- Atomic increment. Doing this as UPDATE ... SET view_count = view_count + 1
-- inside the database avoids the read-modify-write race that would let two
-- simultaneous viewers share one allowance on a max_views-limited link.
create or replace function public.increment_portal_view(p_id text)
returns integer
language sql
security definer
set search_path = public, pg_temp
as $$
    update public.portals
       set view_count = view_count + 1
     where id = p_id
    returning view_count;
$$;

revoke all on function public.increment_portal_view(text) from public, anon, authenticated;
grant execute on function public.increment_portal_view(text) to service_role;

-- ---------------------------------------------------------------------------
-- Passcode handling
-- ---------------------------------------------------------------------------

-- Owners set or clear a passcode on their own portal. SECURITY DEFINER so the
-- hashing happens server-side, but the ownership check is explicit rather than
-- relying on the caller's RLS.
create or replace function public.set_portal_passcode(p_id text, p_passcode text)
returns void
language plpgsql
security definer
set search_path = public, extensions, pg_temp
as $$
declare
    v_owner uuid;
begin
    select owner_id into v_owner from public.portals where id = p_id;
    if v_owner is null then
        raise exception 'portal not found';
    end if;
    if v_owner <> auth.uid() then
        raise exception 'not your portal';
    end if;

    update public.portals
       set passcode_hash = case
               when p_passcode is null or length(p_passcode) = 0 then null
               else extensions.crypt(p_passcode, extensions.gen_salt('bf', 10))
           end
     where id = p_id;
end;
$$;

revoke all on function public.set_portal_passcode(text, text) from public, anon;
grant execute on function public.set_portal_passcode(text, text) to authenticated;

-- Verification is service_role only: the Edge Function is the sole caller.
-- Returning a bare boolean keeps the hash itself out of reach.
create or replace function public.verify_portal_passcode(p_id text, p_passcode text)
returns boolean
language plpgsql
security definer
set search_path = public, extensions, pg_temp
as $$
declare
    v_hash text;
begin
    select passcode_hash into v_hash from public.portals where id = p_id;
    if v_hash is null then
        return true;              -- no passcode set on this portal
    end if;
    if p_passcode is null then
        return false;
    end if;
    return v_hash = extensions.crypt(p_passcode, v_hash);
end;
$$;

revoke all on function public.verify_portal_passcode(text, text) from public, anon, authenticated;
grant execute on function public.verify_portal_passcode(text, text) to service_role;
