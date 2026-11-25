import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  DISPOSABLE_PROJECT_REF,
  PRODUCTION_PROJECT_REF,
  supabaseAdminEnv,
} from "../../../e2e/env";

/**
 * Regression coverage for the CI failure "E2E_SUPABASE_URL does not look
 * like a Supabase project URL" (run 45537535083): the configured value was
 * the project's REST endpoint `https://<ref>.supabase.co/rest/v1/` — a
 * formatting variant that unambiguously names the disposable project — and
 * the old anchored-regex validation rejected it, while its error message
 * echoed the raw value into CI logs. The loader now normalizes such
 * variants to the bare origin, still accepts ONLY the disposable project's
 * host over HTTPS, still refuses production explicitly, and never echoes
 * the configured value in error text.
 */

const CANON = `https://${DISPOSABLE_PROJECT_REF}.supabase.co`;
const DUMMY_KEY = "test-service-role-key-not-a-secret";

describe("e2e supabaseAdminEnv URL validation", () => {
  const saved = { url: process.env.E2E_SUPABASE_URL, key: process.env.E2E_SUPABASE_SERVICE_ROLE_KEY };
  beforeEach(() => {
    delete process.env.E2E_SUPABASE_URL;
    delete process.env.E2E_SUPABASE_SERVICE_ROLE_KEY;
  });
  afterEach(() => {
    if (saved.url === undefined) delete process.env.E2E_SUPABASE_URL; else process.env.E2E_SUPABASE_URL = saved.url;
    if (saved.key === undefined) delete process.env.E2E_SUPABASE_SERVICE_ROLE_KEY; else process.env.E2E_SUPABASE_SERVICE_ROLE_KEY = saved.key;
  });

  const set = (url?: string) => {
    if (url !== undefined) process.env.E2E_SUPABASE_URL = url;
    process.env.E2E_SUPABASE_SERVICE_ROLE_KEY = DUMMY_KEY;
  };

  it("accepts the canonical disposable project URL", () => {
    set(CANON);
    expect(supabaseAdminEnv()).toEqual({ url: CANON, serviceRoleKey: DUMMY_KEY });
  });

  it("normalizes a trailing slash", () => {
    set(`${CANON}/`);
    expect(supabaseAdminEnv().url).toBe(CANON);
  });

  it("normalizes the /rest/v1/ endpoint form (the exact value that failed in CI)", () => {
    set(`${CANON}/rest/v1/`);
    expect(supabaseAdminEnv().url).toBe(CANON);
  });

  it("tolerates surrounding whitespace", () => {
    set(`  ${CANON}  `);
    expect(supabaseAdminEnv().url).toBe(CANON);
  });

  it("refuses the production project ref explicitly", () => {
    set(`https://${PRODUCTION_PROJECT_REF}.supabase.co`);
    expect(() => supabaseAdminEnv()).toThrowError(/PRODUCTION.*refused/i);
  });

  it("refuses any other Supabase project ref", () => {
    set("https://someotherprojectref.supabase.co");
    expect(() => supabaseAdminEnv()).toThrowError(/not the disposable project/i);
  });

  it("refuses non-HTTPS URLs of the disposable host", () => {
    set(`http://${DISPOSABLE_PROJECT_REF}.supabase.co`);
    expect(() => supabaseAdminEnv()).toThrowError(/not the disposable project/i);
  });

  it("refuses unparsable values without echoing them", () => {
    set("definitely not a url");
    let message = "";
    try {
      supabaseAdminEnv();
    } catch (err) {
      message = err instanceof Error ? err.message : String(err);
    }
    expect(message).toMatch(/not the disposable project/i);
    expect(message).not.toContain("definitely not a url");
  });

  it("allows localhost / 127.0.0.1 for local development", () => {
    set("http://127.0.0.1:54321");
    expect(supabaseAdminEnv().url).toBe("http://127.0.0.1:54321");
    set("http://localhost:54321/");
    expect(supabaseAdminEnv().url).toBe("http://localhost:54321");
  });

  it("requires both the URL and the service-role key", () => {
    process.env.E2E_SUPABASE_SERVICE_ROLE_KEY = DUMMY_KEY;
    expect(() => supabaseAdminEnv()).toThrowError(/requires E2E_SUPABASE_URL/);
    set(CANON);
    delete process.env.E2E_SUPABASE_SERVICE_ROLE_KEY;
    expect(() => supabaseAdminEnv()).toThrowError(/requires E2E_SUPABASE_URL/);
  });
});
