'use client';
/**
 * Viewer entry point. Handles both link shapes:
 *   /v/?id=<short id>   -> resolved by the Edge Function (revocable, auditable)
 *   /v/#d=<config>      -> decoded locally, no backend involved
 *
 * A query parameter is used rather than a dynamic [id] route because a static
 * export cannot pre-render ids that are created at runtime.
 */
import { useCallback, useEffect, useState } from 'react';
import { buildPortal } from '@/lib/portal';
import { decodeConfig } from '@/lib/config';
import { resolvePortal } from '@/lib/supabase';
import type { PortalConfig } from '@/lib/types';

type State =
  | { phase: 'loading' }
  | { phase: 'passcode'; id: string; error?: string }
  | { phase: 'error'; title: string; message: string }
  | { phase: 'ready' };

/**
 * Hands the tab over to the portal.
 *
 * document.write() would tear the DOM out from under React, which then throws
 * on its next reconciliation ("node to be removed is not a child of this
 * node"). Navigating to a blob: URL replaces the document wholesale instead,
 * so React is simply gone. The blob inherits this page's origin, so the
 * portal keeps normal same-origin behaviour and stays a top-level document
 * (no framing, so its clickjacking guard does not trip).
 *
 * location.replace rather than assign: the viewer shell should not sit in
 * the back-stack behind the document.
 */
function renderPortal(cfg: PortalConfig) {
  const html = buildPortal(cfg);
  const url = URL.createObjectURL(new Blob([html], { type: 'text/html;charset=utf-8' }));
  window.location.replace(url);
}

export default function ViewerPage() {
  const [state, setState] = useState<State>({ phase: 'loading' });
  const [passcode, setPasscode] = useState('');

  const attempt = useCallback(async (id: string, code?: string) => {
    setState({ phase: 'loading' });
    const res = await resolvePortal(id, code);
    if (res && (res as { ok?: boolean }).ok) {
      renderPortal((res as { config: PortalConfig }).config);
      setState({ phase: 'ready' });
      return;
    }
    const reason = (res as { reason?: string })?.reason ?? 'error';
    const message = (res as { message?: string })?.message ?? 'Something went wrong.';
    if (reason === 'passcode_required') { setState({ phase: 'passcode', id }); return; }
    if (reason === 'bad_passcode') { setState({ phase: 'passcode', id, error: message }); return; }
    const titles: Record<string, string> = {
      not_found: 'Link not found', revoked: 'Access revoked',
      expired: 'Link expired', exhausted: 'View limit reached', error: 'Cannot open document',
    };
    setState({ phase: 'error', title: titles[reason] ?? 'Cannot open document', message });
  }, []);

  useEffect(() => {
    const frag = /[#&]d=([A-Za-z0-9\-_]+)/.exec(window.location.hash || '');
    if (frag) {
      const cfg = decodeConfig(frag[1]);
      if (cfg) { renderPortal(cfg); setState({ phase: 'ready' }); }
      else setState({ phase: 'error', title: 'Broken link', message: 'This link is malformed or incomplete.' });
      return;
    }
    const id = new URLSearchParams(window.location.search).get('id');
    if (!id) {
      setState({ phase: 'error', title: 'Nothing to show', message: 'This address needs a portal link.' });
      return;
    }
    void attempt(id);
  }, [attempt]);

  if (state.phase === 'ready') return null;

  if (state.phase === 'loading') {
    return (
      <div className="center-msg">
        <div className="spinner" />
        <p>Opening secure document…</p>
      </div>
    );
  }

  if (state.phase === 'passcode') {
    return (
      <div className="center-msg">
        <h2>Passcode required</h2>
        <p>This document is protected with a passcode.</p>
        <form
          style={{ marginTop: 20 }}
          onSubmit={(e) => { e.preventDefault(); void attempt(state.id, passcode); }}
        >
          <input type="password" value={passcode} autoFocus placeholder="Passcode"
            onChange={(e) => setPasscode(e.target.value)} />
          {state.error && <div className="err" style={{ marginTop: 8 }}>{state.error}</div>}
          <button className="btn btn-primary" type="submit" style={{ marginTop: 14 }}>Open document</button>
        </form>
      </div>
    );
  }

  return (
    <div className="center-msg">
      <h2>{state.title}</h2>
      <p>{state.message}</p>
    </div>
  );
}
