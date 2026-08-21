/**
 * End-to-end checks for the generated portal, run in real Chromium.
 *
 *   node --experimental-strip-types tests/portal.test.mjs
 *
 * The embedded document is a local stub rather than a Google URL: what is
 * under test is the portal's own behaviour, and pointing at the real thing
 * would make the suite depend on network egress and on a document staying
 * shared. The stub is served over http://localhost, which counts as a secure
 * context, so SubtleCrypto behaves exactly as it does in production.
 */
import { createServer } from 'node:http';
import { existsSync } from 'node:fs';
import { chromium } from 'playwright';

// buildPortal's XOR path reads window.crypto; in Node there is no window.
globalThis.window = globalThis.window ?? { crypto: globalThis.crypto };

const { buildPortal } = await import('../lib/portal.ts');
const { lockUrl } = await import('../lib/lock.ts');
const { FEATURE_ORDER } = await import('../lib/types.ts');

const PASSWORD = 'correct horse battery';
const DOC_PATH = '/stub-document-9f31c2';

let failures = 0;
function check(name, cond, detail = '') {
  if (cond) { console.log(`  PASS  ${name}`); return; }
  failures++;
  console.log(`  FAIL  ${name}${detail ? `  -> ${detail}` : ''}`);
}

function flags(on) {
  return FEATURE_ORDER.reduce((m, n, i) => (on.includes(n) ? m | (1 << i) : m), 0);
}

function baseConfig(extra = {}) {
  return {
    u: '', t: 'Quarterly Review', o: 'A. Wijesingha',
    c: 'Confidential', a: 'View Only', s: 5, w: 'CONFIDENTIAL',
    f: flags(['watermark', 'sessionTimer']),
    ...extra,
  };
}

/* ---------------- fixture server ---------------- */

const pages = new Map();
const server = createServer((req, res) => {
  const path = req.url.split('?')[0];
  if (path === DOC_PATH) {
    res.writeHead(200, { 'content-type': 'text/html' });
    res.end('<!doctype html><title>Stub</title><h1>Stub document body</h1>');
    return;
  }
  const html = pages.get(path);
  if (html === undefined) { res.writeHead(404).end('no'); return; }
  res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
  res.end(html);
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const origin = `http://127.0.0.1:${server.address().port}`;
const docUrl = origin + DOC_PATH;

function serve(name, html) { pages.set(`/${name}`, html); return `${origin}/${name}`; }

/*
 * The sandbox ships a Chromium build that will not always match the Playwright
 * version installed here, so the binary is named explicitly when one is
 * present and left to Playwright's own lookup otherwise.
 */
const CHROME = process.env.CHROMIUM_PATH
  || (existsSync('/opt/pw-browsers/chromium-1194/chrome-linux/chrome')
      ? '/opt/pw-browsers/chromium-1194/chrome-linux/chrome'
      : undefined);
const browser = await chromium.launch(CHROME ? { executablePath: CHROME } : {});

async function fresh() {
  const ctx = await browser.newContext();
  const page = await ctx.newPage();
  page.on('pageerror', (e) => {
    if (page.__quiet) return;
    failures++;
    console.log(`  FAIL  uncaught page error -> ${e.message}`);
  });
  return { ctx, page };
}

/* ---------------- 1. password gate ---------------- */

console.log('\n=== PASSWORD GATE ===');
{
  const payload = await lockUrl(docUrl, PASSWORD);
  const cfg = baseConfig({ p: payload });
  const html = buildPortal(cfg);

  check('generated file does not contain the document URL', !html.includes(DOC_PATH),
    'the encrypted URL leaked into the page');
  check('generated file keeps only the origin as a preconnect hint',
    html.includes(origin) && !html.includes(DOC_PATH));

  const url = serve('locked.html', html);
  const { ctx, page } = await fresh();
  await page.goto(url);

  await page.waitForSelector('#lockGate.active');
  check('gate is up before anything loads', await page.isVisible('#lockGate'));
  check('document request has not started',
    (await page.getAttribute('#docFrame', 'src')) === null);

  // wrong password
  await page.fill('#lockInput', 'not the password');
  await page.click('#lockBtn');
  await page.waitForFunction(
    () => document.getElementById('lockMsg').textContent.indexOf('not correct') > -1,
    null, { timeout: 20000 },
  );
  check('wrong password is rejected', true);
  check('wrong password still loads nothing',
    !(await page.getAttribute('#docFrame', 'src')));

  // right password
  await page.waitForSelector('#lockBtn:not([disabled])');
  await page.fill('#lockInput', PASSWORD);
  await page.click('#lockBtn');
  await page.waitForFunction(
    (p) => (document.getElementById('docFrame').getAttribute('src') || '').indexOf(p) > -1,
    DOC_PATH, { timeout: 20000 },
  );
  check('right password decrypts and loads the document', true);
  await page.waitForSelector('#lockGate:not(.active)');
  check('gate closes', true);
  await page.waitForSelector('#loader.hidden', { state: 'attached', timeout: 20000 });
  check('loader settles after unlock', true);

  await ctx.close();
}

/* ---------------- 2. session survives a reload ---------------- */

console.log('\n=== SESSION TIMER ACROSS RELOAD ===');
{
  const url = serve('timed.html', buildPortal(baseConfig({ u: docUrl })));
  const { ctx, page } = await fresh();

  await page.goto(url);
  await page.waitForFunction(() => !!window.__sdSession);
  const first = await page.evaluate(() => window.__sdSession.deadline);
  const firstText = await page.textContent('#timerText');
  const sid = await page.evaluate(() => window.__sdSession.sid);

  check('deadline was persisted',
    await page.evaluate(() => !!localStorage.getItem(window.__sdSession.key)));

  await page.waitForTimeout(2500);
  await page.reload();
  await page.waitForFunction(() => !!window.__sdSession);
  const second = await page.evaluate(() => window.__sdSession.deadline);
  const secondText = await page.textContent('#timerText');

  check('reload keeps the same deadline', Math.abs(second - first) < 50,
    `${first} -> ${second}`);
  check('countdown continued rather than restarting', secondText !== firstText,
    `${firstText} -> ${secondText}`);
  check('session id is stable across reload',
    (await page.evaluate(() => window.__sdSession.sid)) === sid);

  await ctx.close();
}

/* ---------------- 3. an expired session never loads the document ---------------- */

console.log('\n=== EXPIRED SESSION ===');
{
  const cfg = baseConfig({ u: docUrl });
  const url = serve('expired.html', buildPortal(cfg));
  const { ctx, page } = await fresh();

  // Seed a record that has already run out, exactly as a viewer who opened
  // the link an hour ago would have.
  await page.goto(url);
  const key = await page.evaluate(() => window.__sdSession.key);
  await page.evaluate(([k, ttl]) => {
    localStorage.setItem(k, JSON.stringify({ d: Date.now() - 1000, n: ttl, sid: 'AAAAAA' }));
  }, [key, 5 * 60 * 1000]);

  // Count real network hits rather than reading the src attribute: expire()
  // blanks the frame to about:blank, so the attribute alone proves nothing.
  let docHits = 0;
  page.on('request', (r) => { if (r.url().includes(DOC_PATH)) docHits++; });
  await page.reload();

  await page.waitForSelector('#expiredBlock.active', { timeout: 10000 });
  check('expired session shows the expiry curtain', true);
  await page.waitForTimeout(1500);
  check('expired session never requests the document', docHits === 0, `${docHits} request(s)`);

  await ctx.close();
}

/* ---------------- 4. the clock cannot be wound back for more time -------------- */

console.log('\n=== CLOCK ROLLBACK ===');
{
  const url = serve('rollback.html', buildPortal(baseConfig({ u: docUrl })));
  const { ctx, page } = await fresh();
  await page.goto(url);
  const key = await page.evaluate(() => window.__sdSession.key);

  // A record claiming a full day of remaining time.
  await page.evaluate(([k, ttl]) => {
    localStorage.setItem(k, JSON.stringify({ d: Date.now() + 86400000, n: ttl, sid: 'BBBBBB' }));
  }, [key, 5 * 60 * 1000]);
  await page.reload();
  await page.waitForFunction(() => !!window.__sdSession);

  const left = await page.evaluate(() => window.__sdSession.deadline - Date.now());
  check('remaining time is capped at one session', left <= 5 * 60 * 1000 + 1000,
    `${Math.round(left / 1000)}s left`);

  await ctx.close();
}

/* ---------------- 5. watermark carries the session stamp and resists removal ---- */

console.log('\n=== WATERMARK TRACEABILITY ===');
{
  const url = serve('wm.html', buildPortal(baseConfig({ u: docUrl })));
  const { ctx, page } = await fresh();
  await page.goto(url);
  await page.waitForFunction(() => {
    const l = document.getElementById('watermarkLayer');
    return l && l.style.backgroundImage.indexOf('data:image/svg') > -1;
  });

  const sid = await page.evaluate(() => window.__sdSession.sid);
  const tile = await page.evaluate(
    () => decodeURIComponent(document.getElementById('watermarkLayer').style.backgroundImage),
  );
  check('watermark carries the session id', tile.includes(sid), sid);
  check('watermark carries the watermark text', tile.includes('CONFIDENTIAL'));

  await page.evaluate(() => document.getElementById('watermarkLayer').remove());
  await page.waitForFunction(() => !!document.getElementById('watermarkLayer'), null, { timeout: 5000 });
  check('watermark is restored after removal', true);

  await page.evaluate(() => { document.getElementById('watermarkLayer').style.display = 'none'; });
  await page.waitForFunction(
    () => document.getElementById('watermarkLayer').style.display !== 'none',
    null, { timeout: 5000 },
  );
  check('watermark is restored after being styled away', true);

  // Phones get a denser tile so a cropped capture still contains a stamp.
  const deskSize = await page.evaluate(() => document.getElementById('watermarkLayer').style.backgroundSize);
  await page.setViewportSize({ width: 390, height: 780 });
  await page.waitForFunction(
    (d) => document.getElementById('watermarkLayer').style.backgroundSize !== d,
    deskSize, { timeout: 5000 },
  );
  check('watermark re-tiles for a phone viewport', true);

  await ctx.close();
}

/* ---------------- 6. an unlocked portal still loads quickly -------------------- */

console.log('\n=== PLAIN PORTAL STILL LOADS ===');
{
  const url = serve('plain.html', buildPortal(baseConfig({
    u: docUrl, f: flags(['copyProtect', 'watermark', 'sessionTimer', 'printBlock', 'frameGuard', 'xorEncrypt']),
  })));
  const { ctx, page } = await fresh();
  const t0 = Date.now();
  await page.goto(url);
  await page.waitForSelector('#loader.hidden', { state: 'attached', timeout: 20000 });
  check('document settles', true, `${Date.now() - t0}ms`);
  const src = await page.getAttribute('#docFrame', 'src');
  check('frame points at the document', !!src && src.includes(DOC_PATH), String(src));
  await ctx.close();
}

/* ---------------- 7. every feature combination still parses ------------------- */

console.log('\n=== FEATURE COMBINATIONS ===');
{
  const payload = await lockUrl(docUrl, PASSWORD);
  const cases = [];
  for (const n of FEATURE_ORDER) {
    cases.push([`only ${n}`, flags([n]), null]);
    cases.push([`all but ${n}`, flags(FEATURE_ORDER.filter((x) => x !== n)), null]);
  }
  cases.push(['all features', flags(FEATURE_ORDER), null]);
  cases.push(['no features', 0, null]);
  cases.push(['locked, all features', flags(FEATURE_ORDER), payload]);
  cases.push(['locked, no features', 0, payload]);

  const { ctx, page } = await fresh();
  page.__quiet = true;   // this section reports its own errors, per case
  for (const [name, f, p] of cases) {
    const errs = [];
    const onErr = (e) => errs.push(e.message);
    page.on('pageerror', onErr);
    const cfg = baseConfig(p ? { p, f } : { u: docUrl, f });
    const url = serve(`combo-${cases.indexOf([name, f, p])}-${f}-${p ? 'l' : 'p'}.html`, buildPortal(cfg));
    await page.goto(url);
    // The script runs to completion only if it parsed; a broken template
    // literal leaves the toolbar wired to nothing.
    const ok = await page.evaluate(() => !!document.getElementById('docFrame') && !!window.__sdSession);
    page.off('pageerror', onErr);
    check(name, ok && errs.length === 0, errs.join(' | ') || (ok ? '' : 'boot script did not run'));
  }
  await ctx.close();
}

await browser.close();
server.close();

console.log(`\n${failures === 0 ? 'ALL PORTAL CHECKS PASSED' : `${failures} CHECK(S) FAILED`}`);
process.exit(failures === 0 ? 0 : 1);
