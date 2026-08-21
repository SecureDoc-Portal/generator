/**
 * resolve-portal — the only path to a portal's config.
 *
 * Runs on Supabase Edge Functions (Deno) with the service-role key, which
 * bypasses RLS. Everything that must not be bypassable lives here:
 *
 *   - revocation, expiry and view limits are checked before the config is
 *     released, not after it has already reached the browser;
 *   - the passcode is verified in Postgres via pgcrypto, so the hash
 *     never leaves the database;
 *   - every attempt is written to portal_views, including refusals, and the
 *     viewer cannot suppress or forge those rows.
 *
 * Deploy:  supabase functions deploy resolve-portal --no-verify-jwt
 * Secrets: supabase secrets set VIEW_LOG_IP_SALT=<random>
 *          (SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are injected)
 */
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

type Outcome = 'granted' | 'revoked' | 'expired' | 'exhausted' | 'bad_passcode' | 'not_found';

const CORS = {
  'Access-Control-Allow-Origin': Deno.env.get('ALLOWED_ORIGIN') ?? '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { ...CORS, 'Content-Type': 'application/json' },
  });

/** Salted hash of the caller IP: enough to spot abuse, not personally identifying. */
async function hashIp(ip: string): Promise<string | null> {
  const salt = Deno.env.get('VIEW_LOG_IP_SALT');
  if (!salt || !ip) return null;
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(salt + ip));
  return Array.from(new Uint8Array(buf)).slice(0, 16)
    .map((b) => b.toString(16).padStart(2, '0')).join('');
}

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS });
  if (req.method !== 'POST') return json({ reason: 'error', message: 'Use POST.' }, 405);

  const admin = createClient(
    Deno.env.get('SUPABASE_URL')!,
    Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,
    { auth: { persistSession: false } },
  );

  let id = '';
  let passcode = '';
  try {
    const body = await req.json();
    id = typeof body?.id === 'string' ? body.id : '';
    passcode = typeof body?.passcode === 'string' ? body.passcode : '';
  } catch {
    return json({ reason: 'error', message: 'Malformed request.' }, 400);
  }
  if (!/^[A-Za-z0-9_-]{8,32}$/.test(id)) {
    return json({ reason: 'not_found', message: 'No such portal.' }, 404);
  }

  const ipHash = await hashIp(req.headers.get('x-forwarded-for')?.split(',')[0].trim() ?? '');
  const userAgent = (req.headers.get('user-agent') ?? '').slice(0, 400);

  // Audit first-class: a refusal is as interesting to the owner as a success.
  const log = async (outcome: Outcome) => {
    await admin.from('portal_views').insert({
      portal_id: id, outcome, user_agent: userAgent, ip_hash: ipHash,
    });
  };

  const { data: portal, error } = await admin
    .from('portals')
    .select('id, config, title, passcode_hash, expires_at, revoked_at, max_views, view_count')
    .eq('id', id)
    .maybeSingle();

  if (error) return json({ reason: 'error', message: 'Lookup failed.' }, 500);
  if (!portal) {
    // No audit row: the portal does not exist, so there is nothing to attach it to.
    return json({ reason: 'not_found', message: 'This link does not exist.' }, 404);
  }

  if (portal.revoked_at) {
    await log('revoked');
    return json({ reason: 'revoked', message: 'This link has been revoked by its owner.' }, 403);
  }
  if (portal.expires_at && new Date(portal.expires_at).getTime() <= Date.now()) {
    await log('expired');
    return json({ reason: 'expired', message: 'This link has expired.' }, 403);
  }
  if (portal.max_views !== null && portal.view_count >= portal.max_views) {
    await log('exhausted');
    return json({ reason: 'exhausted', message: 'This link has reached its view limit.' }, 403);
  }

  if (portal.passcode_hash) {
    if (!passcode) {
      // Not logged: this is the normal first request, before the prompt is shown.
      return json({ reason: 'passcode_required', message: 'This document needs a passcode.' }, 401);
    }
    // Hashing lives in Postgres (pgcrypto), so there is one implementation
    // and the hash never leaves the database.
    const { data: ok, error: pcErr } = await admin
      .rpc('verify_portal_passcode', { p_id: id, p_passcode: passcode });
    if (pcErr) return json({ reason: 'error', message: 'Verification failed.' }, 500);
    if (!ok) {
      await log('bad_passcode');
      return json({ reason: 'bad_passcode', message: 'That passcode is not correct.' }, 401);
    }
  }

  // Count the view before releasing the config, so a client that drops the
  // response still consumed its allowance.
  await admin.rpc('increment_portal_view', { p_id: id });
  await log('granted');

  return json({ ok: true, config: portal.config, title: portal.title });
});
