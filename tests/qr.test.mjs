/**
 * Verifies lib/qr.ts against a reference encoder and a real decoder.
 *
 *   npm i -D qrcode jsqr
 *   node --experimental-strip-types tests/qr.test.mjs
 *
 * Both libraries are dev-only. The shipped encoder has no dependencies.
 */
import { makeQR } from '../lib/qr.ts';
import QRCode from 'qrcode';
import jsQR from 'jsqr';

let pass = 0, fail = 0;
const check = (name, ok, detail) => {
  if (ok) { pass++; console.log(`  PASS  ${name}`); }
  else { fail++; console.log(`  FAIL  ${name}${detail ? '  -> ' + detail : ''}`); }
};

/** Module matrix -> RGBA bitmap with a quiet zone, for the decoder. */
function rasterise(qr, scale = 4, quiet = 4) {
  const dim = (qr.size + quiet * 2) * scale;
  const data = new Uint8ClampedArray(dim * dim * 4).fill(255);
  for (let y = 0; y < dim; y++) {
    for (let x = 0; x < dim; x++) {
      const mx = Math.floor(x / scale) - quiet;
      const my = Math.floor(y / scale) - quiet;
      if (mx >= 0 && my >= 0 && mx < qr.size && my < qr.size && qr.modules[my][mx]) {
        const i = (y * dim + x) * 4;
        data[i] = data[i + 1] = data[i + 2] = 0;
      }
    }
  }
  return { data, width: dim, height: dim };
}

console.log('=== exact match vs reference encoder, versions 1-20 ===');
for (let v = 1; v <= 20; v++) {
  let text = null;
  for (let len = 1; len <= 900; len++) {
    // lowercase never triggers alphanumeric mode, so both encoders pick byte mode
    const t = 'a'.repeat(len);
    let m;
    try { m = makeQR(t); } catch { break; }
    if (m.version === v) { text = t; break; }
  }
  if (!text) { check(`version ${v}`, false, 'no payload lands on this version'); continue; }
  const mine = makeQR(text);
  const ref = QRCode.create(text, { errorCorrectionLevel: 'M' });
  const n = ref.modules.size;
  let diff = 0;
  if (n !== mine.size) diff = -1;
  else for (let r = 0; r < n; r++) for (let c = 0; c < n; c++)
    if ((ref.modules.data[r * n + c] ? 1 : 0) !== mine.modules[r][c]) diff++;
  check(`v${String(v).padStart(2)} (${text.length}B, ${n}x${n})`, diff === 0,
        diff === -1 ? `size ${mine.size} vs ${n}` : diff ? `${diff} modules differ` : undefined);
}

console.log('\n=== decode round-trip ===');
for (const text of [
  'A', 'HELLO WORLD', 'https://example.com',
  'Q4 "Strategy" & Roadmap — CONFIDENTIAL • VIEW ONLY',
  'émoji ✓ ünïcödé 中文 テスト',
  'x'.repeat(300), 'y'.repeat(500),
]) {
  const qr = makeQR(text);
  const img = rasterise(qr);
  const got = jsQR(img.data, img.width, img.height);
  check(`decode len=${text.length} v${qr.version}`, !!got && got.data === text,
        got ? (got.data === text ? undefined : 'decoded something else') : 'not detected');
}

console.log('\n=== fuzz: 120 random payloads ===');
let ok = 0;
for (let i = 0; i < 120; i++) {
  const len = 1 + Math.floor(Math.random() * 400);
  let s = '';
  for (let j = 0; j < len; j++) s += String.fromCharCode(32 + Math.floor(Math.random() * 94));
  const qr = makeQR(s);
  const img = rasterise(qr);
  const got = jsQR(img.data, img.width, img.height);
  if (got && got.data === s) ok++;
  else console.log(`  FAIL  fuzz len=${len} v${qr.version}`);
}
check(`120 random payloads round-trip`, ok === 120, `${ok}/120`);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
