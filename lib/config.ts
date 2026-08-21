/**
 * Fragment share links: the whole portal config, base64url-encoded.
 *
 * The fragment is never transmitted to a server, so this path keeps the
 * document URL on the client and needs no backend at all. It is the fallback
 * whenever Supabase is not configured.
 */
import type { PortalConfig } from './types';
import { parseUrl } from './embed';
import { isLockPayload } from './lock';

export function encodeConfig(cfg: PortalConfig): string {
  const bytes = new TextEncoder().encode(JSON.stringify(cfg));
  let bin = '';
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export function decodeConfig(str: string): PortalConfig | null {
  try {
    let b = String(str).replace(/-/g, '+').replace(/_/g, '/');
    while (b.length % 4) b += '=';
    const bin = atob(b);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    const cfg = JSON.parse(new TextDecoder().decode(bytes)) as PortalConfig;
    if (!cfg || typeof cfg.u !== 'string') return null;
    // A locked portal carries no plaintext URL at all — the encrypted payload
    // is what has to be well-formed instead.
    if (cfg.p) return isLockPayload(cfg.p) ? cfg : null;
    if (!parseUrl(cfg.u)) return null;
    return cfg;
  } catch {
    return null;
  }
}
