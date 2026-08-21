// GitHub Pages runs Jekyll by default, which silently ignores any path
// beginning with an underscore — including Next.js's _next/ bundle directory.
// Without this marker the deployed site loads a bare HTML skeleton with no CSS
// or JS, which looks like a broken build rather than a hosting setting.
import { writeFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const out = join(dirname(fileURLToPath(import.meta.url)), '..', 'out');
if (!existsSync(out)) {
  console.error('postbuild: out/ not found — did next build run?');
  process.exit(1);
}
writeFileSync(join(out, '.nojekyll'), '');
console.log('postbuild: wrote out/.nojekyll');
