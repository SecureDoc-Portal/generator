# Backend

## Why the backend is not Next.js

GitHub Pages is a **static file host**. It cannot run Next.js API routes,
server components, SSR, middleware or any Node process. `output: 'export'`
produces plain HTML/JS, and API routes are a build error in that mode.

So this repo splits the two halves:

| Half | Runs on | What it is |
|---|---|---|
| Frontend | GitHub Pages | Next.js App Router, static export (`out/`) |
| Backend | Supabase | Postgres + Row Level Security, plus one Edge Function |

If you would rather have real Next.js API routes, the only change needed is
the host — deploy to Vercel instead of Pages and the same Supabase project
keeps working.

## The one rule that makes the controls real

**A portal's config is not readable with the anon key.** There is deliberately
no `SELECT` policy on `public.portals` for `anon`. Every read goes through the
`resolve-portal` Edge Function, which holds the service-role key.

That is what makes revocation, expiry, view limits and passcodes *enforced*
rather than advisory. If the browser could `SELECT` the config directly, a
viewer could simply skip the checks and read the document URL.

The trade-off, stated plainly: the protections inside the generated portal
(copy blocking, screenshot blanking, DevTools detection) are still client-side
deterrents and always will be — anyone who can see a document can photograph
their screen. What the backend adds is control over *the link*: you can turn
it off, time-limit it, cap it, and see who opened it.

## Schema

- `portals` — id, owner, config JSON, passcode hash, expiry, view cap, revoked flag
- `portal_views` — one row per attempt, including refusals; no insert policy, so
  only the Edge Function can write it and a viewer cannot forge or suppress entries
- `portal_summary` — a `security_invoker` view for the dashboard that never exposes `config`

Functions:
- `increment_portal_view(id)` — atomic, so two simultaneous opens cannot share one allowance
- `set_portal_passcode(id, plaintext)` — owner-only, hashes with pgcrypto bcrypt
- `verify_portal_passcode(id, plaintext)` — service_role only, returns a bare boolean

## Setup

```bash
# 1. Create or pick a project, then link it
npx supabase link --project-ref <your-ref>

# 2. Apply the schema
npx supabase db push

# 3. Deploy the Edge Function.
#    --no-verify-jwt because viewers are anonymous; the function does its own
#    authorisation against the portal row.
npx supabase functions deploy resolve-portal --no-verify-jwt

# 4. Salt for hashing viewer IPs in the audit log
npx supabase secrets set VIEW_LOG_IP_SALT="$(openssl rand -hex 32)"
```

### Getting the keys into the build

`next build` reads `.env`, `.env.local` and `.env.production` — **not**
`.env.example`, which is documentation only. Putting values in `.env.example`
is a silent no-op: the build succeeds and the app still reports that no
backend is configured.

This repo commits the public values in **`.env.production`**. That is safe
because the publishable key grants only what Row Level Security allows, and
every table in the project has RLS enabled.

To point a fork at a different project without editing the file, set these as
**repository variables** (Settings → Secrets and variables → Actions →
Variables) — the workflow passes them as env vars, which override the file:

- `NEXT_PUBLIC_SUPABASE_URL`
- `NEXT_PUBLIC_SUPABASE_ANON_KEY`

Both are public by design — they ship in the browser bundle and grant only
what RLS allows. The **service-role key is never** a repository variable; it
lives only in Supabase's own Edge Function environment.

Finally, in Supabase Auth settings add your Pages origin to the allowed
redirect URLs, or magic-link sign-in will bounce.

## Testing without an account

The schema and its policies can be verified against a throwaway Postgres — no
Supabase project required. See `tests/README.md`. The suite asserts, among
other things, that anon cannot read portals, that one owner cannot see or
steal another's rows, and that audit rows cannot be forged.

## Link types

| Type | Backend needed | Revocable | Notes |
|---|---|---|---|
| Short `/v/?id=…` | yes | yes | expiry, view cap, passcode, audit log |
| Fragment `/v/#d=…` | no | **no** | config rides in the URL; never sent to a server |
| Hosted file | no | no | you host the generated HTML yourself |

The fragment link is the fallback when Supabase is not configured, so the app
never hard-fails on a missing backend.
