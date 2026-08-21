# SecureDoc Portal

Build a protected viewer for a Google Doc — copy blocking, watermarking,
session limits, DevTools detection — and share it as a link or a QR code.

**Frontend:** Next.js static export on GitHub Pages.
**Backend:** Supabase (Postgres + RLS + one Edge Function).

GitHub Pages cannot run server code, so the backend is Supabase rather than
Next.js API routes. [docs/BACKEND.md](docs/BACKEND.md) explains the split and
the security model.

## Layout

```
app/            Next.js App Router — builder, viewer, owner dashboard
lib/            shared logic: portal builder, password lock, QR encoder,
                embed URLs, config codec
supabase/       migrations + the resolve-portal Edge Function
tests/          browser end-to-end suites, SQL policy tests, QR verification
index.html      the dependency-free single-file generator
```

`index.html` still works on its own with no build step and no backend — open
it from disk and it generates a portal. It is copied to `/standalone.html` on
deploy and stays the offline fallback.

Its copy of the portal template is **generated** from `lib/lock.ts` and
`lib/portal.ts` by `scripts/sync-standalone.mjs`, which runs as part of
`prebuild`. Edit `lib/`, then `npm run sync:standalone` — never edit the marked
regions in `index.html` directly.

## Development

```bash
npm install
npm run dev            # http://localhost:3000
npm run build          # static export into out/
npm test               # QR encoder + both browser end-to-end suites
```

`npm test` drives real Chromium through Playwright: the portal's password
gate, session persistence and watermark behaviour, every feature combination,
and the standalone generator's own builder and viewer.

Without Supabase configured the app still runs: it produces self-contained
fragment links, and the short-link features explain that they need a backend.

## Document password

Setting a password encrypts the document URL with AES-256-GCM under a key
derived from it by PBKDF2-HMAC-SHA256 (300,000 rounds, per-portal salt). The
plaintext URL is then dropped from the config, so it is absent from the share
link, the QR code, the generated file and the database row — only the origin
survives, as a preconnect hint. A wrong password fails at the GCM
authentication tag rather than at a comparison, so there is no check in the
page to patch out.

There is no recovery. Losing the password loses the link.

## What the protections actually do

The in-portal measures are deterrents against casual copying, not a guarantee.
Anyone who can read a document on screen can photograph it.

**Screenshots cannot be blocked from a web page.** There is no browser API for
it on any platform, and on iOS and Android the OS captures the screen without
telling the page anything at all. `FLAG_SECURE` — the thing that greys out
screenshots in banking apps — is available only to native Android apps, not to
websites. "Hide When Inactive" blanks the content when the tab is hidden or the
window loses focus, which covers screen sharing and alt-tabbing; it does not
and cannot cover a phone screenshot.

What does work against leaks is traceability. The watermark is stamped with a
per-viewer session id and start time, re-tiled denser on phone screens, and
restored if it is detached or styled away — so a leaked screenshot names the
viewing session that produced it. With the backend on, `portal_views` ties that
session to a time and a hashed IP.

The session timer is likewise stored per viewer, so reloading the page resumes
the countdown instead of granting a fresh one, and the remaining time is capped
at one full session so winding the device clock backwards buys nothing. A
browser that blocks site storage cannot be held to this; the portal says so in
the timer's tooltip rather than pretending otherwise.

What the backend adds is control over the *link* — revoke it, expire it, cap
the number of opens, require a passcode, and see every attempt including the
refused ones.
