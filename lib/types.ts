/** Shared shape of a portal, used by the builder, the share link and the DB. */
import type { LockPayload } from './lock';

export interface PortalConfig {
  /**
   * Embeddable document URL (already run through toEmbedUrl).
   *
   * Empty when the portal is password-locked: the URL then lives only inside
   * `p`, encrypted, so that neither the share link nor the generated file
   * carries it in the clear.
   */
  u: string;
  /** Document title. */
  t: string;
  /** Owner name shown in the viewer. */
  o: string;
  /** Classification label — must be a key of CLASS_THEME. */
  c: string;
  /** Access level label. */
  a: string;
  /** Session length in minutes. */
  s: number;
  /** Watermark text; falls back to the classification when blank. */
  w: string;
  /** Feature bitmask over FEATURE_ORDER. */
  f: number;
  /**
   * Password lock. Present only when the portal is locked, in which case `u`
   * is empty and the real URL is recoverable from this and nothing else.
   */
  p?: LockPayload | null;
}

/**
 * Order is part of the share-link format and of every stored portal row:
 * append only, never reorder, or existing links decode with the wrong
 * features enabled.
 */
export const FEATURE_ORDER = [
  'copyProtect', 'screenshotProtect', 'printBlock', 'devtoolsDetect',
  'watermark', 'idleLock', 'sessionTimer', 'frameGuard', 'xorEncrypt', 'frameSandbox',
] as const;

export type FeatureName = (typeof FEATURE_ORDER)[number];

export interface ClassTheme { bg: string; bd: string; fg: string; dot: string }

export const CLASS_THEME: Record<string, ClassTheme> = {
  'Confidential':  { bg: 'rgba(239,68,68,0.10)',  bd: 'rgba(239,68,68,0.28)',  fg: '#fca5a5', dot: '#ef4444' },
  'Internal Only': { bg: 'rgba(59,130,246,0.10)', bd: 'rgba(59,130,246,0.28)', fg: '#93c5fd', dot: '#3b82f6' },
  'Restricted':    { bg: 'rgba(245,158,11,0.10)', bd: 'rgba(245,158,11,0.30)', fg: '#fcd34d', dot: '#f59e0b' },
  'Top Secret':    { bg: 'rgba(168,85,247,0.12)', bd: 'rgba(168,85,247,0.30)', fg: '#d8b4fe', dot: '#a855f7' },
};

export const MIN_SESSION_DURATION = 5;
export const MAX_SESSION_DURATION = 120;
export const DEFAULT_SESSION_DURATION = 30;
export const MAX_URL_LENGTH = 2000;
export const MAX_TEXT_LENGTH = 200;
export const MAX_WATERMARK_LENGTH = 120;
export const LOAD_WATCHDOG_MS = 12000;

export function hasFeature(flags: number, name: FeatureName): boolean {
  return !!(flags & (1 << FEATURE_ORDER.indexOf(name)));
}

export function featureFlags(enabled: Record<string, boolean>): number {
  return FEATURE_ORDER.reduce((m, name, i) => (enabled[name] ? m | (1 << i) : m), 0);
}

/** Outcome of asking the backend to resolve a short link. */
export type ResolveOutcome =
  | { ok: true; config: PortalConfig; title: string }
  | { ok: false; reason: 'not_found' | 'revoked' | 'expired' | 'exhausted' | 'passcode_required' | 'bad_passcode' | 'error'; message: string };
