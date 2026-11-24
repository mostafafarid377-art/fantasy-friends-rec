# E2E Testing — Playwright browser journeys

The `e2e/` suite drives a real browser through the 19 core user journeys
(`npm run test:e2e`). It exists to prove the product works end to end —
auth, leagues, rosters, squads, the match lifecycle, notifications and
profile — with **test accounts only**, against a **disposable environment**.

## Hard safety rules (enforced in code)

- **Never production.** `e2e/env.ts` refuses the known production origins
  (`fantasyfriends.vercel.app`, `fantasy-friends-rec.vercel.app`). Test
  accounts use `.test` addresses that cannot exist as real users, so a
  misconfigured run fails to authenticate instead of touching real data.
- **No weakened auth.** The suite contains no test-only auth path. Users are
  provisioned once through the disposable project's Admin API (already
  email-confirmed — the state a real user reaches after clicking the
  confirmation link), and every journey runs as a real session through the
  app's real login surface.
- **Service key stays in Node.** `E2E_SUPABASE_SERVICE_ROLE_KEY` is read only
  by `e2e/global-setup.ts` (Playwright's Node process), never shipped to the
  browser or stored in the app. Session storage states land in the
  gitignored `e2e/.auth/`.

## One-time setup: the disposable environment

1. **Create a throwaway Supabase project** (dashboard → New project; free
   tier; name it e.g. `fantasy-friends-e2e`). Never reuse the production
   project.
2. **Apply the migrations** to it (`supabase link` + `supabase db push`, or
   paste `supabase/migrations/0001…0034` in order in the SQL editor).
3. **Leave email confirmations ON** (default: Authentication → Sign In /
   Providers → Confirm email). Journey J03 asserts the "Check your email"
   step.
4. **Do not configure Turnstile** for this environment — when no site key is
   set, the app correctly renders no captcha challenge and the E2E journeys
   submit real forms without one. Production keeps Turnstile enforced.
5. **Run the app against the disposable project** — either locally:

   ```bash
   # .env.local — values of the DISPOSABLE project only
   NEXT_PUBLIC_SUPABASE_URL=https://<disposable-ref>.supabase.co
   NEXT_PUBLIC_SUPABASE_ANON_KEY=<disposable anon key>
   SUPABASE_SERVICE_ROLE_KEY=<disposable service role key>   # server-side routes only
   ```

   …or as a separate preview deployment wired to the disposable project.

6. **Export the E2E env** (same disposable project):

   ```bash
   export E2E_SUPABASE_URL=https://<disposable-ref>.supabase.co
   export E2E_SUPABASE_SERVICE_ROLE_KEY=<disposable service role key>
   # Optional:
   # export E2E_BASE_URL=http://127.0.0.1:3000   # default; set to run against a deployed preview
   # export E2E_USER_PASSWORD='...'               # default E2E-Test-Passw0rd!
   ```

## Running

```bash
npx playwright install chromium   # once, downloads the browser
npm run test:e2e                  # starts `npm run dev` automatically when E2E_BASE_URL is unset
```

Global setup provisions three users (`e2e-leader@`, `e2e-manager@`,
`e2e-outsider@fantasyfriends.test`), signs the first two in once, and stores
their sessions in `e2e/.auth/`. Journeys reuse those sessions, which keeps
the run well inside the auth rate limits (migration 0034): a full run makes
~4 login requests total instead of ~15.

## The 19 journeys

| # | Journey | Spec |
|---|---------|------|
| J01 | Marketing home renders, links to sign up / sign in | `auth.spec.ts` |
| J02 | Signup client-side validation blocks a short password (no request) | `auth.spec.ts` |
| J03 | Signup shows the email-confirmation step | `auth.spec.ts` |
| J04 | Sign in with valid credentials lands on the dashboard | `auth.spec.ts` |
| J05 | Wrong password → one non-enumerating error, stays on `/login` | `auth.spec.ts` |
| J06 | Forgot password answers unknown emails identically | `auth.spec.ts` |
| J07 | Google sign-in button starts OAuth when configured (skips cleanly otherwise) | `auth.spec.ts` |
| J08 | Reset without a recovery session reports the link invalid | `auth.spec.ts` |
| J09 | Dashboard loads with league/squad/standings chrome | `league.spec.ts` |
| J10 | Leader creates a league; it lists with an invitation code | `league.spec.ts` |
| J11 | Second account joins by code; both see two members | `league.spec.ts` |
| J12 | Leader registers a team and six players in the pool | `squad.spec.ts` |
| J13 | Member picks a complete squad (starters, bench GK, captain, vice) and saves | `squad.spec.ts` |
| J14 | Leader creates a match; it lists and opens | `match.spec.ts` |
| J15 | Organizer records a goal event | `match.spec.ts` |
| J16 | Result submitted → leader approves → table shows the team | `match.spec.ts` |
| J17 | Match creation notifies the other member; mark-all-read clears it | `account.spec.ts` |
| J18 | Profile edit persists across reload (name restored afterwards) | `account.spec.ts` |
| J19 | Sign out ends the session; `/dashboard` redirects to `/login` | `auth.spec.ts` |

Journeys are ordered and share one worker (`workers: 1`) because several
build on state created by earlier journeys in the same file — that is the
point of a journey suite. Each file creates its own uniquely named league,
so files are independent and reruns never collide.

## Interpreting failures

- **Setup: "did not serve /login"** — the app server isn't running against
  the disposable project, or `E2E_BASE_URL` points elsewhere.
- **Setup: "login failed"** — the app is not pointed at the disposable
  Supabase project (the seeded users don't exist there). Check `.env.local`.
- **J02-style flakes on slow machines** — the "no request" probe uses a
  1.5s window; increase the timeout in `auth.spec.ts` if needed.
- **429 responses** — you reran the suite many times within an hour; the
  per-identity budgets reset on fixed windows (5–60 min depending on scope).

## Known scope limit

Browser binaries are not vendored into this repo; `npx playwright install`
needs network access to the Playwright CDN. In environments where only npm
is reachable, the suite cannot execute — run it from any developer machine
or CI runner with normal browser download access.
