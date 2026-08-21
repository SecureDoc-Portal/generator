// Keeps the dependency-free single-file generator available on the deployed
// site at /standalone.html. It needs no backend and works offline or from
// file://, so it stays the fallback when Supabase is not configured.
import { copyFileSync, existsSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const src = join(root, 'index.html');
const dest = join(root, 'public', 'standalone.html');

if (!existsSync(src)) {
  console.error('copy-standalone: index.html not found at repo root');
  process.exit(1);
}
mkdirSync(dirname(dest), { recursive: true });
copyFileSync(src, dest);
console.log('copy-standalone: index.html -> public/standalone.html');
