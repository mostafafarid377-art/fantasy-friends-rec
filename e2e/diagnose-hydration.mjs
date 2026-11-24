/**
 * One-off browser diagnostic for the E2E environment. NOT part of the suite
 * (Playwright only picks up *.spec.ts). Run it against a FRESH dev server:
 *
 *   # stop anything already on :3000 first — Playwright reuses existing
 *   # servers, and a stale one serves stale config:
 *   #   lsof -ti:3000 | xargs kill    (or your platform's equivalent)
 *   npm run dev &                     # fresh server, current code
 *   node e2e/diagnose-hydration.mjs   # prints a redacted JSON report
 *
 * Captures exactly the evidence needed to diagnose dead-JS / hydration
 * failures: console errors, pageerrors, failed requests, /_next and /api
 * response statuses, the served CSP header, a hydration probe, and a
 * fake-credentials submit probe (POST fetch vs native GET navigation).
 *
 * Redaction contract: only methods, origin+path (query strings stripped) and
 * status codes are reported. Never bodies, cookies, headers, tokens or
 * passwords. The optional login probe uses the E2E test account and reports
 * ONLY the HTTP status code.
 */
import { chromium, request } from "@playwright/test";

const base = (process.env.E2E_BASE_URL ?? "http://127.0.0.1:3000").replace(/\/+$/, "");

const stripQuery = (u) => {
  try {
    const x = new URL(u);
    return `${x.origin}${x.pathname}`;
  } catch {
    return String(u).split("?")[0];
  }
};

const report = {
  base,
  servedCsp: null,
  pageStatus: 0,
  console: [],
  pageErrors: [],
  failedRequests: [],
  responses: [],
  hydrationProbe: "unknown",
  submitProbe: "unknown",
  loginApiStatus: "skipped (no E2E creds in env)",
};

const browser = await chromium.launch();
try {
  const page = await browser.newPage();

  page.on("console", (m) => {
    if (m.type() === "error" || m.type() === "warning") {
      report.console.push(`${m.type()}: ${m.text().slice(0, 300)}`);
    }
  });
  page.on("pageerror", (e) => report.pageErrors.push(String(e).slice(0, 300)));
  page.on("requestfailed", (r) =>
    report.failedRequests.push(`${r.method()} ${stripQuery(r.url())} -> ${r.failure()?.errorText ?? "failed"}`),
  );
  page.on("response", (r) => {
    const u = r.url();
    if (u.includes("/_next/") || u.includes("/api/") || u.includes(".supabase.")) {
      report.responses.push(`${r.status()} ${r.request().method()} ${stripQuery(u)}`);
    }
  });

  // Hydration probe: ResumeSession fetches /api/auth/session ONLY after
  // hydration, from a useEffect. If it fires, React is alive.
  let sessionFetchSeen = false;
  page.on("request", (r) => {
    if (stripQuery(r.url()) === `${base}/api/auth/session`) sessionFetchSeen = true;
  });

  const resp = await page.goto(`${base}/login`, { waitUntil: "load" });
  report.pageStatus = resp?.status() ?? 0;
  report.servedCsp = resp?.headers()["content-security-policy"] ?? null;

  await page.waitForTimeout(6000);
  report.hydrationProbe = sessionFetchSeen
    ? "HYDRATED (post-hydration /api/auth/session fetch observed)"
    : "NOT HYDRATED (no post-hydration fetch; client JS is not executing)";

  // Submit probe with FAKE credentials: hydrated React prevents the native
  // navigation and POSTs /api/auth/login; dead JS performs a native GET and
  // the field values land in the URL (the incident signature).
  let loginPostSeen = false;
  page.on("request", (r) => {
    if (stripQuery(r.url()) === `${base}/api/auth/login` && r.method() === "POST") loginPostSeen = true;
  });
  await page.getByLabel("Email").fill("probe@invalid.test");
  await page.getByLabel("Password").fill("probe-not-a-real-password");
  await page.getByRole("button", { name: "Sign in" }).click();
  await page.waitForTimeout(4000);

  const urlAfter = page.url();
  const leakedIntoUrl = urlAfter.includes("?") || urlAfter.includes("password") || urlAfter.includes("probe%40");
  report.submitProbe = loginPostSeen
    ? "OK (React handler intercepted submit; POST /api/auth/login fired)"
    : leakedIntoUrl
      ? "NATIVE GET SUBMISSION (values serialized into the URL — client JS dead)"
      : "NO REQUEST AT ALL (submit produced neither a POST fetch nor a navigation)";

  // Optional account probe: does the E2E login API accept the test account?
  // Reports ONLY the status code (200 = exists+confirmed+password matches,
  // 401 = wrong credentials / unconfirmed / missing, 429 = rate limited).
  const email = process.env.E2E_PROBE_EMAIL;
  const password = process.env.E2E_USER_PASSWORD;
  if (email && password) {
    const ctx = await request.newContext({ baseURL: base });
    const res = await ctx.post("/api/auth/login", { data: { email, password } });
    report.loginApiStatus = res.status();
    await ctx.dispose();
  }
} finally {
  await browser.close();
}

console.log(JSON.stringify(report, null, 2));
