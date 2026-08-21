/**
 * Keeps index.html's copy of the portal generator identical to lib/.
 *
 * index.html is the no-build, open-it-from-disk version of this tool, so it
 * cannot import anything — it has to carry the generator inline. That used to
 * mean two hand-maintained copies of the same 600 lines, and two places for a
 * fix to land in only one of. Instead the shared regions are copied out of
 * lib/lock.ts and lib/portal.ts, with their TypeScript removed by Node's own
 * stripper rather than by regexes of ours.
 *
 * Run directly to refresh the checked-in file:  npm run sync:standalone
 * It also runs as part of prebuild, so a stale index.html cannot ship.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { stripTypeScriptTypes } from 'node:module';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const INDENT = 8;

/** Everything from `anchor` to the end of the file. */
function tail(file, anchor) {
  const src = readFileSync(join(root, file), 'utf8');
  const at = src.indexOf(anchor);
  if (at < 0) throw new Error(`sync-standalone: anchor not found in ${file}: ${anchor}`);
  return src.slice(at);
}

function toPlainJs(ts) {
  /*
   * mode 'strip' rather than 'transform': it blanks type syntax in place
   * instead of re-emitting the code, which keeps every comment and — the part
   * that matters here — leaves template literals byte-identical. A re-emitted
   * template could turn this file's `<\\/script>` escapes back into literal
   * terminators and quietly cut the inline script in half.
   */
  const stripped = stripTypeScriptTypes(ts, { mode: 'strip' }).split('\n');
  const source = ts.split('\n');

  // Blanking leaves gaps where the annotations were. Only lines the stripper
  // actually touched are tidied, so nothing inside a template literal — which
  // it never touches — can be reformatted by accident.
  const tidy = stripped.map((line, i) => {
    if (line === source[i]) return line.replace(/\s+$/, '');
    const lead = line.match(/^\s*/)[0];
    return (lead + line.slice(lead.length).replace(/ {2,}/g, ' ')
      .replace(/ +([),;:])/g, '$1')).replace(/\s+$/, '');
  });

  return tidy.join('\n')
    .replace(/^export (?=(async )?function|const|class)/gm, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function indent(code, spaces) {
  const pad = ' '.repeat(spaces);
  return code.split('\n').map((l) => (l ? pad + l : l)).join('\n');
}

const regions = {
  lock: toPlainJs(tail('lib/lock.ts', 'export const LOCK_ITERATIONS')),
  portal: toPlainJs(tail('lib/portal.ts', '/** HTML text/attribute escape. */')),
};

const indexPath = join(root, 'index.html');
let html = readFileSync(indexPath, 'utf8');
let changed = 0;

for (const [name, code] of Object.entries(regions)) {
  const begin = `/* === BEGIN GENERATED ${name} — edit lib/, then: npm run sync:standalone === */`;
  const end = `/* === END GENERATED ${name} === */`;
  const span = new RegExp(
    `^[ \\t]*${begin.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}[\\s\\S]*?^[ \\t]*${end.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`,
    'm',
  );
  if (!span.test(html)) {
    throw new Error(`sync-standalone: markers for "${name}" are missing from index.html`);
  }
  const block = indent([begin, code, end].join('\n'), INDENT);
  const next = html.replace(span, () => block);
  if (next !== html) changed++;
  html = next;
}

// A generated file that does not parse is worse than no generation at all, so
// compile every inline script before the result is written. new Function
// compiles without executing, which is exactly the check wanted here.
const bodies = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((m) => m[1]);
if (!bodies.length) throw new Error('sync-standalone: no inline script found in index.html');
bodies.forEach((body, i) => {
  try {
    // eslint-disable-next-line no-new-func
    new Function(body);
  } catch (err) {
    throw new Error(`sync-standalone: inline script #${i + 1} does not parse — ${err.message}`);
  }
});

writeFileSync(indexPath, html);
console.log(`sync-standalone: index.html refreshed from lib/ (${changed} region(s) changed, ${bodies.length} script(s) parsed)`);
