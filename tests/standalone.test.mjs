/**
 * End-to-end checks for index.html — the no-build, single-file generator that
 * ships as /standalone.html.
 *
 *   npm run test:standalone
 *
 * The portal template inside it is generated from lib/ by
 * scripts/sync-standalone.mjs, so what is under test here is the wiring that
 * is *not* shared: the builder form, the share link, and the viewer mode that
 * rewrites this page into a portal.
 */
import { createServer } from 'node:http';
import { readFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const DOC_PATH = '/stub-document-4b7e10';
const PASSWORD = 'a well chosen password';

let failures = 0;
function check(name, cond, detail = '') {
  if (cond) { console.log(`  PASS  ${name}`); return; }
  failures++;
  console.log(`  FAIL  ${name}${detail ? `  -> ${detail}` : ''}`);
}

const server = createServer((req, res) => {
  const path = req.url.split(/[?#]/)[0];
  if (path === DOC_PATH) {
    res.writeHead(200, { 'content-type': 'text/html' });
    res.end('<!doctype html><title>Stub</title><h1>Stub document body</h1>');
    return;
  }
  if (path === '/' || path === '/index.html') {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    res.end(readFileSync(join(root, 'index.html')));
    return;
  }
  res.writeHead(404).end('no');
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const origin = `http://127.0.0.1:${server.address().port}`;
const docUrl = origin + DOC_PATH;

const CHROME = process.env.CHROMIUM_PATH
  || (existsSync('/opt/pw-browsers/chromium-1194/chrome-linux/chrome')
      ? '/opt/pw-browsers/chromium-1194/chrome-linux/chrome'
      : undefined);
const browser = await chromium.launch(CHROME ? { executablePath: CHROME } : {});

async function fresh() {
  const ctx = await browser.newContext();
  const page = await ctx.newPage();
  page.on('pageerror', (e) => {
    failures++;
    console.log(`  FAIL  uncaught page error -> ${e.message}`);
  });
  return { ctx, page };
}

async function fillBuilder(page, { password } = {}) {
  await page.goto(`${origin}/index.html`);
  await page.fill('#docUrl', docUrl);
  await page.fill('#docTitle', 'Standalone Check');
  await page.fill('#docOwner', 'A. Wijesingha');
  if (password) {
    await page.fill('#docPassword', password);
    await page.fill('#docPassword2', password);
  }
  await page.waitForSelector('#generateBtn:not([disabled])');
  await page.click('#generateBtn');
  await page.waitForSelector('#outputPanel.show', { timeout: 30000 });
  return page.inputValue('#shareLink');
}

/* ---------------- 1. builder still works, and locks when asked -------------- */

console.log('\n=== STANDALONE BUILDER ===');
{
  const { ctx, page } = await fresh();

  const plainLink = await fillBuilder(page);
  check('generates without a password', !!plainLink && plainLink.includes('#d='));
  check('QR code rendered', (await page.innerHTML('#qrBox')).includes('<svg'));

  const lockedLink = await fillBuilder(page, { password: PASSWORD });
  check('generates with a password', !!lockedLink && lockedLink.includes('#d='));

  const code = await page.textContent('#codeOutput');
  check('locked output contains no document URL', !code.includes(DOC_PATH));
  check('locked share link contains no document URL',
    !decodeURIComponent(lockedLink).includes(DOC_PATH));

  // The fragment is the config; decoding it must show the URL really is gone.
  const decoded = await page.evaluate((link) => {
    let b = link.split('#d=')[1].replace(/-/g, '+').replace(/_/g, '/');
    while (b.length % 4) b += '=';
    return atob(b);
  }, lockedLink);
  check('encoded config carries ciphertext, not a URL',
    !decoded.includes(DOC_PATH) && decoded.includes('"p":'), decoded.slice(0, 120));

  await ctx.close();

  /* ------------- 2. the locked share link opens as a gated portal ---------- */

  console.log('\n=== STANDALONE VIEWER: LOCKED LINK ===');
  {
    const { ctx: c2, page: p2 } = await fresh();
    await p2.goto(lockedLink);
    await p2.waitForSelector('#lockGate.active', { timeout: 20000 });
    check('viewer mode raises the password gate', true);
    check('nothing is loaded before the password',
      !(await p2.getAttribute('#docFrame', 'src')));

    await p2.fill('#lockInput', 'wrong one');
    await p2.click('#lockBtn');
    await p2.waitForFunction(
      () => document.getElementById('lockMsg').textContent.indexOf('not correct') > -1,
      null, { timeout: 30000 },
    );
    check('wrong password is rejected', true);

    await p2.waitForSelector('#lockBtn:not([disabled])');
    await p2.fill('#lockInput', PASSWORD);
    await p2.click('#lockBtn');
    await p2.waitForFunction(
      (d) => (document.getElementById('docFrame').getAttribute('src') || '').indexOf(d) > -1,
      DOC_PATH, { timeout: 30000 },
    );
    check('right password opens the document', true);
    await c2.close();
  }

  /* ------------- 3. the session survives a reload of a share link ---------- */

  console.log('\n=== STANDALONE VIEWER: SESSION PERSISTENCE ===');
  {
    const { ctx: c3, page: p3 } = await fresh();
    await p3.goto(plainLink);
    await p3.waitForFunction(() => !!window.__sdSession, null, { timeout: 20000 });
    const first = await p3.evaluate(() => window.__sdSession.deadline);
    await p3.waitForTimeout(2500);
    await p3.reload();
    await p3.waitForFunction(() => !!window.__sdSession, null, { timeout: 20000 });
    const second = await p3.evaluate(() => window.__sdSession.deadline);
    check('reload resumes the same countdown', Math.abs(second - first) < 50,
      `${first} -> ${second}`);

    const tile = await p3.evaluate(() => {
      const l = document.getElementById('watermarkLayer');
      return l ? decodeURIComponent(l.style.backgroundImage) : '';
    });
    const sid = await p3.evaluate(() => window.__sdSession.sid);
    check('watermark carries the session stamp', tile.includes(sid), sid);
    await c3.close();
  }
}

await browser.close();
server.close();

console.log(`\n${failures === 0 ? 'ALL STANDALONE CHECKS PASSED' : `${failures} CHECK(S) FAILED`}`);
process.exit(failures === 0 ? 0 : 1);
