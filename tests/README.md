# Tests

```bash
npm test          # qr + portal + standalone
```

Everything except the SQL suite runs from `npm test` and needs no account and
no network.

## `portal.test.mjs` — the generated portal

Drives real Chromium through Playwright against portals built from `lib/`.
It covers the three things that are hard to be sure of by reading the code:

- **Password gate.** The document URL is absent from the generated file; the
  gate loads nothing before a password; a wrong one is rejected and still loads
  nothing; the right one decrypts and opens the document.
- **Session persistence.** Reloading resumes the same deadline rather than
  minting a new one; the session id is stable; an already-spent session shows
  the expiry curtain and — checked by counting requests, not by reading the
  `src` attribute — never fetches the document at all; a record claiming a day
  of remaining time is capped at one session.
- **Watermark traceability.** The tile carries the session id, is restored
  after being removed or styled away, and re-tiles denser on a phone viewport.

It then builds all 24 feature combinations (each feature alone, each feature
off, all on, all off, and both locked variants) and asserts each one's inline
script actually ran. That last part is the regression net for the escaping
hazards in the template: a stray backtick or script terminator kills the boot
script silently, and only this check notices.

The embedded document is a local stub. Pointing at a real Google URL would make
the suite depend on network egress and on a document staying shared, and what
is under test is the portal, not Google.

## `standalone.test.mjs` — index.html

The same browser, pointed at the single-file generator: fill the builder, set a
password, generate, then open the resulting share link and unlock it. The
portal template inside `index.html` is generated from `lib/`, so this suite
covers the wiring that is *not* shared — the form, the share link and the
viewer mode that rewrites the page into a portal.

## `rls.test.sql` — Row Level Security

The security of this app rests on one claim: **a portal's config cannot be read
without going through the resolve-portal Edge Function.** If that fails,
revocation, expiry, view limits and passcodes all become advisory.

Run it against a throwaway Postgres (no Supabase account needed):

```bash
export PATH=/usr/lib/postgresql/16/bin:$PATH
initdb -D /tmp/pg -A trust -U postgres
pg_ctl -D /tmp/pg -o "-k /tmp -p 55432" -l /tmp/pg.log start
createdb -h /tmp -p 55432 -U postgres sdtest

# stub the pieces Supabase provides
psql -h /tmp -p 55432 -U postgres -d sdtest <<'SQL'
create schema auth;
create table auth.users (id uuid primary key, email text);
create role anon nologin; create role authenticated nologin;
create role service_role nologin bypassrls;
create function auth.uid() returns uuid language sql stable as
  $f$ select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid $f$;
SQL

for f in supabase/migrations/*.sql; do
  psql -v ON_ERROR_STOP=1 -h /tmp -p 55432 -U postgres -d sdtest -f "$f"
done
psql -h /tmp -p 55432 -U postgres -d sdtest -f tests/rls.test.sql
```

Cases 1, 2, 3, 9, 10 and 13 are expected to raise errors — that is the pass
condition. Case 6 must report `UPDATE 0` (a silent no-op, not a steal).

## `qr.test.mjs` — QR encoder

Checks the encoder module-for-module against the `qrcode` reference for every
version 1-20 and round-trips output through the `jsqr` decoder. Both are
dev-only:

```bash
npm i -D qrcode jsqr && npm run test:qr
```
