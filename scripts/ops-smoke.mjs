#!/usr/bin/env node
/**
 * Read-only operations smoke probe.
 *
 *   node scripts/ops-smoke.mjs https://fantasyfriends.vercel.app
 *
 * Safe to run against ANY environment, including production: it only issues
 * GET requests to public, side-effect-free endpoints and validates that
 *  1. /login renders (200),
 *  2. /api/health and /api/supabase/health agree with their status codes,
 *  3. failure responses stay sanitized (boolean body, no error text leak).
 *
 * Exit code 0 = all checks pass, 1 = at least one failed. Intended for
 * uptime probes, post-deploy checks and on-call first response.
 */
const base = (process.argv[2] ?? process.env.BASE_URL ?? "http://127.0.0.1:3000").replace(/\/+$/, "");

let failures = 0;
const report = (ok, name, detail) => {
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failures += 1;
};

async function probe(path, { expectKeys = null, sanitize = false } = {}) {
  const started = performance.now();
  let res, text;
  try {
    res = await fetch(`${base}${path}`, { redirect: "manual", signal: AbortSignal.timeout(15_000) });
    text = await res.text();
  } catch (error) {
    report(false, `GET ${path}`, `unreachable: ${error instanceof Error ? error.message : error}`);
    return null;
  }
  const ms = Math.round(performance.now() - started);
  let json = null;
  try { json = JSON.parse(text); } catch { /* not JSON */ }

  if (sanitize) {
    // The body must be exactly {"ok":boolean} — never an error message,
    // SQLSTATE, stack frame or host detail (regression guard for workstream A).
    const keys = json && typeof json === "object" ? Object.keys(json).sort() : [];
    const exact = json && keys.length === 1 && keys[0] === "ok" && typeof json.ok === "boolean";
    report(Boolean(exact), `GET ${path} body sanitized`, `${res.status} in ${ms}ms, body keys: [${keys}]`);
    const statusAgrees = json && ((json.ok && res.status === 200) || (!json.ok && res.status >= 500));
    report(Boolean(statusAgrees), `GET ${path} status agrees with body`, `${res.status}`);
    const leaked = /sql|state|stack|error|message|postgres|supabase\.co|timeout|econn/i.test(text.replace(/"ok"/, ""));
    report(!leaked, `GET ${path} carries no diagnostic text`, undefined);
  } else {
    report(res.status === 200, `GET ${path}`, `${res.status} in ${ms}ms`);
    if (expectKeys && json) {
      const missing = expectKeys.filter((k) => !(k in json));
      report(missing.length === 0, `GET ${path} shape`, missing.length ? `missing ${missing}` : `keys: [${expectKeys}]`);
    }
  }
  return { res, json, ms };
}

console.log(`Ops smoke probe → ${base}\n`);
await probe("/login");
await probe("/api/health", { expectKeys: ["ok"], sanitize: true });
const supa = await probe("/api/supabase/health", { sanitize: true });

// A healthy deployment answers ok:true on both probes; an unhealthy one must
// still answer sanitized. Both outcomes are validated above — here we surface
// the live state for the operator.
if (supa?.json) {
  console.log(`\nSupabase connectivity: ${supa.json.ok ? "UP" : "DOWN (sanitized 500 — check server logs for [health:supabase])"}`);
  if (!supa.json.ok) failures += 1;
}
process.exit(failures ? 1 : 0);
