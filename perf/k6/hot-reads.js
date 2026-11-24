// k6 hot-reads load harness — isolated/disposable environments ONLY.
//
//   k6 run -e K6_BASE_URL=http://127.0.0.1:3000 -e K6_ALLOW_HOST=127.0.0.1:3000 perf/k6/hot-reads.js
//
// Hard guards (mirroring the E2E suite):
//   * refuses the known production origins outright;
//   * requires K6_ALLOW_HOST to exactly match the target host:port, so the
//     operator must consciously name the environment being loaded.
//
// What it loads: public, side-effect-free reads — /login and the two health
// probes — plus, when K6_SESSION_COOKIE is provided, authenticated reads of
// /api/me and /api/leagues for ONE test account. It never creates, updates
// or deletes data, and it never drives /api/auth/* (login is rate-limited
// by design; loading it would just measure the limiter).
//
// Thresholds are smoke-quality gates (error rate, tail latency), NOT
// capacity claims: this harness proves the environment stays healthy under
// a modest concurrent read load. It cannot tell you how much traffic the
// production plan can absorb — no number from this script is a capacity
// guarantee for production.

import http from "k6/http";
import { check, sleep } from "k6";
import { Rate, Trend } from "k6/metrics";

const BASE_URL = (__ENV.K6_BASE_URL ?? "").replace(/\/+$/, "");
const ALLOW_HOST = __ENV.K6_ALLOW_HOST ?? "";
const FORBIDDEN = ["fantasyfriends.vercel.app", "fantasy-friends-rec.vercel.app"];

if (!BASE_URL) throw new Error("K6_BASE_URL is required.");
const target = new URL(BASE_URL);
if (FORBIDDEN.some((h) => target.host === h || target.host.endsWith("." + h))) {
  throw new Error(`Refusing to load-test a production origin (${target.host}).`);
}
if (!ALLOW_HOST || ALLOW_HOST !== target.host) {
  throw new Error(
    `Set K6_ALLOW_HOST exactly to the target host:port (${target.host}) to confirm this is a disposable environment.`,
  );
}

const failures = new Rate("app_failures");
const latency = new Trend("app_latency", true);

export const options = {
  scenarios: {
    public_reads: {
      executor: "constant-vus",
      vus: 10,
      duration: "30s",
      exec: "publicReads",
    },
    authenticated_reads: {
      executor: "constant-vus",
      vus: 5,
      duration: "30s",
      exec: "authReads",
      startTime: "35s",
      env: { ENABLED: __ENV.K6_SESSION_COOKIE ? "1" : "" },
    },
  },
  thresholds: {
    app_failures: ["rate<0.01"],
    app_latency: ["p(95)<3000"], // generous smoke gate, not a capacity claim
  },
};

function hit(url, params) {
  const res = http.get(url, { ...params, tags: { url } });
  failures.add(res.status >= 500 || res.status === 0);
  latency.add(res.timings.duration);
  return res;
}

export function publicReads() {
  check(hit(`${BASE_URL}/login`), { "login 200": (r) => r.status === 200 });
  // Health probes are boolean by design; a failing dependency must answer a
  // SANITIZED 500 — both are acceptable here, a crash (0) is not.
  check(hit(`${BASE_URL}/api/health`), { "health coherent": (r) => r.status === 200 || r.status === 500 });
  check(hit(`${BASE_URL}/api/supabase/health`), { "supabase health coherent": (r) => r.status === 200 || r.status === 500 });
  sleep(0.5);
}

export function authReads() {
  if (!__ENV.ENABLED) return;
  const params = { headers: { Cookie: __ENV.K6_SESSION_COOKIE } };
  check(hit(`${BASE_URL}/api/me`, params), { "me 200": (r) => r.status === 200 });
  check(hit(`${BASE_URL}/api/leagues`, params), { "leagues 200": (r) => r.status === 200 });
  sleep(1);
}

// To enable authenticated_reads: sign a TEST account in through the app's
// login page in a browser, copy the session cookie(s) from devtools, and
// pass them as K6_SESSION_COOKIE. One session, one test account — the
// login endpoint itself is never loaded.
