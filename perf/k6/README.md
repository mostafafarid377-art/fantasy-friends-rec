# k6 load harness — isolated environments only

`hot-reads.js` applies a modest concurrent **read** load to a disposable
deployment of the app (typically the same disposable environment the E2E
suite uses — see E2E_TESTING.md). It exists to prove the app stays healthy
under concurrent reads after a change, not to make capacity claims.

## Hard rules

- **Never against production.** The script refuses the known production
  origins, and it additionally requires `K6_ALLOW_HOST` to exactly match the
  target `host:port` — you must name the environment twice, on purpose.
- **Reads only.** No scenario creates, updates or deletes rows, and no
  scenario drives `/api/auth/*` — login is rate-limited by design, so
  "load-testing login" would only measure the limiter.
- **No capacity claims.** Thresholds (`app_failures < 1%`, `p95 < 3s`) are
  smoke gates for "is this deployment healthy under a light concurrent
  load", nothing more. Do not extrapolate production headroom from them.

## Run

```bash
# 1. Start the disposable environment (app + disposable Supabase project),
#    e.g. locally on port 3000 with the disposable project's .env.local.

# 2. Install k6: https://grafana.com/docs/k6/latest/set-up/install-k6/

# 3. Public-read load only:
k6 run -e K6_BASE_URL=http://127.0.0.1:3000 -e K6_ALLOW_HOST=127.0.0.1:3000 perf/k6/hot-reads.js

# 4. Optionally include authenticated reads for one TEST account:
#    sign the test account in via the UI, copy the session cookie header
#    value from devtools (Application → Cookies), then:
k6 run -e K6_BASE_URL=http://127.0.0.1:3000 -e K6_ALLOW_HOST=127.0.0.1:3000 \
       -e K6_SESSION_COOKIE='sb-<ref>-auth-token=...' perf/k6/hot-reads.js
```

## Reading results

- `app_failures` counts 5xx and connection failures (the health probes
  intentionally return sanitized 500s when the DB is down; those count as
  coherent, not failures — a *crash* is what this harness catches).
- `app_latency` is reported per scenario; check the per-URL tags to find a
  slow route before blaming the platform.
- For database-level read benchmarks (direct SQL timings of the hot read
  paths), see `docs/perf/2026-11-19-hot-reads.md`.
