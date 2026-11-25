import { defineConfig } from "@playwright/test";
import { e2eBaseURL } from "./e2e/env";

/**
 * Browser E2E suite — runs the 19 core user journeys against a DISPOSABLE
 * environment only. See E2E_TESTING.md for the exact setup.
 *
 * Safety: e2eBaseURL() refuses known production origins, global setup
 * provisions test-only accounts through the disposable project's Admin API,
 * and no app code path is weakened or bypassed for tests — the suite signs
 * in through the real login surface.
 */
export default defineConfig({
  testDir: "./e2e",
  timeout: 90_000,
  expect: { timeout: 10_000 },
  // Journeys share provisioned accounts and build league state step by step;
  // one worker keeps that deterministic. Rate limits (migration 0034) also
  // assume a modest request rate per test account.
  workers: 1,
  fullyParallel: false,
  retries: 0,
  reporter: [["list"], ["html", { open: "never" }]],
  globalSetup: "./e2e/global-setup.ts",
  use: {
    baseURL: e2eBaseURL(),
    screenshot: "only-on-failure",
    trace: "retain-on-failure",
  },
  // With no E2E_BASE_URL the suite starts a local dev server, which must be
  // backed by the disposable project's .env.local — never production values.
  webServer: process.env.E2E_BASE_URL
    ? undefined
    : {
        command: "npm run dev -- --port 3000",
        url: "http://127.0.0.1:3000",
        reuseExistingServer: true,
        timeout: 180_000,
      },
});
