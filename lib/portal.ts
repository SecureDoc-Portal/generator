/**
 * Builds the standalone protected-viewer HTML from a portal config.
 *
 * This is the single source of truth for what a portal is: the builder page,
 * the fragment share link and the Supabase-backed short link all call it, so
 * a portal renders identically however it was reached.
 *
 * Every literal script terminator inside the template below is written as
 * <\/script> so it survives both the template literal and the HTML parser.
 */
import type { PortalConfig } from './types';
import type { FeatureName } from './types';
import { CLASS_THEME, FEATURE_ORDER, MIN_SESSION_DURATION, MAX_SESSION_DURATION, DEFAULT_SESSION_DURATION, LOAD_WATCHDOG_MS } from './types';
import { isLockPayload } from './lock';

const HTML_ESCAPE_MAP: Record<string, string> = {
  '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
};

/** HTML text/attribute escape. */
export function escH(value: unknown): string {
  if (value === null || value === undefined) return '';
  return String(value).replace(/[&<>"']/g, (c) => HTML_ESCAPE_MAP[c]);
}

/**
 * A JS string literal that is also safe inside an inline script block:
 * escaping < > & stops a value containing a script terminator from closing
 * the block early, and U+2028/U+2029 are neutralised for older parsers.
 */
export function jsStr(value: unknown): string {
  return JSON.stringify(String(value === null || value === undefined ? '' : value))
    .replace(/</g, '\\u003c')
    .replace(/>/g, '\\u003e')
    .replace(/&/g, '\\u0026')
    .replace(/\u2028/g, '\\u2028')
    .replace(/\u2029/g, '\\u2029');
}

/** XML text escape, for content placed inside a generated SVG. */
function escX(value: string): string {
  return String(value)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&apos;');
}

function watermarkDataUri(text: string): string {
    const t = escX(text);
    const svg =
        '<svg xmlns="http://www.w3.org/2000/svg" width="340" height="190" viewBox="0 0 340 190">' +
        // Dark ink at low layer opacity: legible over the white page of
        // a rendered document, which is what the viewer almost always shows.
        '<g fill="#0f172a" font-family="Helvetica,Arial,sans-serif" font-size="15" font-weight="700" letter-spacing="2">' +
        '<text x="10" y="60" transform="rotate(-30 10 60)">' + t + '</text>' +
        '<text x="180" y="155" transform="rotate(-30 180 155)">' + t + '</text>' +
        '</g></svg>';
    return 'data:image/svg+xml,' + encodeURIComponent(svg);
}

/**
 * Stable identifier for one portal, used as the localStorage key that holds
 * the session deadline. It is an identifier, not a secret: it only has to be
 * the same on every reload of the same portal and different between portals,
 * so a doubled FNV-1a is plenty and costs nothing at build time.
 *
 * The seed uses the ciphertext for a locked portal, so the key never derives
 * from a URL the page is not otherwise allowed to know.
 */
function portalKey(seed: string): string {
    let h1 = 0x811c9dc5;
    let h2 = 0x01000193;
    for (let i = 0; i < seed.length; i++) {
        const c = seed.charCodeAt(i);
        h1 = Math.imul(h1 ^ c, 0x01000193) >>> 0;
        h2 = Math.imul(h2 ^ c, 0x85ebca6b) >>> 0;
    }
    return h1.toString(16).padStart(8, '0') + h2.toString(16).padStart(8, '0');
}

function xorEncode(str: string): { key: number[]; enc: number[] } {
    const key: number[] = [];
    const rnd = (window.crypto && window.crypto.getRandomValues)
        ? window.crypto.getRandomValues(new Uint8Array(16))
        : null;
    for (let i = 0; i < 16; i++) key.push(rnd ? rnd[i] : Math.floor(Math.random() * 256));
    const enc: number[] = [];
    for (let i = 0; i < str.length; i++) enc.push(str.charCodeAt(i) ^ key[i % key.length]);
    return { key: key, enc: enc };
}

export function buildPortal(cfg: PortalConfig): string {
    const embedUrl = String(cfg.u || '');
    const title = String(cfg.t || 'Document');
    const owner = String(cfg.o || '');
    const classification = CLASS_THEME[cfg.c] ? cfg.c : 'Confidential';
    const access = String(cfg.a || 'View Only');
    let sessionMin = parseInt(String(cfg.s), 10);
    if (!isFinite(sessionMin)) sessionMin = DEFAULT_SESSION_DURATION;
    sessionMin = Math.min(MAX_SESSION_DURATION, Math.max(MIN_SESSION_DURATION, sessionMin));
    const wmText = String(cfg.w || '').trim() || classification;

    const lock = isLockPayload(cfg.p) ? cfg.p : null;
    const useLock = !!lock;

    const flags = cfg.f | 0;
    const flag = (name: FeatureName) => !!(flags & (1 << FEATURE_ORDER.indexOf(name)));
    const useCopyProtect = flag('copyProtect');
    const useScreenshot  = flag('screenshotProtect');
    const usePrint       = flag('printBlock');
    const useDevtools    = flag('devtoolsDetect');
    const useWatermark   = flag('watermark');
    const useIdle        = flag('idleLock');
    const useTimer       = flag('sessionTimer');
    const useGuard       = flag('frameGuard');
    // XOR is cosmetic obfuscation; under a password the URL is already
    // AES-encrypted and absent from the file, so layering XOR on top would
    // only be a second name for the same thing.
    const useXor         = flag('xorEncrypt') && !useLock;
    const useSandbox     = flag('frameSandbox');

    const theme = CLASS_THEME[classification] || CLASS_THEME['Confidential'];

    // Origin of the embedded document, used for preconnect + CSP frame-src.
    // A locked portal carries its origin in the clear inside the payload so
    // the connection is already warm by the time the password is accepted.
    let docOrigin: string = lock ? String(lock.o || '') : '';
    if (!docOrigin) {
        try { docOrigin = new URL(embedUrl).origin; } catch (e) { docOrigin = ''; }
    }
    const isGoogleOrigin = /^https:\/\/([\w-]+\.)*google\.com$/.test(docOrigin);

    // frame-src stays permissive over https: a viewer such as Google's
    // redirects across several of its own hosts while loading, and a
    // tight allow-list silently breaks those hops.

    // getDocUrl() is defined in the boot script so the iframe request
    // starts while the rest of the document is still parsing.
    let urlSnippet: string;
    if (useLock) {
        // Nothing to hand out yet: the URL does not exist in this file until
        // the password has decrypted it into window.__sdUrl.
        urlSnippet = 'window.getDocUrl=function(){return window.__sdUrl||"";};';
    } else if (useXor) {
        const pack = xorEncode(embedUrl);
        urlSnippet =
            'var _k=[' + pack.key.join(',') + '],_e=[' + pack.enc.join(',') + '];' +
            'window.getDocUrl=function(){var o="";for(var i=0;i<_e.length;i++){o+=String.fromCharCode(_e[i]^_k[i%_k.length]);}return o;};';
    } else {
        urlSnippet = 'var _u=' + jsStr(embedUrl) + ';window.getDocUrl=function(){return _u;};';
    }

    /*
     * Session identity.
     *
     * The deadline is written to localStorage under a key derived from the
     * portal, so reloading resumes the same countdown instead of minting a
     * fresh one — the whole point of a time-limited link. The same record
     * carries a short session id, which the watermark stamps onto the page so
     * a screenshot can be traced back to a viewing session.
     */
    const sessionKey = 'sd.s.' + portalKey(
        (lock ? lock.c : embedUrl) + '|' + title + '|' + owner + '|' + sessionMin,
    );

    // src is set from script whenever something has to be decided first —
    // whether the session is already spent, or whether the password is right.
    // The parser-assigned attribute is kept for the plain case, where it is
    // the earliest possible moment to start the request.
    const srcFromScript = useLock || useXor || useTimer;

    /*
     * Emitted first in the boot script, before anything can load. Resolves the
     * session record so that a reload resumes the existing countdown instead
     * of starting a new one, and produces the short session id the watermark
     * stamps onto every screenshot.
     *
     * When the timer feature is off the deadline is still computed and stored;
     * nothing reads it, but the same record is what keeps the session id
     * stable across reloads, so there is only one code path.
     */
    const sessionBoot = `
        /* Every name here is prefixed: this runs in the same closure as the
           URL snippet above, and a collision would silently rewrite the
           document link. */
        var _sdKey=${jsStr(sessionKey)},_sdTtl=${sessionMin}*60*1000,_sdStore=null;
        try{var _sdProbe="__sdt";localStorage.setItem(_sdProbe,"1");localStorage.removeItem(_sdProbe);_sdStore=localStorage;}catch(e){_sdStore=null;}
        function _sdNewSid(){var a="ABCDEFGHJKLMNPQRSTUVWXYZ23456789",o="",r=null;try{r=crypto.getRandomValues(new Uint8Array(6));}catch(e){r=null;}for(var i=0;i<6;i++){o+=a.charAt((r?r[i]:Math.floor(Math.random()*256))%a.length);}return o;}
        var _sdNow=Date.now(),_sdRec=null;
        if(_sdStore){try{_sdRec=JSON.parse(_sdStore.getItem(_sdKey)||"null");}catch(e){_sdRec=null;}}
        var _sdDeadline,_sdSid;
        if(_sdRec&&typeof _sdRec.d==="number"&&_sdRec.n===_sdTtl&&typeof _sdRec.sid==="string"){
            /* Cap at one full session: a device clock wound backwards can
               shorten nothing and must not be able to lengthen anything. */
            _sdDeadline=Math.min(_sdRec.d,_sdNow+_sdTtl);_sdSid=_sdRec.sid;
        }else{
            _sdDeadline=_sdNow+_sdTtl;_sdSid=_sdNewSid();
        }
        if(_sdStore){try{
            _sdStore.setItem(_sdKey,JSON.stringify({d:_sdDeadline,n:_sdTtl,sid:_sdSid}));
            /* Forget sessions that ended over a month ago so a browser that
               opens many portals does not accumulate records forever. */
            for(var _sdI=_sdStore.length-1;_sdI>=0;_sdI--){
                var _sdOld=_sdStore.key(_sdI);
                if(!_sdOld||_sdOld.indexOf("sd.s.")!==0||_sdOld===_sdKey)continue;
                try{var _sdR=JSON.parse(_sdStore.getItem(_sdOld)||"null");
                    if(!_sdR||typeof _sdR.d!=="number"||_sdR.d<_sdNow-2592000000)_sdStore.removeItem(_sdOld);
                }catch(e){_sdStore.removeItem(_sdOld);}
            }
        }catch(e){}}
        window.__sdSession={key:_sdKey,deadline:_sdDeadline,sid:_sdSid,startedAt:_sdDeadline-_sdTtl,expired:${useTimer ? '_sdDeadline<=_sdNow' : 'false'},persisted:!!_sdStore};`;

    // What actually kicks the document request off, once the boot script has
    // established there is a session left to spend it on.
    const startSnippet = useLock ? ''
        : useTimer ? 'if(!window.__sdSession.expired){f.src=window.getDocUrl();}'
        : useXor ? 'f.src=window.getDocUrl();'
        : '';

    const secTags: string[] = [];
    function tag(label: string, pathD: string) {
        secTags.push('<div class="sec-tag"><svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke-width="1.5" stroke="currentColor"><path stroke-linecap="round" stroke-linejoin="round" d="' + pathD + '"/></svg>' + escH(label) + '</div>');
    }
    if (useCopyProtect) tag('Copy Disabled', 'M16.5 10.5V6.75a4.5 4.5 0 1 0-9 0v3.75m-.75 11.25h10.5a2.25 2.25 0 0 0 2.25-2.25v-6.75a2.25 2.25 0 0 0-2.25-2.25H6.75a2.25 2.25 0 0 0-2.25 2.25v6.75a2.25 2.25 0 0 0 2.25 2.25Z');
    // Named for what it actually does. A web page cannot stop an operating
    // system screenshot — least of all on a phone — and calling this
    // "Screenshot Protected" told viewers something untrue.
    if (useScreenshot)  tag('Hidden When Inactive', 'M3.98 8.223A10.477 10.477 0 0 0 1.934 12C3.226 16.338 7.244 19.5 12 19.5c.993 0 1.953-.138 2.863-.395M6.228 6.228A10.451 10.451 0 0 1 12 4.5c4.756 0 8.773 3.162 10.065 7.498a10.522 10.522 0 0 1-4.293 5.774M6.228 6.228 3 3m3.228 3.228 3.65 3.65m7.894 7.894L21 21m-3.228-3.228-3.65-3.65m0 0a3 3 0 1 0-4.243-4.243m4.242 4.242L9.88 9.88');
    if (usePrint)       tag('Print Blocked', 'M6.72 13.829c-.24.03-.48.062-.72.096m.72-.096a42.415 42.415 0 0 1 10.56 0m-10.56 0L6.34 18m10.94-4.171c.24.03.48.062.72.096m-.72-.096L17.66 18m0 0 .229 2.523a1.125 1.125 0 0 1-1.12 1.227H7.231c-.662 0-1.18-.568-1.12-1.227L6.34 18m11.318 0h1.091A2.25 2.25 0 0 0 21 15.75V9.456c0-1.081-.768-2.015-1.837-2.175a48.055 48.055 0 0 0-1.913-.247M6.34 18H5.25A2.25 2.25 0 0 1 3 15.75V9.456c0-1.081.768-2.015 1.837-2.175a48.041 48.041 0 0 1 1.913-.247m10.5 0a48.536 48.536 0 0 0-10.5 0m10.5 0V3.375c0-.621-.504-1.125-1.125-1.125h-8.25c-.621 0-1.125.504-1.125 1.125v3.659M18.75 12H5.25');
    if (useWatermark)   tag('Watermarked', 'M9 17.25v1.007a3 3 0 0 1-.879 2.122L7.5 21h9l-.621-.621A3 3 0 0 1 15 18.257V17.25m6-12V15a2.25 2.25 0 0 1-2.25 2.25H5.25A2.25 2.25 0 0 1 3 15V5.25m18 0A2.25 2.25 0 0 0 18.75 3H5.25A2.25 2.25 0 0 0 3 5.25m18 0V12a2.25 2.25 0 0 1-2.25 2.25H5.25A2.25 2.25 0 0 1 3 12V5.25');
    if (useIdle)        tag('Auto-Lock', 'M12 6v6h4.5m4.5 0a9 9 0 1 1-18 0 9 9 0 0 1 18 0Z');
    if (useLock)        tag('Password Required', 'M16.5 10.5V6.75a4.5 4.5 0 1 0-9 0v3.75m-.75 11.25h10.5a2.25 2.25 0 0 0 2.25-2.25v-6.75a2.25 2.25 0 0 0-2.25-2.25H6.75a2.25 2.25 0 0 0-2.25 2.25v6.75a2.25 2.25 0 0 0 2.25 2.25Z');

    const wmUri = useWatermark ? watermarkDataUri(wmText) : '';

    /* ---------------------------------------------------------------
       The generated portal.
       Every literal script terminator below is written as <\/script>
       so it survives both the JS template literal and the HTML parser
       of this page.
       --------------------------------------------------------------- */
    return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<meta http-equiv="Content-Security-Policy" content="object-src 'none'; base-uri 'none'; frame-src https:;">
<title>${escH(title)} — SecureDoc Portal</title>
${docOrigin ? `<link rel="preconnect" href="${escH(docOrigin)}" crossorigin>
<link rel="dns-prefetch" href="${escH(docOrigin)}">` : ''}${isGoogleOrigin ? `
<link rel="preconnect" href="https://drive.google.com" crossorigin>
<link rel="preconnect" href="https://lh3.googleusercontent.com" crossorigin>` : ''}
<!-- Webfonts are deliberately NOT loaded here. They would cost two extra TLS
     handshakes plus a stylesheet and font files, all competing with the document
     request. The UI paints immediately in system fonts and the webfont is
     attached only once the document has loaded. -->
<style>
:root{--bg-primary:#0a0e17;--bg-secondary:#111827;--bg-card:#1a2236;--accent:#3b82f6;--text-primary:#e2e8f0;--text-muted:#94a3b8;--border:rgba(59,130,246,0.12);--danger:#ef4444;--sans:'DM Sans',-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;--serif:'DM Serif Display',Georgia,'Times New Roman',serif}
*{margin:0;padding:0;box-sizing:border-box}
body{font-family:var(--sans);background:var(--bg-primary);color:var(--text-primary);min-height:100vh;overflow-x:hidden}
${useCopyProtect ? `body,html{-webkit-user-select:none;-moz-user-select:none;user-select:none;-webkit-touch-callout:none}` : ''}
.bg-mesh{position:fixed;inset:0;z-index:0;pointer-events:none;contain:strict}
body:not(.doc-ready) .bg-mesh::before,body:not(.doc-ready) .bg-mesh::after{animation:none}
.bg-mesh::before{content:'';position:absolute;width:600px;height:600px;background:radial-gradient(circle,rgba(59,130,246,0.08)0%,transparent 70%);top:-200px;left:-100px;animation:drift 18s ease-in-out infinite alternate;will-change:transform}
.bg-mesh::after{content:'';position:absolute;width:500px;height:500px;background:radial-gradient(circle,rgba(99,102,241,0.06)0%,transparent 70%);bottom:-150px;right:-100px;animation:drift 22s ease-in-out infinite alternate-reverse;will-change:transform}
@keyframes drift{0%{transform:translate(0,0)scale(1)}100%{transform:translate(80px,60px)scale(1.15)}}
.app-container{position:relative;z-index:2;display:flex;flex-direction:column;min-height:100vh}
.app-header{background:rgba(17,24,39,0.7);backdrop-filter:blur(20px);border-bottom:1px solid var(--border);padding:0 2rem;height:64px;display:flex;align-items:center;justify-content:space-between;position:sticky;top:0;z-index:50;flex-shrink:0}
.logo-group{display:flex;align-items:center;gap:12px;min-width:0}
.logo-icon{width:36px;height:36px;background:linear-gradient(135deg,#3b82f6,#6366f1);border-radius:10px;display:flex;align-items:center;justify-content:center;box-shadow:0 0 20px rgba(59,130,246,0.25);flex-shrink:0}
.logo-icon svg{width:20px;height:20px;color:#fff}
.logo-text{font-family:var(--serif);font-size:1.2rem;letter-spacing:-0.02em;white-space:nowrap}
.header-right{display:flex;align-items:center;gap:12px}
.header-badge{display:flex;align-items:center;gap:6px;padding:6px 14px;border-radius:999px;font-size:0.7rem;font-weight:600;text-transform:uppercase;letter-spacing:0.08em;white-space:nowrap}
.badge-class{background:${theme.bg};border:1px solid ${theme.bd};color:${theme.fg}}
.badge-dot{width:6px;height:6px;border-radius:50%;background:${theme.dot};animation:pulse-dot 2s ease-in-out infinite;flex-shrink:0}
@keyframes pulse-dot{0%,100%{opacity:1}50%{opacity:0.4}}
.session-timer{display:flex;align-items:center;gap:6px;padding:6px 14px;border-radius:999px;font-size:0.7rem;font-weight:500;background:rgba(59,130,246,0.08);border:1px solid rgba(59,130,246,0.15);color:#93c5fd;font-variant-numeric:tabular-nums}
.session-timer svg{width:14px;height:14px}
.session-timer.expiring{color:#fca5a5;border-color:rgba(239,68,68,0.25);background:rgba(239,68,68,0.08)}
.info-bar{background:rgba(26,34,54,0.6);border-bottom:1px solid var(--border);padding:14px 2rem;display:flex;align-items:center;justify-content:space-between;flex-wrap:wrap;gap:12px;flex-shrink:0}
.doc-meta{display:flex;align-items:center;gap:20px;flex-wrap:wrap;min-width:0}
.meta-item{display:flex;align-items:center;gap:6px;font-size:0.78rem;color:var(--text-muted);min-width:0}
.meta-item svg{width:14px;height:14px;opacity:0.6;flex-shrink:0}
.meta-item strong{color:var(--text-primary);font-weight:500;overflow-wrap:anywhere}
.security-tags{display:flex;gap:8px;flex-wrap:wrap}
.sec-tag{display:flex;align-items:center;gap:4px;padding:4px 10px;border-radius:6px;font-size:0.68rem;font-weight:500;background:rgba(59,130,246,0.08);border:1px solid rgba(59,130,246,0.15);color:#93c5fd;white-space:nowrap}
.sec-tag svg{width:12px;height:12px}
.doc-toolbar{background:rgba(26,34,54,0.4);border-bottom:1px solid var(--border);padding:8px 2rem;display:flex;align-items:center;justify-content:space-between;gap:12px;flex-shrink:0}
.toolbar-left,.toolbar-right{display:flex;align-items:center;gap:8px}
.toolbar-btn{display:flex;align-items:center;gap:5px;padding:6px 12px;border-radius:6px;font-size:0.72rem;font-weight:500;background:rgba(59,130,246,0.08);border:1px solid rgba(59,130,246,0.12);color:#93c5fd;cursor:pointer;transition:all 0.2s;font-family:inherit}
.toolbar-btn:hover{background:rgba(59,130,246,0.15);border-color:rgba(59,130,246,0.3)}
.toolbar-btn:focus-visible{outline:2px solid var(--accent);outline-offset:2px}
.toolbar-btn svg{width:14px;height:14px}
.toolbar-btn.locked{opacity:0.4;cursor:not-allowed}
.toolbar-btn.locked:hover{background:rgba(239,68,68,0.10);border-color:rgba(239,68,68,0.25);color:#fca5a5}
.zoom-display{font-size:0.72rem;color:var(--text-muted);min-width:44px;text-align:center;font-variant-numeric:tabular-nums}
.toolbar-divider{width:1px;height:20px;background:var(--border)}
.viewer-wrapper{flex:1;padding:1.5rem 2rem 2rem;display:flex;flex-direction:column;min-height:0}
.viewer-frame{flex:1;position:relative;background:var(--bg-card);border-radius:12px;border:1px solid var(--border);overflow:hidden;min-height:460px;box-shadow:0 0 0 1px rgba(59,130,246,0.05),0 20px 60px rgba(0,0,0,0.3)}
.doc-frame{position:absolute;top:0;left:0;width:100%;height:100%;border:none;display:block;transform-origin:0 0;background:#fff}
.frame-guard{position:absolute;top:0;left:0;right:0;height:56px;z-index:12;background:transparent}
.watermark-layer{position:absolute;inset:0;z-index:6;pointer-events:none;background-repeat:repeat;background-size:340px 190px;opacity:0.11}
.render-bar{position:absolute;top:0;left:0;right:0;height:2px;z-index:19;overflow:hidden;background:rgba(59,130,246,0.12);opacity:0;visibility:hidden;transition:opacity .3s,visibility .3s}
.render-bar.show{opacity:1;visibility:visible}
.render-bar::after{content:'';position:absolute;top:0;left:-40%;width:40%;height:100%;background:linear-gradient(90deg,transparent,#3b82f6,transparent);animation:slideBar 1.1s linear infinite}
@keyframes slideBar{to{left:110%}}
.loader-overlay{position:absolute;inset:0;z-index:20;display:flex;flex-direction:column;align-items:center;justify-content:center;background:var(--bg-card);transition:opacity .35s ease,visibility .35s ease;padding:2rem;text-align:center}
.loader-overlay.hidden{opacity:0;visibility:hidden}
.spinner{width:40px;height:40px;border:3px solid rgba(59,130,246,0.15);border-top-color:#3b82f6;border-radius:50%;animation:spin .8s linear infinite}
@keyframes spin{to{transform:rotate(360deg)}}
.loader-text{margin-top:16px;font-size:0.82rem;color:var(--text-muted)}
.loader-progress{margin-top:12px;width:220px;height:3px;background:rgba(59,130,246,0.1);border-radius:3px;overflow:hidden}
.loader-progress-bar{height:100%;width:0;border-radius:3px;background:linear-gradient(90deg,#3b82f6,#6366f1);transition:width .25s ease-out}
.loader-fallback{display:none;margin-top:18px;max-width:420px}
.loader-overlay.stalled .spinner,.loader-overlay.stalled .loader-progress{display:none}
.loader-overlay.stalled .loader-fallback{display:block}
.loader-fallback p{font-size:0.78rem;color:var(--text-muted);line-height:1.6;margin-bottom:14px}
.loader-fallback button{padding:9px 22px;border-radius:8px;background:linear-gradient(135deg,#3b82f6,#6366f1);color:#fff;border:none;font-size:0.8rem;font-weight:600;cursor:pointer;font-family:inherit;margin:0 4px}
.loader-fallback button.ghost{background:none;border:1px solid rgba(59,130,246,0.3);color:#93c5fd}
.toast-container{position:fixed;bottom:76px;right:20px;z-index:100;display:flex;flex-direction:column;align-items:flex-end;gap:8px;pointer-events:none}
.toast{padding:12px 18px;border-radius:10px;font-size:0.78rem;font-weight:500;transform:translateX(120%);opacity:0;transition:all .35s cubic-bezier(.16,1,.3,1);display:flex;align-items:center;gap:8px;max-width:340px}
.toast.show{transform:translateX(0);opacity:1}
.toast-warn{background:rgba(40,10,10,0.95);border:1px solid rgba(239,68,68,0.25);color:#fca5a5}
.toast-info{background:rgba(10,20,50,0.95);border:1px solid rgba(59,130,246,0.25);color:#93c5fd}
.toast-success{background:rgba(10,40,20,0.95);border:1px solid rgba(34,197,94,0.25);color:#86efac}
.toast svg{width:16px;height:16px;flex-shrink:0}
.app-footer{padding:16px 2rem;border-top:1px solid var(--border);display:flex;align-items:center;justify-content:space-between;gap:12px;flex-wrap:wrap;font-size:0.72rem;color:var(--text-muted);background:rgba(17,24,39,0.5);flex-shrink:0}
.footer-lock{display:flex;align-items:center;gap:6px}
.footer-lock svg{width:12px;height:12px;color:#22c55e}
.curtain{position:fixed;inset:0;display:flex;flex-direction:column;align-items:center;justify-content:center;text-align:center;padding:2rem;opacity:0;visibility:hidden;transition:opacity .25s ease,visibility .25s ease}
.curtain.active{opacity:1;visibility:visible}
.curtain h2{font-family:var(--serif);font-size:1.4rem;margin-bottom:8px}
.curtain p{font-size:0.85rem;color:var(--text-muted);max-width:420px;line-height:1.6}
.curtain .icon{width:64px;height:64px;border-radius:50%;display:flex;align-items:center;justify-content:center;margin-bottom:20px}
.curtain .icon svg{width:28px;height:28px}
.curtain button{margin-top:24px;padding:10px 28px;border-radius:8px;background:linear-gradient(135deg,#3b82f6,#6366f1);color:#fff;border:none;font-size:0.85rem;font-weight:600;cursor:pointer;font-family:inherit;box-shadow:0 0 20px rgba(59,130,246,0.25);transition:transform .15s,box-shadow .15s}
.curtain button:hover{transform:translateY(-1px);box-shadow:0 0 30px rgba(59,130,246,0.4)}
#screenshotBlock{z-index:9995;background:#0a0e17}
#screenshotBlock .icon{background:rgba(239,68,68,0.1);border:1px solid rgba(239,68,68,0.2)}
#screenshotBlock .icon svg{color:#ef4444}
#screenshotBlock h2{color:#fca5a5}
#idleLock{z-index:9996;background:rgba(10,14,23,0.985);backdrop-filter:blur(6px)}
#idleLock .icon{background:rgba(59,130,246,0.1);border:1px solid rgba(59,130,246,0.2)}
#idleLock .icon svg{color:#3b82f6}
#devtoolsBlock{z-index:9997;background:#0a0e17}
#devtoolsBlock .icon{background:rgba(239,68,68,0.1);border:1px solid rgba(239,68,68,0.2)}
#devtoolsBlock .icon svg{color:#ef4444}
#devtoolsBlock h2{color:#fca5a5}
#expiredBlock{z-index:9998;background:#0a0e17}
#expiredBlock .icon{background:rgba(148,163,184,0.08);border:1px solid rgba(148,163,184,0.18)}
#expiredBlock .icon svg{color:#94a3b8}
#lockGate{z-index:9994;background:#0a0e17}
#lockGate .icon{background:rgba(59,130,246,0.1);border:1px solid rgba(59,130,246,0.2)}
#lockGate .icon svg{color:#3b82f6}
.lock-form{display:flex;gap:8px;margin-top:22px;width:100%;max-width:360px}
.lock-form input{flex:1;min-width:0;padding:11px 14px;border-radius:8px;background:rgba(17,24,39,0.9);border:1px solid rgba(59,130,246,0.22);color:var(--text-primary);font-family:inherit;font-size:0.9rem}
.lock-form input:focus{outline:none;border-color:var(--accent)}
.lock-form button{margin-top:0;padding:11px 22px;white-space:nowrap}
.lock-form button[disabled]{opacity:.55;cursor:progress}
.lock-msg{margin-top:12px;font-size:0.78rem;min-height:1.2em;color:#fca5a5;max-width:360px}
.lock-msg.info{color:var(--text-muted)}
#frameBlock{z-index:9999;background:#0a0e17}
#frameBlock .icon{background:rgba(239,68,68,0.1);border:1px solid rgba(239,68,68,0.2)}
#frameBlock .icon svg{color:#ef4444}
${usePrint ? `@media print{html,body{background:#fff!important}body>*{display:none!important}body::after{content:'This document is protected. Printing has been disabled.';display:flex;align-items:center;justify-content:center;height:100vh;font-size:20px;color:#111;font-family:Helvetica,Arial,sans-serif;text-align:center;padding:2rem}}` : ''}
@media(max-width:768px){.app-header{padding:0 1rem}.info-bar{padding:12px 1rem}.doc-toolbar{padding:8px 1rem;flex-wrap:wrap}.viewer-wrapper{padding:1rem}.logo-text{font-size:1rem}.security-tags{display:none}.viewer-frame{min-height:70vh}.watermark-layer{opacity:0.17}.lock-form{flex-direction:column}.lock-form button{width:100%}}
.fade-in{animation:fadeIn .5s ease-out forwards}.fade-in-delay{animation:fadeIn .5s ease-out .12s forwards;opacity:0}.fade-in-delay2{animation:fadeIn .5s ease-out .22s forwards;opacity:0}
@keyframes fadeIn{from{opacity:0;transform:translateY(10px)}to{opacity:1;transform:translateY(0)}}
@media(prefers-reduced-motion:reduce){*,*::before,*::after{animation-duration:.001ms!important;animation-iteration-count:1!important;transition-duration:.001ms!important}.fade-in-delay,.fade-in-delay2{opacity:1}}
</style>
</head>
<body>
<div class="bg-mesh"></div>
<div class="toast-container" id="toastContainer" role="status" aria-live="polite"></div>

<div class="app-container">
    <header class="app-header fade-in">
<div class="logo-group">
    <div class="logo-icon"><svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke-width="2" stroke="currentColor"><path stroke-linecap="round" stroke-linejoin="round" d="M9 12.75 11.25 15 15 9.75m-3-7.036A11.959 11.959 0 0 1 3.598 6 11.99 11.99 0 0 0 3 9.749c0 5.592 3.824 10.29 9 11.623 5.176-1.332 9-6.03 9-11.622 0-1.31-.21-2.571-.598-3.751h-.152c-3.196 0-6.1-1.248-8.25-3.285Z"/></svg></div>
    <span class="logo-text">SecureDoc Portal</span>
</div>
<div class="header-right">
    ${useTimer ? `<div class="session-timer" id="sessionTimer" title="Time remaining in this viewing session"><svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke-width="1.5" stroke="currentColor"><path stroke-linecap="round" stroke-linejoin="round" d="M12 6v6h4.5m4.5 0a9 9 0 1 1-18 0 9 9 0 0 1 18 0Z"/></svg><span id="timerText">${sessionMin}:00</span></div>` : ''}
    <div class="header-badge badge-class"><span class="badge-dot"></span>${escH(classification)}</div>
</div>
    </header>

    <div class="info-bar fade-in-delay">
<div class="doc-meta">
    <div class="meta-item"><svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke-width="1.5" stroke="currentColor"><path stroke-linecap="round" stroke-linejoin="round" d="M19.5 14.25v-2.625a3.375 3.375 0 0 0-3.375-3.375h-1.5A1.125 1.125 0 0 1 13.5 7.125v-1.5a3.375 3.375 0 0 0-3.375-3.375H8.25m2.25 0H5.625c-.621 0-1.125.504-1.125 1.125v17.25c0 .621.504 1.125 1.125 1.125h12.75c.621 0 1.125-.504 1.125-1.125V11.25a9 9 0 0 0-9-9Z"/></svg><strong>${escH(title)}</strong></div>
    <div class="meta-item"><svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke-width="1.5" stroke="currentColor"><path stroke-linecap="round" stroke-linejoin="round" d="M15.75 6a3.75 3.75 0 1 1-7.5 0 3.75 3.75 0 0 1 7.5 0ZM4.501 20.118a7.5 7.5 0 0 1 14.998 0A17.933 17.933 0 0 1 12 21.75c-2.676 0-5.216-.584-7.499-1.632Z"/></svg>Owner:&nbsp;<strong>${escH(owner)}</strong></div>
    <div class="meta-item"><svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke-width="1.5" stroke="currentColor"><path stroke-linecap="round" stroke-linejoin="round" d="M2.036 12.322a1.012 1.012 0 0 1 0-.639C3.423 7.51 7.36 4.5 12 4.5c4.638 0 8.573 3.007 9.963 7.178.07.207.07.431 0 .639C20.577 16.49 16.64 19.5 12 19.5c-4.638 0-8.573-3.007-9.963-7.178Z"/><path stroke-linecap="round" stroke-linejoin="round" d="M15 12a3 3 0 1 1-6 0 3 3 0 0 1 6 0Z"/></svg>Access:&nbsp;<strong>${escH(access)}</strong></div>
</div>
<div class="security-tags">${secTags.join('')}</div>
    </div>

    <div class="doc-toolbar fade-in-delay2">
<div class="toolbar-left">
    <button class="toolbar-btn" id="zoomOutBtn" title="Zoom out" aria-label="Zoom out"><svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke-width="1.5" stroke="currentColor"><path stroke-linecap="round" stroke-linejoin="round" d="M21 21l-5.197-5.197m0 0A7.5 7.5 0 105.196 5.196a7.5 7.5 0 0010.607 10.607zM13.5 10.5h-6"/></svg></button>
    <span class="zoom-display" id="zoomDisplay">100%</span>
    <button class="toolbar-btn" id="zoomInBtn" title="Zoom in" aria-label="Zoom in"><svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke-width="1.5" stroke="currentColor"><path stroke-linecap="round" stroke-linejoin="round" d="M21 21l-5.197-5.197m0 0A7.5 7.5 0 105.196 5.196a7.5 7.5 0 0010.607 10.607zM10.5 7.5v6m3-3h-6"/></svg></button>
    <button class="toolbar-btn" id="zoomResetBtn" title="Reset zoom">Fit</button>
    <div class="toolbar-divider"></div>
    <button class="toolbar-btn" id="fullscreenBtn" title="Toggle fullscreen"><svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke-width="1.5" stroke="currentColor"><path stroke-linecap="round" stroke-linejoin="round" d="M3.75 3.75v4.5m0-4.5h4.5m-4.5 0L9 9M3.75 20.25v-4.5m0 4.5h4.5m-4.5 0L9 15M20.25 3.75h-4.5m4.5 0v4.5m0-4.5L15 9m5.25 11.25h-4.5m4.5 0v-4.5m0 4.5L15 15"/></svg>Fullscreen</button>
</div>
<div class="toolbar-right">
    <button class="toolbar-btn locked" data-blocked="Downloading is disabled for this document"><svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke-width="1.5" stroke="currentColor"><path stroke-linecap="round" stroke-linejoin="round" d="M3 16.5v2.25A2.25 2.25 0 005.25 21h13.5A2.25 2.25 0 0021 18.75V16.5M16.5 12L12 16.5m0 0L7.5 12m4.5 4.5V3"/></svg>Download</button>
    <button class="toolbar-btn locked" data-blocked="Printing is disabled for this document"><svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke-width="1.5" stroke="currentColor"><path stroke-linecap="round" stroke-linejoin="round" d="M6.72 13.829c-.24.03-.48.062-.72.096m.72-.096a42.415 42.415 0 0 1 10.56 0m-10.56 0L6.34 18m10.94-4.171c.24.03.48.062.72.096m-.72-.096L17.66 18m0 0 .229 2.523a1.125 1.125 0 0 1-1.12 1.227H7.231c-.662 0-1.18-.568-1.12-1.227L6.34 18m11.318 0h1.091A2.25 2.25 0 0 0 21 15.75V9.456c0-1.081-.768-2.015-1.837-2.175a48.055 48.055 0 0 0-1.913-.247M6.34 18H5.25A2.25 2.25 0 0 1 3 15.75V9.456c0-1.081.768-2.015 1.837-2.175a48.041 48.041 0 0 1 1.913-.247m10.5 0a48.536 48.536 0 0 0-10.5 0m10.5 0V3.375c0-.621-.504-1.125-1.125-1.125h-8.25c-.621 0-1.125.504-1.125 1.125v3.659M18.75 12H5.25"/></svg>Print</button>
</div>
    </div>

    <div class="viewer-wrapper fade-in-delay2">
<div class="viewer-frame" id="viewerFrame">
    <iframe id="docFrame" class="doc-frame" title="${escH(title)}"${srcFromScript ? '' : ` src="${escH(embedUrl)}"`}
            loading="eager" fetchpriority="high"
            allow="fullscreen" allowfullscreen${useSandbox ? `
            sandbox="allow-scripts allow-same-origin allow-popups allow-forms allow-modals allow-presentation"` : ''}></iframe>
    <script>
    /* Boot: start the document request as early as possible and record
       its load state before any other script runs. */
    (function(){
        ${urlSnippet}
        var f=document.getElementById('docFrame');
        var s=window.__sdDoc={loaded:false,failed:false,cbs:[],loads:0,lastLoadAt:0};
        function fire(k){if(s.loaded||s.failed)return;s[k]=true;for(var i=0;i<s.cbs.length;i++){try{s.cbs[i](k)}catch(e){}}s.cbs.length=0}
        /* A viewer that redirects fires load more than once; the last one
           is what tells us rendering has actually gone quiet. */
        f.addEventListener('load',function(){s.loads++;s.lastLoadAt=Date.now();fire('loaded')});
        f.addEventListener('error',function(){fire('failed')});
        ${sessionBoot}
        ${startSnippet}
    })();
    <\/script>
    ${useWatermark ? `<div class="watermark-layer" id="watermarkLayer" style="background-image:url(&quot;${wmUri}&quot;)"></div>` : ''}
    ${useGuard ? `<div class="frame-guard" id="frameGuard" title="Viewer controls are disabled"></div>` : ''}
    <div class="render-bar" id="renderBar" aria-hidden="true"></div>
    <div class="loader-overlay" id="loader">
        <div class="spinner"></div>
        <p class="loader-text" id="loaderText">Establishing secure channel…</p>
        <div class="loader-progress"><div class="loader-progress-bar" id="loaderBar"></div></div>
        <div class="loader-fallback">
            <p>The document is taking longer than expected. The usual causes are that it is not shared with “Anyone with the link — Viewer”, or that the host refuses to be embedded.</p>
            <button type="button" id="retryBtn">Retry</button>
            <button type="button" id="openDirectBtn" class="ghost">Open document directly</button>
        </div>
    </div>
</div>
    </div>

    <footer class="app-footer">
<div class="footer-lock"><svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke-width="2" stroke="currentColor"><path stroke-linecap="round" stroke-linejoin="round" d="M9 12.75 11.25 15 15 9.75m-3-7.036A11.959 11.959 0 0 1 3.598 6 11.99 11.99 0 0 0 3 9.749c0 5.592 3.824 10.29 9 11.623 5.176-1.332 9-6.03 9-11.622 0-1.31-.21-2.571-.598-3.751h-.152c-3.196 0-6.1-1.248-8.25-3.285Z"/></svg>Protected viewing session${useXor ? ' &middot; obfuscated source link' : ''}</div>
<span>Session started at <span id="sessionStart">—</span></span>
<span>&copy; <span id="year"></span> SecureDoc Portal. All rights reserved.</span>
    </footer>
</div>

${useScreenshot ? `<div class="curtain" id="screenshotBlock"><div class="icon"><svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke-width="1.5" stroke="currentColor"><path stroke-linecap="round" stroke-linejoin="round" d="M12 9v3.75m-9.303 3.376c-.866 1.5.217 3.374 1.948 3.374h14.71c1.73 0 2.813-1.874 1.948-3.374L13.949 3.378c-.866-1.5-3.032-1.5-3.898 0L2.697 16.126ZM12 15.75h.007v.008H12v-.008Z"/></svg></div><h2>Content Hidden</h2><p>The document is concealed while this window is in the background. Return to the tab to continue reading.</p></div>` : ''}
${useIdle ? `<div class="curtain" id="idleLock"><div class="icon"><svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke-width="1.5" stroke="currentColor"><path stroke-linecap="round" stroke-linejoin="round" d="M16.5 10.5V6.75a4.5 4.5 0 1 0-9 0v3.75m-.75 11.25h10.5a2.25 2.25 0 0 0 2.25-2.25v-6.75a2.25 2.25 0 0 0-2.25-2.25H6.75a2.25 2.25 0 0 0-2.25 2.25v6.75a2.25 2.25 0 0 0 2.25 2.25Z"/></svg></div><h2>Session Locked</h2><p>Your session was locked after a period of inactivity.</p><button type="button" id="resumeBtn">Resume Viewing</button></div>` : ''}
${useDevtools ? `<div class="curtain" id="devtoolsBlock"><div class="icon"><svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke-width="1.5" stroke="currentColor"><path stroke-linecap="round" stroke-linejoin="round" d="M17.982 18.725A7.488 7.488 0 0 0 12 15.75a7.488 7.488 0 0 0-5.982 2.975m11.963 0a9 9 0 1 0-11.963 0m11.963 0A8.966 8.966 0 0 1 12 21a8.966 8.966 0 0 1-5.982-2.275M15 9.75a3 3 0 1 1-6 0 3 3 0 0 1 6 0Z"/></svg></div><h2>Access Suspended</h2><p>Developer tools appear to be open. The document is hidden until they are closed.</p></div>` : ''}
<div class="curtain" id="expiredBlock"><div class="icon"><svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke-width="1.5" stroke="currentColor"><path stroke-linecap="round" stroke-linejoin="round" d="M12 6v6h4.5m4.5 0a9 9 0 1 1-18 0 9 9 0 0 1 18 0Z"/></svg></div><h2>Session Expired</h2><p>Your viewing session has ended. Please request a new access link from the document owner.</p></div>
${useLock ? `<div class="curtain active" id="lockGate"><div class="icon"><svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke-width="1.5" stroke="currentColor"><path stroke-linecap="round" stroke-linejoin="round" d="M16.5 10.5V6.75a4.5 4.5 0 1 0-9 0v3.75m-.75 11.25h10.5a2.25 2.25 0 0 0 2.25-2.25v-6.75a2.25 2.25 0 0 0-2.25-2.25H6.75a2.25 2.25 0 0 0-2.25 2.25v6.75a2.25 2.25 0 0 0 2.25 2.25Z"/></svg></div><h2>Password Required</h2><p>This document is encrypted. Enter the password you were given &mdash; it is the key, so there is nothing to read here without it.</p><form class="lock-form" id="lockForm" autocomplete="off"><input id="lockInput" type="password" autocomplete="off" autocapitalize="off" autocorrect="off" spellcheck="false" placeholder="Password" aria-label="Document password"><button type="submit" id="lockBtn">Unlock</button></form><div class="lock-msg" id="lockMsg" role="status" aria-live="polite"></div></div>` : ''}
<div class="curtain" id="frameBlock"><div class="icon"><svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke-width="1.5" stroke="currentColor"><path stroke-linecap="round" stroke-linejoin="round" d="M12 9v3.75m-9.303 3.376c-.866 1.5.217 3.374 1.948 3.374h14.71c1.73 0 2.813-1.874 1.948-3.374L13.949 3.378c-.866-1.5-3.032-1.5-3.898 0L2.697 16.126ZM12 15.75h.007v.008H12v-.008Z"/></svg></div><h2>Embedding Blocked</h2><p>This portal must be opened directly, not inside another page.</p></div>

<script>
(function(){
    'use strict';

    var SESSION_SECONDS = ${sessionMin} * 60;
    var IDLE_MS = 5 * 60 * 1000;
    var IDLE_FOCUSED_MS = 15 * 60 * 1000;
    var WATCHDOG_MS = ${LOAD_WATCHDOG_MS};
    var ZOOM_MIN = 50, ZOOM_MAX = 200, ZOOM_STEP = 15;

    var frame = document.getElementById('docFrame');
    var viewer = document.getElementById('viewerFrame');
    var loader = document.getElementById('loader');
    var loaderBar = document.getElementById('loaderBar');
    var loaderText = document.getElementById('loaderText');

    var expired = false;
    var currentZoom = 100;

    /* Detect the generator's own preview so protections do not fight it. */
    var inPreview = false, framed = false;
    try { framed = (window.top !== window.self); } catch (e) { framed = true; }
    try { inPreview = !!(window.frameElement && window.frameElement.hasAttribute('data-securedoc-preview')); } catch (e) { inPreview = false; }

    /* ---------- toasts ---------- */
    var ICONS = {
warn: '<svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke-width="1.5" stroke="currentColor"><path stroke-linecap="round" stroke-linejoin="round" d="M12 9v3.75m-9.303 3.376c-.866 1.5.217 3.374 1.948 3.374h14.71c1.73 0 2.813-1.874 1.948-3.374L13.949 3.378c-.866-1.5-3.032-1.5-3.898 0L2.697 16.126ZM12 15.75h.007v.008H12v-.008Z"/></svg>',
info: '<svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke-width="1.5" stroke="currentColor"><path stroke-linecap="round" stroke-linejoin="round" d="m11.25 11.25.041-.02a.75.75 0 0 1 1.063.852l-.708 2.836a.75.75 0 0 0 1.063.853l.041-.021M21 12a9 9 0 1 1-18 0 9 9 0 0 1 18 0Zm-9-3.75h.008v.008H12V8.25Z"/></svg>',
success: '<svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke-width="1.5" stroke="currentColor"><path stroke-linecap="round" stroke-linejoin="round" d="M9 12.75 11.25 15 15 9.75M21 12a9 9 0 1 1-18 0 9 9 0 0 1 18 0Z"/></svg>'
    };
    var lastToast = '';
    var lastToastAt = 0;
    function showToast(msg, type, dur) {
type = type || 'info';
dur = dur || 3500;
var now = Date.now();
if (msg === lastToast && now - lastToastAt < 1200) return;   // collapse repeats
lastToast = msg; lastToastAt = now;
var c = document.getElementById('toastContainer');
if (!c) return;
var t = document.createElement('div');
t.className = 'toast toast-' + type;
var icon = document.createElement('span');
icon.innerHTML = ICONS[type] || ICONS.info;
var span = document.createElement('span');
span.textContent = msg;
t.appendChild(icon.firstChild);
t.appendChild(span);
c.appendChild(t);
requestAnimationFrame(function(){ requestAnimationFrame(function(){ t.classList.add('show'); }); });
setTimeout(function(){ t.classList.remove('show'); setTimeout(function(){ if (t.parentNode) t.parentNode.removeChild(t); }, 420); }, dur);
    }

    function curtain(id, on) {
var el = document.getElementById(id);
if (el) el.classList.toggle('active', !!on);
    }

    /* ---------- clickjacking guard ---------- */
    if (framed && !inPreview) {
curtain('frameBlock', true);
    }

    /* ---------- document load ---------- */
    function onDocState(cb) {
var s = window.__sdDoc;
if (!s) { cb('failed'); return; }
if (s.loaded) cb('loaded');
else if (s.failed) cb('failed');
else s.cbs.push(cb);
    }

    var loadStart = Date.now();
    var settled = false;
    var progressStopped = false;      // kept separate from settled: the failed
                              // path stays unsettled so Retry can re-run,
                              // but the rAF loop must still stop.

    function tickProgress() {
if (progressStopped) return;
var t = (Date.now() - loadStart) / 1000;
// Asymptotic approach to 92% so the bar always reflects real elapsed time.
var pct = 92 * (1 - Math.exp(-t / 1.15));
loaderBar.style.width = pct.toFixed(1) + '%';
requestAnimationFrame(tickProgress);
    }
    var watchdog = null;
    /* Restarts the progress bar and the stall watchdog from now. Called at
       boot, on Retry, and after a password is accepted — in the last case the
       clock must not have been running while the viewer was typing. */
    function armLoad() {
clearTimeout(watchdog);
loadStart = Date.now();
settled = false;
progressStopped = false;
requestAnimationFrame(tickProgress);
watchdog = setTimeout(function(){
    if (settled) return;
    progressStopped = true;
    loader.classList.add('stalled');
    loaderText.textContent = 'Still waiting for the document…';
}, WATCHDOG_MS);
    }
    ${useLock ? '' : `if (!window.__sdSession.expired) armLoad();`}

    var renderBar = document.getElementById('renderBar');
    var RENDER_QUIET_MS = 2500;

    // The webfont is attached only after the document is up, so it never
    // competes with the document request for connections or bandwidth.
    var fontsQueued = false;
    function attachFonts() {
if (fontsQueued) return;
fontsQueued = true;
var l = document.createElement('link');
l.rel = 'stylesheet';
l.href = 'https://fonts.googleapis.com/css2?family=DM+Sans:wght@300;400;500;600;700&family=DM+Serif+Display&display=swap';
l.crossOrigin = 'anonymous';
document.head.appendChild(l);
    }
    setTimeout(attachFonts, 6000);        // never leave the chrome unstyled forever

    // Hand the viewport over as soon as the frame reports a load, then keep a
    // slim bar running until it stops navigating -- an embedded viewer usually
    // redirects a couple of times before it paints, and hiding every signal at
    // the first load is what makes a slow document feel broken.
    function watchRendering() {
var st = window.__sdDoc;
if (!st) return;
renderBar.classList.add('show');
(function poll() {
    if (expired) { renderBar.classList.remove('show'); return; }
    if (Date.now() - st.lastLoadAt >= RENDER_QUIET_MS) {
        renderBar.classList.remove('show');
        return;
    }
    setTimeout(poll, 400);
})();
    }

    function settle(state) {
if (settled) return;
clearTimeout(watchdog);
progressStopped = true;
if (state === 'failed') {
    loaderBar.style.width = '100%';
    loader.classList.add('stalled');
    loaderText.textContent = 'The document could not be loaded.';
    return;                       // leave unsettled so Retry can re-run
}
settled = true;
loaderBar.style.width = '100%';
document.body.classList.add('doc-ready');
loader.classList.add('hidden');
setTimeout(function(){ loader.style.display = 'none'; }, 400);
attachFonts();
watchRendering();
showToast('Document loaded securely', 'success', 2200);
    }
    onDocState(settle);

    var openDirectBtn = document.getElementById('openDirectBtn');
    if (openDirectBtn) {
openDirectBtn.addEventListener('click', function(){
    var u = window.getDocUrl();
    if (!u) { showToast('Unlock the document first', 'warn'); return; }
    try { window.open(u, '_blank', 'noopener'); }
    catch (e) { showToast('Could not open the document', 'warn'); }
});
    }

    var retryBtn = document.getElementById('retryBtn');
    if (retryBtn) {
retryBtn.addEventListener('click', function(){
    if (!window.getDocUrl()) { showToast('Unlock the document first', 'warn'); return; }
    loader.classList.remove('stalled');
    loaderText.textContent = 'Retrying…';
    armLoad();
    frame.addEventListener('load', function once(){ frame.removeEventListener('load', once); settle('loaded'); });
    try { frame.src = window.getDocUrl(); } catch (e) { settle('failed'); }
});
    }

    /* ---------- password gate ---------- */
    ${lock ? `
    (function(){
var L_S = ${jsStr(lock.s)}, L_I = ${jsStr(lock.i)}, L_C = ${jsStr(lock.c)}, L_N = ${lock.n | 0};
var form = document.getElementById('lockForm');
var input = document.getElementById('lockInput');
var btn = document.getElementById('lockBtn');
var msg = document.getElementById('lockMsg');
var fails = 0, busy = false;

function say(text, kind) {
    msg.textContent = text;
    msg.className = 'lock-msg' + (kind === 'info' ? ' info' : '');
}

if (!(window.crypto && window.crypto.subtle)) {
    // SubtleCrypto is only exposed in a secure context, so this is what an
    // http:// or file:// copy of the portal looks like. There is no fallback
    // worth offering: a weaker cipher here would defeat the point.
    form.style.display = 'none';
    say('This browser will not decrypt the document because the page was not loaded over a secure connection. Open the link over https:// and try again.');
    return;
}

function ub64(str) {
    var b = String(str).replace(/-/g, '+').replace(/_/g, '/');
    while (b.length % 4) b += '=';
    var bin = atob(b), out = new Uint8Array(bin.length);
    for (var i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
}

/* The password is the decryption key, not something compared against a
   stored answer. A wrong one fails at the AES-GCM authentication tag, so
   there is no check in this script that could be patched out and no URL in
   this file to find without it. */
function decryptUrl(pw) {
    var enc = new TextEncoder();
    return crypto.subtle.importKey('raw', enc.encode(pw), 'PBKDF2', false, ['deriveKey'])
        .then(function(m){
            return crypto.subtle.deriveKey(
                { name: 'PBKDF2', salt: ub64(L_S), iterations: L_N, hash: 'SHA-256' },
                m, { name: 'AES-GCM', length: 256 }, false, ['decrypt']);
        })
        .then(function(k){
            return crypto.subtle.decrypt({ name: 'AES-GCM', iv: ub64(L_I) }, k, ub64(L_C));
        })
        .then(function(buf){ return new TextDecoder().decode(buf); });
}

function openDoc(url) {
    window.__sdUrl = url;
    curtain('lockGate', false);
    // The load clock starts now, not when the page opened, so a viewer who
    // took a while to type is not told the document is stalling.
    armLoad();
    try { frame.src = url; } catch (e) { settle('failed'); }
}

form.addEventListener('submit', function(e){
    e.preventDefault();
    if (busy) return;
    var pw = input.value;
    if (!pw) { say('Enter the password.'); return; }
    busy = true;
    btn.disabled = true;
    say('Unlocking…', 'info');
    // Key derivation is deliberately slow; yield a frame first so the
    // message is on screen before the main thread goes quiet.
    requestAnimationFrame(function(){
        decryptUrl(pw).then(function(url){
            var head = String(url).slice(0, 8).toLowerCase();
            if (head.indexOf('https://') !== 0 && head.indexOf('http://') !== 0) {
                throw new Error('not a url');
            }
            say('');
            openDoc(url);
        }).catch(function(){
            fails++;
            busy = false;
            input.value = '';
            say('That password is not correct.');
            // Slows down guessing at the keyboard. It cannot slow down an
            // offline attack on the ciphertext — the iteration count is what
            // does that — so a strong password still matters.
            setTimeout(function(){ btn.disabled = false; try { input.focus(); } catch (e) {} },
                       Math.min(8000, 500 * Math.pow(2, fails - 1)));
        });
    });
});
setTimeout(function(){ try { input.focus(); } catch (e) {} }, 60);
    })();` : ''}

    /* ---------- zoom ----------
       The iframe viewport is widened/narrowed and then scaled back, so the
       embedded document reflows instead of being blurrily bitmap-scaled. */
    function applyZoom() {
var s = currentZoom / 100;
frame.style.width = (100 / s) + '%';
frame.style.height = (100 / s) + '%';
frame.style.transform = 'scale(' + s + ')';
document.getElementById('zoomDisplay').textContent = currentZoom + '%';
    }
    document.getElementById('zoomInBtn').addEventListener('click', function(){
currentZoom = Math.min(currentZoom + ZOOM_STEP, ZOOM_MAX); applyZoom();
    });
    document.getElementById('zoomOutBtn').addEventListener('click', function(){
currentZoom = Math.max(currentZoom - ZOOM_STEP, ZOOM_MIN); applyZoom();
    });
    document.getElementById('zoomResetBtn').addEventListener('click', function(){
currentZoom = 100; applyZoom();
    });
    document.getElementById('fullscreenBtn').addEventListener('click', function(){
if (!document.fullscreenElement) {
    if (viewer.requestFullscreen) viewer.requestFullscreen().catch(function(){});
} else if (document.exitFullscreen) {
    document.exitFullscreen();
}
    });

    /* ---------- blocked toolbar buttons ---------- */
    Array.prototype.forEach.call(document.querySelectorAll('.toolbar-btn.locked'), function(b){
b.addEventListener('click', function(){ showToast(b.getAttribute('data-blocked'), 'warn'); });
    });

    /* ---------- activity tracking (shared by idle lock) ---------- */
    var lastActivity = Date.now();
    function markActive() { lastActivity = Date.now(); }
    ['mousemove','mousedown','keydown','wheel','touchstart','click','focus'].forEach(function(evt){
window.addEventListener(evt, markActive, { passive: true, capture: true });
    });

    /* ---------- session timer ---------- */
    ${useTimer ? `
    var timerEl = document.getElementById('timerText');
    var timerWrap = document.getElementById('sessionTimer');
    // Deadline-based so a throttled/backgrounded tab still expires on time,
    // and resolved in the boot script from storage so a reload continues the
    // same countdown rather than handing out a fresh one.
    var deadline = window.__sdSession.deadline;
    if (!window.__sdSession.persisted) {
timerWrap.title = 'Time remaining. This browser is blocking site storage, so the countdown restarts if the page is reloaded.';
    }
    function expire() {
if (expired) return;
expired = true;
try { frame.removeAttribute('src'); frame.src = 'about:blank'; } catch (e) {}
frame.style.visibility = 'hidden';
curtain('expiredBlock', true);
    }
    function tickTimer() {
if (expired) return;
var left = Math.max(0, Math.round((deadline - Date.now()) / 1000));
var m = Math.floor(left / 60), s = left % 60;
timerEl.textContent = m + ':' + String(s).padStart(2, '0');
timerWrap.classList.toggle('expiring', left <= 300);
if (left <= 0) expire();
    }
    tickTimer();
    setInterval(tickTimer, 1000);
    document.addEventListener('visibilitychange', function(){ if (!document.hidden) tickTimer(); });` : ''}

    /* ---------- idle auto-lock ---------- */
    ${useIdle ? `
    var locked = false;
    function idleWindowMs() {
// Reading inside a cross-origin frame produces no events here, so the
// window is widened while the document itself holds focus.
try { return (document.activeElement === frame) ? IDLE_FOCUSED_MS : IDLE_MS; }
catch (e) { return IDLE_MS; }
    }
    function lockNow() {
if (locked || expired) return;
locked = true;
curtain('idleLock', true);
    }
    setInterval(function(){
if (!locked && !expired && Date.now() - lastActivity >= idleWindowMs()) lockNow();
    }, 1000);
    document.getElementById('resumeBtn').addEventListener('click', function(){
locked = false;
markActive();
curtain('idleLock', false);
showToast('Session resumed', 'success', 2000);
    });` : ''}

    /* ---------- screenshot / background protection ---------- */
    ${useScreenshot ? `
    if (!inPreview) {
var hideTimer = null;
function conceal() { curtain('screenshotBlock', true); }
function reveal() { clearTimeout(hideTimer); curtain('screenshotBlock', false); }
document.addEventListener('visibilitychange', function(){
    if (document.hidden) conceal(); else reveal();
});
window.addEventListener('blur', function(){
    // Clicking into the document moves focus to the iframe and fires
    // blur on this window — that is not a background switch.
    if (document.activeElement === frame) return;
    clearTimeout(hideTimer);
    hideTimer = setTimeout(function(){ if (!document.hasFocus()) conceal(); }, 120);
});
window.addEventListener('focus', reveal);
    }` : ''}

    /* ---------- watermark ----------
       A web page cannot stop an operating-system screenshot, on a phone least
       of all. What it can do is make sure every capture carries the session
       stamp, so a leaked image says which viewing session produced it. */
    ${useWatermark ? `
    (function(){
var layer = document.getElementById('watermarkLayer');
if (!layer) return;
var WM = ${jsStr(wmText)};
var stamp = window.__sdSession.sid + ' \u00b7 ' + new Date(window.__sdSession.startedAt)
    .toLocaleString([], { year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' });

function esc(v) {
    return String(v).replace(/&/g, '&amp;').replace(/</g, '&lt;')
                    .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}
function tile(w, h, fs) {
    function pair(x, y) {
        var y2 = y + fs + 3;
        return '<text x="' + x + '" y="' + y + '" font-size="' + fs + '" font-weight="700" transform="rotate(-30 ' + x + ' ' + y + ')">' + esc(WM) + '</text>'
             + '<text x="' + x + '" y="' + y2 + '" font-size="' + Math.round(fs * 0.74) + '" font-weight="500" transform="rotate(-30 ' + x + ' ' + y2 + ')">' + esc(stamp) + '</text>';
    }
    return 'data:image/svg+xml,' + encodeURIComponent(
        '<svg xmlns="http://www.w3.org/2000/svg" width="' + w + '" height="' + h + '" viewBox="0 0 ' + w + ' ' + h + '">'
        + '<g fill="#0f172a" font-family="Helvetica,Arial,sans-serif" letter-spacing="1.5">'
        + pair(8, Math.round(h * 0.30)) + pair(Math.round(w * 0.5), Math.round(h * 0.78))
        + '</g></svg>');
}
function paint() {
    // Phone screens get a smaller tile: the same physical area then carries
    // several stamps, so a cropped screenshot still contains one.
    var small = window.innerWidth <= 768;
    var w = small ? 250 : 360, h = small ? 150 : 210, fs = small ? 12 : 15;
    layer.style.backgroundImage = 'url("' + tile(w, h, fs) + '")';
    layer.style.backgroundSize = w + 'px ' + h + 'px';
}
paint();
window.addEventListener('resize', paint, { passive: true });
window.addEventListener('orientationchange', paint, { passive: true });

/* A watermark that a single inspector click removes is not evidence of
   anything, so the layer is restored whenever it is detached or styled
   away. This does not defeat a determined viewer — nothing running in
   their browser can — it defeats the trivial version and keeps the stamp
   present in an ordinary capture. */
function ensure() {
    if (layer.parentNode !== viewer) viewer.appendChild(layer);
    var st = layer.style;
    if (st.display === 'none') st.removeProperty('display');
    if (st.visibility === 'hidden') st.removeProperty('visibility');
    if (st.opacity === '0') st.removeProperty('opacity');
    if (!st.backgroundImage) paint();
}
try {
    new MutationObserver(ensure).observe(viewer, {
        childList: true, attributes: true, subtree: true, attributeFilter: ['style', 'class'],
    });
} catch (e) {}
setInterval(ensure, 2000);
    })();` : ''}

    /* ---------- copy / selection protection ---------- */
    ${useCopyProtect ? `
    ['copy','cut','paste'].forEach(function(evt){
document.addEventListener(evt, function(e){
    e.preventDefault();
    showToast('Action blocked — this document is protected', 'warn');
});
    });
    document.addEventListener('contextmenu', function(e){
e.preventDefault();
showToast('Right-click is disabled', 'warn');
    });
    document.addEventListener('selectstart', function(e){ e.preventDefault(); });
    document.addEventListener('dragstart', function(e){ e.preventDefault(); });
    document.addEventListener('keydown', function(e){
var k = (e.key || '').toLowerCase();
// Leave zoom (Ctrl +/-/0) and reload alone so the page stays usable.
if ((e.ctrlKey || e.metaKey) && !e.shiftKey && ['c','x','v','a','s'].indexOf(k) > -1) {
    e.preventDefault();
    showToast('Keyboard shortcut blocked', 'warn');
}
if ((e.ctrlKey || e.metaKey) && e.shiftKey && ['i','j','c'].indexOf(k) > -1) e.preventDefault();
if (e.key === 'F12' || e.key === 'PrintScreen') e.preventDefault();
    });` : ''}

    /* ---------- print blocking ---------- */
    ${usePrint ? `
    window.addEventListener('beforeprint', function(){
showToast('Printing is disabled for this document', 'warn');
    });
    document.addEventListener('keydown', function(e){
if ((e.ctrlKey || e.metaKey) && (e.key || '').toLowerCase() === 'p') {
    e.preventDefault();
    showToast('Printing is disabled for this document', 'warn');
}
    });` : ''}

    /* ---------- devtools detection ---------- */
    ${useDevtools ? `
    if (!inPreview && !framed && !('ontouchstart' in window)) {
// Compare against a baseline captured at load, so persistent browser
// chrome (bookmarks bar, sidebars) never trips the detector.
var baseW = Math.max(0, window.outerWidth - window.innerWidth);
var baseH = Math.max(0, window.outerHeight - window.innerHeight);
var THRESHOLD = 180;
var dtOpen = false;
function checkDevtools() {
    var dw = Math.max(0, window.outerWidth - window.innerWidth) - baseW;
    var dh = Math.max(0, window.outerHeight - window.innerHeight) - baseH;
    var open = (dw > THRESHOLD || dh > THRESHOLD);
    if (open === dtOpen) return;
    dtOpen = open;
    curtain('devtoolsBlock', open);
    if (!open) showToast('Access restored', 'success', 2000);
}
setInterval(checkDevtools, 1000);
window.addEventListener('resize', checkDevtools);
    }` : ''}

    /* ---------- footer state ---------- */
    document.getElementById('sessionStart').textContent =
new Date(window.__sdSession.startedAt).toLocaleTimeString();
    document.getElementById('year').textContent = new Date().getFullYear();
    ${useTimer ? `setTimeout(function(){ showToast('Secure session established — ${sessionMin} minutes remaining', 'info', 4000); }, 1000);` : ''}
})();
<\/script>
</body>
</html>`;

}
