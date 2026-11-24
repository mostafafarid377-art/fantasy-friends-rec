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
   paste `supabase/migrations/0001…0035` in order in the SQL editor). Both
   rate-limiter migrations are required: `0034_rate_limiting.sql` creates the
   limiter and `0035_rate_limiter_trust_boundary.sql` restricts it to the
   service role; the app deploys only after both are applied.
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
the run well inside the auth rate limits (migrations 0034+0035): a full run makes
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
- **Forms submit natively (credentials visible in the page URL, e.g.
  `/login?email=…&password=…`), buttons do nothing, pages render but never
  hydrate** — client JavaScript is not executing at all. The development CSP
  in `next.config.ts` includes `'unsafe-eval'` precisely because the dev
  bundler and React's development build require it; if you overrode the CSP
  locally or run behind a stripping proxy, restore it. Check the browser
  console for `Content-Security-Policy` eval errors.
- **J02-style flakes on slow machines** — the "no request" probe uses a
  1.5s window; increase the timeout in `auth.spec.ts` if needed.
- **429 responses** — you reran the suite many times within an hour; the
  per-identity budgets reset on fixed windows (5–60 min depending on scope).

## Operator checklist (reproducible run, start to finish)

Use this when executing the suite outside the build sandbox. Nothing here
touches production credentials or data.

1. **Prerequisites**: Node 20+ machine with normal internet access (the
   Playwright CDN must be reachable — it is blocked inside the build
   sandbox, which is why the suite is NOT VERIFIED there).
2. **Disposable project**: create a new free-tier Supabase project (e.g.
   `fantasy-friends-e2e`). Never reuse production.
3. **Migrations**: apply `supabase/migrations/0001_…0035_*.sql` in filename
   order (`supabase link` + `supabase db push`, or paste each file into the
   SQL editor). `0034` must come before `0035` — see
   `DATABASE_MIGRATION_GUIDE.md`.
4. **Auth settings**: leave email confirmations ON (default). Do not
   configure Turnstile for this environment.
5. **App environment** (`.env.local`, disposable project values only):
   `NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_ANON_KEY`,
   `SUPABASE_SERVICE_ROLE_KEY` (server-side routes only).
6. **E2E environment** (shell exports, disposable project values only):
   - `E2E_SUPABASE_URL` — required.
   - `E2E_SUPABASE_SERVICE_ROLE_KEY` — required; read only by Playwright's
     Node process (`e2e/global-setup.ts`), never shipped to the browser.
   - `E2E_BASE_URL` — optional; defaults to `http://127.0.0.1:3000` and the
     dev server is started automatically when unset.
   - `E2E_USER_PASSWORD` — optional; defaults to `E2E-Test-Passw0rd!`.
7. **Test accounts**: created automatically by global setup via the Admin
   API with `email_confirm: true` (the state a real user reaches after
   clicking the confirmation link) — no manual provisioning needed:
   `e2e-leader@fantasyfriends.test`, `e2e-manager@fantasyfriends.test`,
   `e2e-outsider@fantasyfriends.test`. The `.test` domain cannot collide
   with real users.
8. **Run**:
   ```bash
   npx playwright install chromium   # once
   npm run test:e2e                  # 19 journeys, one worker, ~4 logins total
   ```
9. **Expected results** (pass criteria per journey):

   | # | Passes when… |
   |---|---------|
   | J01 | home renders and links reach `/signup` and `/login` |
   | J02 | short password is rejected client-side; zero network requests fired |
   | J03 | valid signup shows the "Check your email" step (no auto sign-in) |
   | J04 | valid credentials land on `/dashboard` with session cookies |
   | J05 | wrong password shows one generic non-enumerating error; stays on `/login` |
   | J06 | unknown email gets the identical forgot-password response as a known one |
   | J07 | Google button initiates OAuth when configured; journey skips cleanly otherwise |
   | J08 | `/reset` without a recovery session reports the link invalid |
   | J09 | dashboard renders league/squad/standings chrome for a signed-in user |
   | J10 | league creation succeeds; league lists with an invitation code |
   | J11 | second account joins via code; both members see a 2-member list |
   | J12 | team + six players registered and listed in the pool |
   | J13 | complete squad (starters, bench GK, captain, vice-captain) saves |
   | J14 | match creation succeeds; fixture lists and opens |
   | J15 | organizer records a goal event on the fixture |
   | J16 | submit → leader approve → league table reflects the team |
   | J17 | the other member gets a match notification; mark-all-read clears it |
   | J18 | profile name edit survives a reload (and is restored afterwards) |
   | J19 | sign-out ends the session; `/dashboard` redirects to `/login` |

   Overall pass = `19 passed` with zero `429` responses (rerun after the
   fixed windows reset if you hit a budget — see "Interpreting failures").
10. **Cleanup** (disposable environment only):
    - Delete the throwaway Supabase project (dashboard → Project Settings →
      General → Delete project), or keep it and truncate test rows; never
      point the suite at production.
    - Remove local session states: `rm -rf e2e/.auth/` (gitignored).
    - Unset the shell exports: `unset E2E_SUPABASE_URL
      E2E_SUPABASE_SERVICE_ROLE_KEY E2E_BASE_URL E2E_USER_PASSWORD`.
    - Remove `.env.local` if it was created solely for the run.
11. **Record evidence**: attach the Playwright HTML report
    (`npx playwright show-report`) or the console summary to the PR before
    merge.

## Known scope limit

Browser binaries are not vendored into this repo; `npx playwright install`
needs network access to the Playwright CDN. In environments where only npm
is reachable, the suite cannot execute — run it from any developer machine
or CI runner with normal browser download access.
