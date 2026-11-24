# Observability & Alerts — Fantasy Friends

This app runs on Vercel (compute) + Supabase (auth, database, storage) +
Cloudflare Turnstile (bot protection) + GitHub Actions (lineup-deadline
runner). There is no separate paid monitoring stack; this runbook wires up
the signals that already exist, adds explicit thresholds, and says what to
do first when each one fires.

Status page / probe: `node scripts/ops-smoke.mjs https://fantasyfriends.vercel.app`
(read-only; safe against production; exits 1 when anything is down or a
health response leaks detail).

---

## 1. Signal inventory

| Signal | Where | What normal looks like |
|---|---|---|
| HTTP 5xx / function errors | Vercel → Project → Logs & Observability | Isolated, single-digit per day |
| Function latency (p95) | Vercel → Observability → Speed Insights / Functions | API routes < ~1.5s p95 |
| App server logs | Vercel → Logs, filters below | No sustained `[api]`/`[rate-limit]`/`[health:supabase]` spam |
| Auth errors & rate limits | Supabase → Logs → Auth | Occasional invalid logins; no blocks of legit users |
| Postgres health | Supabase → Reports → Database | CPU < ~70%, connections well under limit, disk growing slowly |
| PostgREST/API errors | Supabase → Logs → API | No 5xx clusters |
| Auth email delivery | Supabase → Auth → Logs + SMTP provider dashboard | Bounces ≈ 0 |
| Turnstile solve rate | Cloudflare → Turnstile → site metrics | Solve rate stable; challenge spikes correlate with attacks |
| Lineup deadline runner | GitHub → Actions → `lineup-deadlines` workflow | Green daily runs |
| Health probes | `scripts/ops-smoke.mjs` or any uptime checker | `{ok:true}` on both probes |

### Server log tags (Vercel → Logs → filter)

- `[api]` — an unexpected route failure reached the sanitized 500 path.
  The client only saw "Unexpected error"; the full detail is in this line.
- `[health:supabase]` — the database probe failed; the detail is here.
- `[rate-limit]` — the limiter itself failed open (request was allowed).
  Occasional lines = transient; sustained lines = migration/RPC problem.
  While the limiter is down, throttling protections are unavailable (the
  per-category exposure list and residual protections are documented in
  `src/lib/server/rate-limit.ts`); if an attack coincides with a limiter
  outage, tighten limits temporarily at the platform (Vercel WAF) layer.
- `[recovery]` — a client-side pending-operation recovery hiccup.

## 2. Alerts to enable (exact steps)

### Vercel
1. Project → Settings → Notifications: enable **Deployment failed** and
   **Function errors spike** notifications to the team email/channel.
2. Project → Observability → create an alert (where your plan allows) or a
   saved log query: `5xx` responses on `/api/*` — page-worthy if >10 in 5 min.
3. Add a log drain only if you already operate one; otherwise Vercel's
   retained logs + saved queries are sufficient at this scale.

### Supabase
1. Project → Settings → Alerts (or Integrations → Webhooks on plans without
   alerts): enable **database CPU**, **disk/io budget**, and **connection
   pool** warnings.
2. Auth → Logs: watch for `rate_limit` and `email send failure` entries;
   sustained entries mean Turnstile/SMTP misconfiguration or an attack.
3. Database → Roles/Connections: alert habit — weekly check that
   connections stay < 60% of the pool limit.

### Cloudflare Turnstile
1. Turnstile → your site → Settings: enable email notifications for
   anomalous challenge activity.
2. A sudden solve-rate drop after a deploy usually means the CSP or the
   site key regressed — check `next.config.ts` and the Vercel env first.

### GitHub Actions (lineup-deadline runner)
1. Repo → Settings → Notifications: enable **Actions workflow failure**
   emails for your account, and watch the `lineup-deadlines` workflow.
2. On failure: open the run log — the runner calls
   `/api/internal/lineup-deadlines` with the cron secret; a 401 means the
   secret drifted, a 500 means the deadline RPC needs investigation.
3. Manual catch-up is safe: the runner is idempotent per deadline window;
   re-run the failed workflow from the Actions tab.

### External uptime (free tiers are enough)
Point any uptime checker at
`https://fantasyfriends.vercel.app/api/supabase/health` every 1–5 minutes,
alerting when the body is not exactly `{"ok":true}`. Both probe endpoints
are deliberately boolean, so a body match is a complete check — no parsing.

## 3. First-response playbooks

**Site down / health probe failing**
1. `node scripts/ops-smoke.mjs https://fantasyfriends.vercel.app`
2. `/login` 200 but probes 500 → database/auth issue: Supabase dashboard →
   Reports + Logs; check for paused project (free-tier inactivity) first.
3. Everything 500s → Vercel deployment issue: roll back to the last green
   deployment from Vercel → Deployments (instant, no data impact).

**Users report login failures**
1. Supabase → Auth logs: look for rate-limit or email errors.
2. Turnstile metrics: a challenge outage blocks sign-in forms (button stays
   disabled) — the CSP must keep `challenges.cloudflare.com` allowed.
3. Our limiter returns 429 + `Retry-After` by design on bursts; legit users
   wait out the window (≤ 60 min worst case, 5 min for login).

**Suspected abuse / scraping**
1. Vercel logs filtered by route; the limiter emits no per-deny logs by
   design (denials are cheap and expected).
2. Supabase → Database → query `ff_rate_limit_windows` (admin SQL) to see
   which scopes/identities are hot; window rows self-prune after 7 days.

**Deadline runner missed a day**
Lineups lock per-match at kickoff via the database regardless of the
runner; the runner only advances prepared lineups. Re-run the workflow;
nothing needs backfilling by hand.

## 4. Weekly 10-minute ops check

1. `ops-smoke.mjs` green.
2. Supabase → Reports: disk and CPU trend flat.
3. Vercel → Logs: no new `[api]` pattern repeating.
4. Actions: last 7 `lineup-deadlines` runs green.
5. Auth logs: email delivery clean.
