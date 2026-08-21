'use client';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { Chrome } from './Chrome';
import { FEATURES, useBuilder } from './useBuilder';
import { buildPortal } from '@/lib/portal';
import { encodeConfig } from '@/lib/config';
import { qrToSvg } from '@/lib/qr';
import { getSupabase, isBackendConfigured, siteBase } from '@/lib/supabase';
import type { PortalConfig } from '@/lib/types';

type LinkMode = 'short' | 'fragment' | 'hosted';

/** URL-safe id with ~59 bits of entropy — short enough for a tidy QR. */
function newPortalId(): string {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  const bytes = crypto.getRandomValues(new Uint8Array(10));
  return Array.from(bytes, (b) => alphabet[b % alphabet.length]).join('');
}

function download(blob: Blob, filename: string) {
  const href = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = href; a.download = filename; a.style.display = 'none';
  document.body.appendChild(a); a.click();
  setTimeout(() => { document.body.removeChild(a); URL.revokeObjectURL(href); }, 4000);
}

function slugify(s: string) {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 48) || 'portal';
}

export default function BuilderPage() {
  const b = useBuilder();
  const [html, setHtml] = useState('');
  const [cfg, setCfg] = useState<PortalConfig | null>(null);
  const [mode, setMode] = useState<LinkMode>('fragment');
  const [hostedUrl, setHostedUrl] = useState('');
  const [shortId, setShortId] = useState('');
  const [saving, setSaving] = useState(false);
  const [saveMsg, setSaveMsg] = useState<{ kind: 'ok' | 'err' | 'info'; text: string } | null>(null);
  const [signedIn, setSignedIn] = useState<boolean | null>(null);
  const [email, setEmail] = useState('');
  const [expiresDays, setExpiresDays] = useState('');
  const [maxViews, setMaxViews] = useState('');
  const [passcode, setPasscode] = useState('');
  const [busy, setBusy] = useState(false);
  const [genErr, setGenErr] = useState('');

  const backend = isBackendConfigured();

  useEffect(() => {
    const sb = getSupabase();
    if (!sb) { setSignedIn(false); return; }
    sb.auth.getSession().then(({ data }) => setSignedIn(!!data.session));
    const { data: sub } = sb.auth.onAuthStateChange((_e, s) => setSignedIn(!!s));
    return () => sub.subscription.unsubscribe();
  }, []);

  const generate = useCallback(async () => {
    if (!b.ready || busy) return;
    setBusy(true);
    setGenErr('');
    try {
      // With a password set this is where the key derivation happens, which
      // is deliberately slow — hence the busy state rather than a sync call.
      const c = await b.buildConfig();
      setCfg(c);
      setHtml(buildPortal(c));
      setShortId('');
      setSaveMsg(null);
      setMode(backend && signedIn ? 'short' : 'fragment');
    } catch (err) {
      setCfg(null);
      setHtml('');
      setGenErr(err instanceof Error ? err.message : 'Could not build the portal.');
    } finally {
      setBusy(false);
    }
  }, [b, backend, signedIn, busy]);

  const link = useMemo(() => {
    if (!cfg) return '';
    if (mode === 'hosted') return hostedUrl.trim();
    if (mode === 'short') return shortId ? `${siteBase()}/v/?id=${shortId}` : '';
    return `${siteBase()}/v/#d=${encodeConfig(cfg)}`;
  }, [cfg, mode, hostedUrl, shortId]);

  const qr = useMemo(() => {
    if (!link) return null;
    try { return qrToSvg(link, 180); } catch { return null; }
  }, [link]);

  const saveToBackend = useCallback(async () => {
    const sb = getSupabase();
    if (!sb || !cfg) return;
    setSaving(true); setSaveMsg(null);
    try {
      const { data: sess } = await sb.auth.getSession();
      const uid = sess.session?.user.id;
      if (!uid) { setSaveMsg({ kind: 'err', text: 'Sign in first.' }); return; }

      const id = newPortalId();
      const days = parseInt(expiresDays, 10);
      const views = parseInt(maxViews, 10);

      const { error } = await sb.from('portals').insert({
        id,
        owner_id: uid,
        config: cfg,
        title: cfg.t,
        classification: cfg.c,
        expires_at: isFinite(days) && days > 0
          ? new Date(Date.now() + days * 86400_000).toISOString() : null,
        max_views: isFinite(views) && views > 0 ? views : null,
      });
      if (error) { setSaveMsg({ kind: 'err', text: error.message }); return; }

      if (passcode.trim()) {
        const { error: pErr } = await sb.rpc('set_portal_passcode', { p_id: id, p_passcode: passcode.trim() });
        if (pErr) { setSaveMsg({ kind: 'err', text: `Saved, but the passcode failed: ${pErr.message}` }); setShortId(id); return; }
      }
      setShortId(id);
      setMode('short');
      setSaveMsg({ kind: 'ok', text: 'Saved. This link can be revoked at any time from My Portals.' });
    } finally {
      setSaving(false);
    }
  }, [cfg, expiresDays, maxViews, passcode]);

  const signIn = useCallback(async () => {
    const sb = getSupabase();
    if (!sb || !email.trim()) return;
    const { error } = await sb.auth.signInWithOtp({
      email: email.trim(),
      options: { emailRedirectTo: siteBase() + '/' },
    });
    setSaveMsg(error
      ? { kind: 'err', text: error.message }
      : { kind: 'info', text: 'Check your email for the sign-in link.' });
  }, [email]);

  return (
    <Chrome page="build">
      <div className="main-area">
        <div className="card">
          <div className="card-header">
            <h2>Create Secure Document Page</h2>
            <p>
              Paste a Google Docs link and configure the viewer. The result is a self-contained
              page with copy protection, watermarking, session limits and DevTools detection —
              shareable as a link and a QR code.
            </p>
          </div>

          <div className="card-body">
            {/* ---------------- source ---------------- */}
            <div className="section">
              <div className="section-label"><div className="num">1</div> Document Source</div>
              <div className="field">
                <label htmlFor="docUrl">Google Docs URL <span className="req">*</span></label>
                <input id="docUrl" type="url" value={b.url} spellCheck={false} autoComplete="off"
                  placeholder="https://docs.google.com/document/d/..."
                  onChange={(e) => b.setUrl(e.target.value)} />
                {b.errors.url && <div className="err">{b.errors.url}</div>}
                {b.embedUrl && (
                  <div className="hint">
                    Embed URL: <code>{b.embedUrl}</code>{' '}
                    <a href={b.embedUrl} target="_blank" rel="noopener noreferrer">test this link →</a>
                  </div>
                )}
                <div className="hint">
                  Supports Docs, Sheets, Slides, Forms, published links, Drive files and folders.
                </div>
              </div>
              <div className="notice notice-warn">
                <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" strokeWidth={1.8} stroke="currentColor">
                  <path strokeLinecap="round" strokeLinejoin="round" d="M12 9v3.75m9-.75a9 9 0 1 1-18 0 9 9 0 0 1 18 0Zm-9 3.75h.008v.008H12v-.008Z" />
                </svg>
                <div>
                  Set the document&rsquo;s sharing to <b>&ldquo;Anyone with the link — Viewer&rdquo;</b>.
                  A restricted document renders a Google sign-in screen instead of your content.
                </div>
              </div>
            </div>

            {/* ---------------- metadata ---------------- */}
            <div className="section">
              <div className="section-label"><div className="num">2</div> Document Metadata</div>
              <div className="row-2">
                <div className="field">
                  <label htmlFor="t">Document Title <span className="req">*</span></label>
                  <input id="t" type="text" value={b.title} maxLength={200}
                    placeholder="e.g. Q4 Strategy Report" onChange={(e) => b.setTitle(e.target.value)} />
                  {b.errors.title && <div className="err">{b.errors.title}</div>}
                </div>
                <div className="field">
                  <label htmlFor="o">Owner Name <span className="req">*</span></label>
                  <input id="o" type="text" value={b.owner} maxLength={200}
                    placeholder="e.g. Ashen Wijesingha" onChange={(e) => b.setOwner(e.target.value)} />
                  {b.errors.owner && <div className="err">{b.errors.owner}</div>}
                </div>
              </div>
              <div className="row-3">
                <div className="field">
                  <label htmlFor="cl">Classification</label>
                  <select id="cl" value={b.classification} onChange={(e) => b.setClassification(e.target.value)}>
                    {b.classNames.map((c) => <option key={c} value={c}>{c}</option>)}
                  </select>
                </div>
                <div className="field">
                  <label htmlFor="ac">Access Level</label>
                  <select id="ac" value={b.access} onChange={(e) => b.setAccess(e.target.value)}>
                    <option>View Only</option><option>Comment Only</option><option>Restricted View</option>
                  </select>
                </div>
                <div className="field">
                  <label htmlFor="se">Session Duration (min)</label>
                  <input id="se" type="number" min={5} max={120} step={5} value={b.session}
                    onChange={(e) => b.setSession(e.target.value)} onBlur={b.clampSession} />
                  <div className="hint">5 – 120 minutes.</div>
                </div>
              </div>
              <div className="field">
                <label htmlFor="wm">Watermark Text</label>
                <input id="wm" type="text" value={b.watermark} maxLength={120}
                  onChange={(e) => b.setWatermark(e.target.value)} />
                {b.errors.watermark && <div className="err">{b.errors.watermark}</div>}
                <div className="hint">
                  Tiled diagonally and stamped with the session id and start time.
                  Blank falls back to the classification label.
                </div>
              </div>
            </div>

            {/* ---------------- password ---------------- */}
            <div className="section">
              <div className="section-label"><div className="num">3</div> Document Password</div>
              <div className="row-2">
                <div className="field">
                  <label htmlFor="pw">Password <span className="hint" style={{ display: 'inline' }}>(optional)</span></label>
                  <input id="pw" type="password" value={b.password} autoComplete="new-password"
                    placeholder="Leave blank for no password"
                    onChange={(e) => b.setPassword(e.target.value)} />
                  {b.errors.password && <div className="err">{b.errors.password}</div>}
                </div>
                <div className="field">
                  <label htmlFor="pw2">Confirm password</label>
                  <input id="pw2" type="password" value={b.password2} autoComplete="new-password"
                    disabled={!b.password} onChange={(e) => b.setPassword2(e.target.value)} />
                  {b.errors.password2 && <div className="err">{b.errors.password2}</div>}
                </div>
              </div>
              <div className="notice notice-info">
                <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" strokeWidth={1.8} stroke="currentColor">
                  <path strokeLinecap="round" strokeLinejoin="round" d="M16.5 10.5V6.75a4.5 4.5 0 1 0-9 0v3.75m-.75 11.25h10.5a2.25 2.25 0 0 0 2.25-2.25v-6.75a2.25 2.25 0 0 0-2.25-2.25H6.75a2.25 2.25 0 0 0-2.25 2.25v6.75a2.25 2.25 0 0 0 2.25 2.25Z" />
                </svg>
                <div>
                  The password is the decryption key, not a check the page performs. The document
                  URL is encrypted with AES-256-GCM under a key derived from it, and the plaintext
                  is left out of the link, the QR code, the downloaded file and the database — so
                  there is nothing to read without it, and <b>nothing to recover it from if you
                  lose it</b>. Send it to viewers over a different channel than the link.
                </div>
              </div>
            </div>

            {/* ---------------- features ---------------- */}
            <div className="section">
              <div className="section-label"><div className="num">4</div> Security Features</div>
              {FEATURES.map((f) => (
                <div className="toggle-row" key={f.name}>
                  <div className="toggle-label">{f.label}<span>{f.blurb}</span></div>
                  <button type="button" role="switch" aria-checked={!!b.flags[f.name]} aria-label={f.label}
                    className={'toggle' + (b.flags[f.name] ? ' on' : '')}
                    onClick={() => b.toggle(f.name)} />
                </div>
              ))}
            </div>

            <div className="actions">
              <button className="btn btn-primary" disabled={!b.ready || busy} onClick={() => void generate()}>
                {busy ? 'Encrypting…' : 'Generate Secure Portal'}
              </button>
              {html && (
                <button className="btn btn-secondary"
                  onClick={() => download(new Blob([html], { type: 'text/html;charset=utf-8' }),
                    `securedoc-${slugify(b.title)}.html`)}>
                  Download HTML
                </button>
              )}
            </div>

            {genErr && <div className="notice notice-err"><span>{genErr}</span></div>}

            {/* ---------------- share ---------------- */}
            {cfg && (
              <div className="panel">
                <h3>Shareable Link &amp; QR Code</h3>

                <div style={{ display: 'flex', gap: 16, flexWrap: 'wrap', marginBottom: 14, fontSize: '0.76rem' }}>
                  {backend && (
                    <label style={{ display: 'flex', gap: 7, alignItems: 'center', cursor: 'pointer' }}>
                      <input type="radio" checked={mode === 'short'} onChange={() => setMode('short')} />
                      Short link (revocable)
                    </label>
                  )}
                  <label style={{ display: 'flex', gap: 7, alignItems: 'center', cursor: 'pointer' }}>
                    <input type="radio" checked={mode === 'fragment'} onChange={() => setMode('fragment')} />
                    Self-contained link (no account)
                  </label>
                  <label style={{ display: 'flex', gap: 7, alignItems: 'center', cursor: 'pointer' }}>
                    <input type="radio" checked={mode === 'hosted'} onChange={() => setMode('hosted')} />
                    A file I host
                  </label>
                </div>

                {mode === 'hosted' && (
                  <div className="field">
                    <label htmlFor="hu">URL of the uploaded portal HTML</label>
                    <input id="hu" type="url" value={hostedUrl} spellCheck={false}
                      placeholder="https://example.com/securedoc-report.html"
                      onChange={(e) => setHostedUrl(e.target.value)} />
                  </div>
                )}

                {mode === 'short' && (
                  <BackendPanel
                    backend={backend} signedIn={signedIn} email={email} setEmail={setEmail}
                    signIn={signIn} saving={saving} shortId={shortId} saveToBackend={saveToBackend}
                    expiresDays={expiresDays} setExpiresDays={setExpiresDays}
                    maxViews={maxViews} setMaxViews={setMaxViews}
                    passcode={passcode} setPasscode={setPasscode}
                  />
                )}

                {saveMsg && (
                  <div className={`notice notice-${saveMsg.kind === 'ok' ? 'ok' : saveMsg.kind === 'err' ? 'err' : 'info'}`}>
                    <span>{saveMsg.text}</span>
                  </div>
                )}

                {link && (
                  <div className="share-grid" style={{ marginTop: 16 }}>
                    <div>
                      <div className="share-row">
                        <input type="text" readOnly value={link} aria-label="Shareable link" />
                        <button className="btn btn-secondary" style={{ padding: '11px 16px' }}
                          onClick={() => navigator.clipboard?.writeText(link)}>Copy</button>
                      </div>
                      <p className="hint">
                        {mode === 'fragment'
                          ? 'The settings travel in the “#” fragment, which browsers never send to a server. Anyone with the link can open it and it cannot be revoked.'
                          : mode === 'short'
                            ? 'Resolved server-side on every open, so revocation, expiry, view limits and the passcode are actually enforced.'
                            : 'Points at a file you host yourself.'}
                      </p>
                    </div>
                    <div>
                      <div className="qr-box" dangerouslySetInnerHTML={{ __html: qr ?? '' }} />
                      <div className="qr-actions">
                        <button onClick={() => {
                          const q = qrToSvg(link, 512);
                          download(new Blob([q], { type: 'image/svg+xml' }), `securedoc-qr-${slugify(b.title)}.svg`);
                        }}>SVG</button>
                      </div>
                    </div>
                  </div>
                )}
                {!qr && link && (
                  <div className="notice notice-warn"><span>
                    This link is too long to fit in a QR code ({link.length} characters).
                    Use a short link, or shorten the title, owner and watermark.
                  </span></div>
                )}
              </div>
            )}
          </div>
        </div>
      </div>
    </Chrome>
  );
}

function BackendPanel(p: {
  backend: boolean; signedIn: boolean | null; email: string; setEmail: (v: string) => void;
  signIn: () => void; saving: boolean; shortId: string; saveToBackend: () => void;
  expiresDays: string; setExpiresDays: (v: string) => void;
  maxViews: string; setMaxViews: (v: string) => void;
  passcode: string; setPasscode: (v: string) => void;
}) {
  if (!p.backend) {
    return (
      <div className="notice notice-warn"><span>
        Supabase is not configured, so short links are unavailable. Set
        <code> NEXT_PUBLIC_SUPABASE_URL</code> and <code>NEXT_PUBLIC_SUPABASE_ANON_KEY</code>,
        or use a self-contained link instead.
      </span></div>
    );
  }
  if (p.signedIn === false) {
    return (
      <div>
        <div className="notice notice-info"><span>
          Short links are tied to an account so you can revoke them later. Sign in with a magic link.
        </span></div>
        <div className="share-row" style={{ marginTop: 12 }}>
          <input type="email" value={p.email} placeholder="you@example.com"
            onChange={(e) => p.setEmail(e.target.value)} />
          <button className="btn btn-secondary" style={{ padding: '11px 16px' }} onClick={p.signIn}>
            Send link
          </button>
        </div>
      </div>
    );
  }
  if (p.shortId) return null;
  return (
    <div>
      <div className="row-3">
        <div className="field">
          <label htmlFor="ed">Expires after (days)</label>
          <input id="ed" type="number" min={1} value={p.expiresDays} placeholder="never"
            onChange={(e) => p.setExpiresDays(e.target.value)} />
        </div>
        <div className="field">
          <label htmlFor="mv">Max opens</label>
          <input id="mv" type="number" min={1} value={p.maxViews} placeholder="unlimited"
            onChange={(e) => p.setMaxViews(e.target.value)} />
        </div>
        <div className="field">
          <label htmlFor="pc">Link passcode</label>
          <input id="pc" type="password" value={p.passcode} placeholder="none" autoComplete="new-password"
            onChange={(e) => p.setPasscode(e.target.value)} />
          <div className="hint">Checked on the server before the link resolves — separate from the document password.</div>
        </div>
      </div>
      <button className="btn btn-primary" disabled={p.saving} onClick={p.saveToBackend}>
        {p.saving ? 'Saving…' : 'Create short link'}
      </button>
    </div>
  );
}
