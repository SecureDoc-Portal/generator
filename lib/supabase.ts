/**
 * Browser Supabase client.
 *
 * The anon key is public by design — it is compiled into the static bundle
 * and grants only what Row Level Security allows. Nothing privileged runs
 * here; the service-role key lives exclusively in Edge Function secrets.
 *
 * Returns null when the project is not configured, so the app degrades to
 * fragment-only share links instead of crashing.
 */
import { createClient, type SupabaseClient } from '@supabase/supabase-js';

const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;

let client: SupabaseClient | null = null;

export function getSupabase(): SupabaseClient | null {
  if (!url || !anonKey || url.includes('YOUR-PROJECT-REF')) return null;
  if (!client) {
    client = createClient(url, anonKey, {
      auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: true },
    });
  }
  return client;
}

export const isBackendConfigured = (): boolean => getSupabase() !== null;

/** Base URL of the deployed site, used to build short links. */
export function siteBase(): string {
  if (typeof window === 'undefined') return '';
  const bp = process.env.NEXT_PUBLIC_BASE_PATH || '';
  return window.location.origin + bp;
}

/** Calls the resolve-portal Edge Function — the only way to read a portal. */
export async function resolvePortal(id: string, passcode?: string) {
  const sb = getSupabase();
  if (!sb) return { ok: false as const, reason: 'error' as const, message: 'Backend is not configured.' };
  const { data, error } = await sb.functions.invoke('resolve-portal', {
    body: { id, passcode: passcode || undefined },
  });
  if (error) {
    // Edge Functions surface 4xx as FunctionsHttpError; the body carries the reason.
    const ctx = (error as unknown as { context?: Response }).context;
    if (ctx && typeof ctx.json === 'function') {
      try {
        const body = await ctx.json();
        if (body?.reason) return { ok: false as const, reason: body.reason, message: body.message || 'Access denied.' };
      } catch { /* fall through */ }
    }
    return { ok: false as const, reason: 'error' as const, message: error.message || 'Could not reach the server.' };
  }
  return data;
}
