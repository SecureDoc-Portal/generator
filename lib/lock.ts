/**
 * Password locking for a portal's document URL.
 *
 * The point of this module is that the password check is *not* a comparison
 * the page could be talked out of. The document URL is encrypted with
 * AES-GCM under a key derived from the password, and the plaintext never
 * appears in the generated file, the share link or the database row. A wrong
 * password fails at the GCM authentication tag, so there is nothing to patch
 * out in DevTools and nothing to read in View Source: without the password
 * the URL simply is not present.
 *
 * What it deliberately does not defend against: someone who knows the
 * password can still read the URL, and a share link plus an offline
 * brute-force attack on a weak password will eventually succeed. The
 * iteration count is the only lever there, and it is stored per-payload so it
 * can be raised later without invalidating links already handed out.
 */

/** Portable, self-describing ciphertext. Everything except the key. */
export interface LockPayload {
  /** Payload version, so the runtime can refuse shapes it does not know. */
  v: 1;
  /**
   * Origin of the encrypted URL, kept in the clear on purpose: the portal
   * preconnects to it while the password is being typed, which is most of
   * the reason an unlocked document appears instantly. An origin such as
   * `https://docs.google.com` identifies the host, never the document.
   */
  o: string;
  /** PBKDF2 salt, base64url. */
  s: string;
  /** AES-GCM IV, base64url. */
  i: string;
  /** Ciphertext with the appended GCM tag, base64url. */
  c: string;
  /** PBKDF2 iteration count. */
  n: number;
}

/**
 * PBKDF2-HMAC-SHA256 rounds. OWASP's 2023 floor is 600k; this sits below it
 * deliberately, because the derivation runs on the viewer's device and a
 * mid-range phone spends roughly a second per 300k rounds. Raising it costs
 * the honest viewer exactly as much as the attacker, and links minted at a
 * lower count keep working because the count travels in the payload.
 */
export const LOCK_ITERATIONS = 300_000;

export const MIN_PASSWORD_LENGTH = 6;
export const MAX_PASSWORD_LENGTH = 128;

function b64u(bytes: ArrayBuffer | Uint8Array): string {
  const arr = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  let bin = '';
  for (let i = 0; i < arr.length; i++) bin += String.fromCharCode(arr[i]);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function unb64u(str: string): Uint8Array {
  let b = String(str).replace(/-/g, '+').replace(/_/g, '/');
  while (b.length % 4) b += '=';
  const bin = atob(b);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

/** True when SubtleCrypto is actually usable — it needs a secure context. */
export function canLock(): boolean {
  return typeof crypto !== 'undefined' && !!crypto.subtle && !!crypto.getRandomValues;
}

async function deriveKey(
  password: string, salt: Uint8Array, iterations: number, usage: KeyUsage[],
): Promise<CryptoKey> {
  const material = await crypto.subtle.importKey(
    'raw', new TextEncoder().encode(password), 'PBKDF2', false, ['deriveKey'],
  );
  return crypto.subtle.deriveKey(
    { name: 'PBKDF2', salt: salt as unknown as BufferSource, iterations, hash: 'SHA-256' },
    material,
    { name: 'AES-GCM', length: 256 },
    false,
    usage,
  );
}

/** Encrypts a document URL under a password. Runs once, in the builder. */
export async function lockUrl(url: string, password: string): Promise<LockPayload> {
  if (!canLock()) throw new Error('This browser cannot encrypt (SubtleCrypto is unavailable).');
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const key = await deriveKey(password, salt, LOCK_ITERATIONS, ['encrypt']);
  const ct = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv: iv as unknown as BufferSource },
    key,
    new TextEncoder().encode(url),
  );

  let origin = '';
  try { origin = new URL(url).origin; } catch { origin = ''; }

  return { v: 1, o: origin, s: b64u(salt), i: b64u(iv), c: b64u(ct), n: LOCK_ITERATIONS };
}

/**
 * Decrypts a payload. Used by the tests; the generated portal carries its own
 * inlined copy of this so it stays a single self-contained file.
 *
 * Rejects on a wrong password — AES-GCM refuses to return plaintext whose tag
 * does not verify, which is what makes the gate real rather than cosmetic.
 */
export async function unlockUrl(payload: LockPayload, password: string): Promise<string> {
  if (!canLock()) throw new Error('This browser cannot decrypt (SubtleCrypto is unavailable).');
  if (!payload || payload.v !== 1) throw new Error('Unsupported lock payload.');
  const salt = unb64u(payload.s);
  const iv = unb64u(payload.i);
  const key = await deriveKey(password, salt, payload.n, ['decrypt']);
  const plain = await crypto.subtle.decrypt(
    { name: 'AES-GCM', iv: iv as unknown as BufferSource },
    key,
    unb64u(payload.c) as unknown as BufferSource,
  );
  return new TextDecoder().decode(plain);
}

/** Shape check for a payload arriving from a link or the database. */
export function isLockPayload(value: unknown): value is LockPayload {
  if (!value || typeof value !== 'object') return false;
  const p = value as Record<string, unknown>;
  return p.v === 1
    && typeof p.s === 'string' && typeof p.i === 'string' && typeof p.c === 'string'
    && typeof p.n === 'number' && p.n > 0
    && (p.o === undefined || typeof p.o === 'string');
}
