/**
 * Browser diagnostic v2 for the E2E dead-hydration failure. NOT part of the
 * suite (Playwright only picks up *.spec.ts).
 *
 * Run against a FRESH dev server (Playwright reuses existing ones):
 *
 *   # stop whatever is on :3000 first, then:
 *   npm run dev &
 *   node e2e/diagnose-hydration.mjs
 *
 * v2 fixes two v1 probe flaws: all listeners now register BEFORE navigation
 * (v1 could miss the post-hydration fetch fired during `load`), and the
 * submit probe distinguishes a native POST fallback (method="post" now makes
 * dead-JS submissions POST back to the page, which answers 405) from a GET
 * with credentials in the query string (the original incident signature).
 *
 * What it measures, per scenario:
 *   - DOMContentLoaded / load / document.readyState progression
 *   - per-script load/error events (a load event fires only after a script
 *     has been DOWNLOADED AND EXECUTED — this separates "blocked" from
 *     "downloaded but never ran")
 *   - securitypolicyviolation events (page-level, catches CSP blocks that
 *     never reach the console)
 *   - window.onerror + unhandledrejection
 *   - inline-script execution probe: self.__next_f is created by the page's
 *     own inline bootstrap scripts (permitted only when CSP inline rules are)
 *   - external-runtime execution probe: globalThis.TURBOPACK is assigned at
 *     the END of the dev runtime chunk — defined means the runtime executed
 *   - hydration probe: /login mounts ResumeSession, whose useEffect fetches
 *     /api/auth/session only after React hydrates
 *   - submit probe with FAKE credentials: POST /api/auth/login (hydrated),
 *     POST /login (dead-JS native POST fallback -> 405), GET-with-query
 *     (dead-JS native GET — the incident), or nothing
 *
 * Scenarios:
 *   A: /login as served.
 *   B: /login with the Content-Security-Policy response header STRIPPED by
 *      interception — if A is dead and B hydrates, the CSP is implicated
 *      despite no visible violation; if both are dead, the CSP is cleared.
 *   C: / (marketing) as a minimal same-server comparison page.
 *
 * Redaction contract: methods, origin+path (queries stripped) and status
 * codes only. Never bodies, cookies, auth headers, tokens or passwords.
 */
import { chromium } from "@playwright/test";

const base = (process.env.E2E_BASE_URL ?? "http://127.0.0.1:3000").replace(/\/+$/, "");

const stripQuery = (u) => {
  try {
    const x = new URL(u);
    return `${x.origin}${x.pathname}`;
  } catch {
    return String(u).split("?")[0];
  }
};

const INIT = `
(() => {
  const rec = (window.__rec = { scriptEvents: [], csp: [], errors: [], rejections: [], dcl: 0, load: 0 });
  document.addEventListener("DOMContentLoaded", () => { rec.dcl = performance.now(); });
  window.addEventListener("load", () => { rec.load = performance.now(); });
  window.addEventListener("error", (e) => rec.errors.push(String(e.message || e).slice(0, 200)));
  window.addEventListener("unhandledrejection", (e) => rec.rejections.push(String(e.reason).slice(0, 200)));
  document.addEventListener("securitypolicyviolation", (e) =>
    rec.csp.push((e.effectiveDirective + " blocked " + (e.blockedURI || "").split("?")[0]).slice(0, 200)));
  const mo = new MutationObserver((muts) => {
    for (const m of muts) for (const n of m.addedNodes) {
      if (n && n.tagName === "SCRIPT") {
        const src = n.src ? new URL(n.src).pathname : "(inline)";
        n.addEventListener("load", () => rec.scriptEvents.push("load " + src));
        n.addEventListener("error", () => rec.scriptEvents.push("ERROR " + src));
      }
    }
  });
  // document.documentElement does not exist yet when an init script runs
  // (the parser has not created <html>); document itself is always a Node.
  mo.observe(document, { childList: true, subtree: true });
})();
`;

async function probePage(browser, path, { stripCsp = false } = {}) {
  const out = {
    scenario: `${stripCsp ? "CSP-STRIPPED " : ""}${path}`,
    pageStatus: 0,
    servedCspPresent: null,
    console: [],
    pageErrors: [],
    failedRequests: [],
    nextResponses: [],
    inlineScriptsExecuted: null,
    runtimeChunkExecuted: null,
    hydrationProbe: "unknown",
    submitProbe: path === "/login" ? "unknown" : "n/a",
    timing: {},
  };

  const context = await browser.newContext();
  const page = await context.newPage();

  if (stripCsp) {
    await page.route("**/*", async (route) => {
      const res = await route.fetch();
      const headers = { ...res.headers() };
      delete headers["content-security-policy"];
      await route.fulfill({ response: res, headers });
    });
  }

  await page.addInitScript(INIT);

  // ALL listeners registered before navigation (v1 raced here).
  let sessionFetchSeen = false;
  let loginApiPostSeen = false;
  let nativePostToLogin = false;
  let navigations = 0;
  page.on("console", (m) => reportable(m) && out.console.push(`${m.type()}: ${m.text().slice(0, 250)}`));
  page.on("pageerror", (e) => out.pageErrors.push(String(e).slice(0, 250)));
  page.on("requestfailed", (r) => out.failedRequests.push(`${r.method()} ${stripQuery(r.url())} -> ${r.failure()?.errorText ?? "failed"}`));
  page.on("request", (r) => {
    const p = stripQuery(r.url());
    if (p === `${base}/api/auth/session`) sessionFetchSeen = true;
    if (p === `${base}/api/auth/login` && r.method() === "POST") loginApiPostSeen = true;
    if (p === `${base}/login` && r.method() === "POST") nativePostToLogin = true;
  });
  page.on("response", (r) => {
    const u = r.url();
    if (u.includes("/_next/") || u.includes("/api/")) {
      out.nextResponses.push(`${r.status()} ${r.request().method()} ${stripQuery(u)}`);
    }
  });
  page.on("framenavigated", (f) => { if (f === page.mainFrame()) navigations++; });

  const t0 = Date.now();
  // If the failure under investigation is real, `load` may never fire —
  // a throwing goto must not destroy the partial evidence already collected.
  let resp = null;
  try {
    resp = await page.goto(`${base}${path}`, { waitUntil: "load" });
  } catch (err) {
    // `load` never fired — the page object is still inspectable afterwards.
    out.gotoError = String(err).split("\n")[0].slice(0, 200);
  }
  out.pageStatus = resp?.status() ?? 0;
  const cspHeader = resp?.headers()["content-security-policy"] ?? null;
  out.servedCspPresent = stripCsp ? "stripped by route interception" : Boolean(cspHeader);
  out.servedCspHasUnsafeEval = stripCsp ? "n/a" : cspHeader?.includes("'unsafe-eval'") ?? false;

  await page.waitForTimeout(6000);

  const state = await page.evaluate(() => ({
    readyState: document.readyState,
    nextF: typeof self.__next_f !== "undefined",
    turbopack: typeof globalThis.TURBOPACK !== "undefined",
    scriptCount: document.scripts.length,
    rec: window.__rec,
  }));
  out.timing = { dclMs: Math.round(state.rec.dcl), loadMs: Math.round(state.rec.load), wallMs: Date.now() - t0 };
  out.inlineScriptsExecuted = state.nextF;
  out.runtimeChunkExecuted = state.turbopack;
  out.scriptTagsInDom = state.scriptCount;
  out.scriptEvents = state.rec.scriptEvents;
  out.cspViolations = state.rec.csp;
  out.windowErrors = state.rec.errors;
  out.unhandledRejections = state.rec.rejections;

  out.hydrationProbe = sessionFetchSeen
    ? "HYDRATED (post-hydration /api/auth/session fetch observed)"
    : "NOT HYDRATED (no post-hydration fetch; client JS is not executing)";

  if (path === "/login") {
    await page.getByLabel("Email").fill("probe@invalid.test");
    await page.getByLabel("Password").fill("probe-not-a-real-password");
    const urlBefore = page.url();
    await page.getByRole("button", { name: "Sign in" }).click();
    await page.waitForTimeout(4000);
    const urlAfter = page.url();
    const gotQueryLeak = urlAfter.includes("password") || urlAfter.includes("probe%40") || urlAfter.includes("email=");
    out.submitProbe = loginApiPostSeen
      ? "REACT HANDLER RAN (POST /api/auth/login)"
      : nativePostToLogin
        ? "NATIVE POST fallback to /login (dead JS; no URL leak — method=post worked)"
        : gotQueryLeak
          ? "NATIVE GET fallback (dead JS; CREDENTIALS IN URL — the incident)"
          : navigations > 1 || urlAfter !== urlBefore
            ? `NAVIGATED without a detectable request (to ${stripQuery(urlAfter)})`
            : "NOTHING (click produced neither request nor navigation)";
  }

  await context.close();
  return out;
}

function reportable(m) {
  return true; // capture every console level this run — silence is evidence too
}

const browser = await chromium.launch();
try {
  const results = [];
  results.push(await probePage(browser, "/login"));
  results.push(await probePage(browser, "/login", { stripCsp: true }));
  results.push(await probePage(browser, "/"));
  console.log(JSON.stringify(results, null, 2));
} finally {
  await browser.close();
}
