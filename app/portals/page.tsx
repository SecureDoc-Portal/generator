'use client';
/** Owner dashboard: list portals, revoke them, review the audit trail. */
import { useCallback, useEffect, useState } from 'react';
import { Chrome } from '../Chrome';
import { getSupabase, isBackendConfigured, siteBase } from '@/lib/supabase';

interface Summary {
  id: string; title: string; classification: string; created_at: string;
  expires_at: string | null; revoked_at: string | null;
  max_views: number | null; view_count: number;
  has_passcode: boolean; is_active: boolean;
}
interface ViewRow { id: number; portal_id: string; viewed_at: string; outcome: string; user_agent: string | null }

export default function PortalsPage() {
  const [rows, setRows] = useState<Summary[] | null>(null);
  const [views, setViews] = useState<Record<string, ViewRow[]>>({});
  const [signedIn, setSignedIn] = useState<boolean | null>(null);
  const [msg, setMsg] = useState('');
  const backend = isBackendConfigured();

  const load = useCallback(async () => {
    const sb = getSupabase();
    if (!sb) return;
    const { data: sess } = await sb.auth.getSession();
    if (!sess.session) { setSignedIn(false); return; }
    setSignedIn(true);
    const { data, error } = await sb.from('portal_summary').select('*').order('created_at', { ascending: false });
    if (error) { setMsg(error.message); return; }
    setRows((data ?? []) as Summary[]);
  }, []);

  useEffect(() => { void load(); }, [load]);

  const revoke = useCallback(async (id: string) => {
    const sb = getSupabase();
    if (!sb) return;
    const { error } = await sb.from('portals').update({ revoked_at: new Date().toISOString() }).eq('id', id);
    if (error) setMsg(error.message); else void load();
  }, [load]);

  const showViews = useCallback(async (id: string) => {
    const sb = getSupabase();
    if (!sb) return;
    if (views[id]) { setViews((v) => { const n = { ...v }; delete n[id]; return n; }); return; }
    const { data, error } = await sb.from('portal_views')
      .select('*').eq('portal_id', id).order('viewed_at', { ascending: false }).limit(50);
    if (error) { setMsg(error.message); return; }
    setViews((v) => ({ ...v, [id]: (data ?? []) as ViewRow[] }));
  }, [views]);

  return (
    <Chrome page="portals">
      <div className="main-area">
        <div className="card">
          <div className="card-header">
            <h2>My Portals</h2>
            <p>Short links you have created. Revoking one blocks it on the next open, everywhere.</p>
          </div>
          <div className="card-body">
            {!backend && (
              <div className="notice notice-warn"><span>
                Supabase is not configured, so there are no stored portals. Self-contained
                fragment links still work but cannot be listed or revoked.
              </span></div>
            )}
            {backend && signedIn === false && (
              <div className="notice notice-info"><span>Sign in on the Build page to see your portals.</span></div>
            )}
            {msg && <div className="notice notice-err"><span>{msg}</span></div>}

            {rows && rows.length === 0 && (
              <div className="notice notice-info"><span>No portals yet. Create one from the Build page.</span></div>
            )}

            {rows && rows.length > 0 && (
              <table className="portals">
                <thead>
                  <tr>
                    <th>Title</th><th>Status</th><th>Opens</th><th>Expires</th><th></th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map((r) => (
                    <>
                      <tr key={r.id}>
                        <td>
                          <div style={{ fontWeight: 500 }}>{r.title}</div>
                          <div style={{ fontSize: '0.68rem', color: 'var(--muted)' }}>
                            {r.classification}{r.has_passcode ? ' · passcode' : ''}
                            {' · '}
                            <a href={`${siteBase()}/v/?id=${r.id}`} target="_blank" rel="noopener noreferrer">open</a>
                          </div>
                        </td>
                        <td>
                          <span className={'pill ' + (r.is_active ? 'pill-ok' : 'pill-off')}>
                            {r.revoked_at ? 'revoked' : r.is_active ? 'active' : 'inactive'}
                          </span>
                        </td>
                        <td>{r.view_count}{r.max_views ? ` / ${r.max_views}` : ''}</td>
                        <td>{r.expires_at ? new Date(r.expires_at).toLocaleDateString() : '—'}</td>
                        <td style={{ textAlign: 'right', whiteSpace: 'nowrap' }}>
                          <button className="btn btn-secondary" style={{ padding: '6px 12px', fontSize: '0.7rem' }}
                            onClick={() => void showViews(r.id)}>
                            {views[r.id] ? 'Hide log' : 'Log'}
                          </button>{' '}
                          {!r.revoked_at && (
                            <button className="btn btn-danger" style={{ padding: '6px 12px', fontSize: '0.7rem' }}
                              onClick={() => void revoke(r.id)}>Revoke</button>
                          )}
                        </td>
                      </tr>
                      {views[r.id] && (
                        <tr key={r.id + '-log'}>
                          <td colSpan={5} style={{ background: 'rgba(13,17,32,0.5)' }}>
                            {views[r.id].length === 0
                              ? <span className="hint">No opens recorded yet.</span>
                              : (
                                <div style={{ fontSize: '0.72rem' }}>
                                  {views[r.id].map((v) => (
                                    <div key={v.id} style={{ padding: '3px 0', color: 'var(--muted)' }}>
                                      {new Date(v.viewed_at).toLocaleString()} —{' '}
                                      <b style={{ color: v.outcome === 'granted' ? '#86efac' : '#fca5a5' }}>{v.outcome}</b>
                                    </div>
                                  ))}
                                </div>
                              )}
                          </td>
                        </tr>
                      )}
                    </>
                  ))}
                </tbody>
              </table>
            )}
          </div>
        </div>
      </div>
    </Chrome>
  );
}
