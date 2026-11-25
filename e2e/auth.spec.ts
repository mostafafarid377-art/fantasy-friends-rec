import { expect, test } from "@playwright/test";
import { E2E_EMAIL_DOMAIN, E2E_USERS } from "./env";
import { uiSignIn } from "./helpers";

/**
 * Auth journeys. No test-only auth path exists or is needed: every journey
 * drives the real UI against the disposable Supabase project.
 */

test.describe("journeys J01–J08, J19 — auth", () => {
  test("J01 marketing home renders and links to sign up and sign in", async ({ page }) => {
    await page.goto("/");
    await expect(page).toHaveTitle(/fantasy/i);
    await expect(page.getByRole("link", { name: /sign up|create|get started|start/i }).first()).toBeVisible();
    await expect(page.getByRole("link", { name: /sign in|log in/i }).first()).toBeVisible();
  });

  test("J02 signup rejects a short password client-side without a request", async ({ page }) => {
    await page.goto("/signup");
    await page.getByLabel("Display name").fill("Journey Two");
    await page.getByLabel("Username").fill("journey_two");
    await page.getByLabel("Email").fill(`j02-short-pass@${E2E_EMAIL_DOMAIN}`);
    await page.getByLabel("Password", { exact: true }).fill("short");
    await page.getByLabel("Confirm").fill("short");
    const requests = page.waitForRequest("/api/auth/signup", { timeout: 1500 }).catch(() => null);
    await page.getByRole("button", { name: "Create account" }).click();
    await expect(page).toHaveURL(/\/signup/);
    expect(await requests, "no signup request may leave the browser for an invalid form").toBeNull();
  });

  test("J03 signup with valid details shows the email confirmation step", async ({ page }) => {
    const email = `j03-${Date.now().toString(36)}@${E2E_EMAIL_DOMAIN}`;
    await page.goto("/signup");
    await page.getByLabel("Display name").fill("Journey Three");
    await page.getByLabel("Username").fill(`j03_${Date.now().toString(36)}`);
    await page.getByLabel("Email").fill(email);
    await page.getByLabel("Password", { exact: true }).fill("J03-Passw0rd-Ok!");
    await page.getByLabel("Confirm").fill("J03-Passw0rd-Ok!");
    await page.getByRole("button", { name: "Create account" }).click();
    // The disposable project keeps email confirmations ON (see E2E_TESTING.md).
    await expect(page.getByRole("heading", { name: "Check your email" })).toBeVisible();
  });

  test("J04 sign in with valid credentials lands on the dashboard", async ({ page }) => {
    await uiSignIn(page, E2E_USERS.leader);
    await expect(page.getByRole("heading", { name: /Matchday HQ/i })).toBeVisible();
    // Regression lock: credentials must never be serialized into the URL.
    expect(page.url()).not.toContain("password");
    expect(page.url()).not.toContain(encodeURIComponent(E2E_USERS.leader.email));
  });

  test("J05 wrong password shows one non-enumerating error and stays on /login", async ({ page }) => {
    await page.goto("/login");
    await page.getByLabel("Email").fill(E2E_USERS.manager.email);
    await page.getByLabel("Password").fill("definitely-wrong-password");
    await page.getByRole("button", { name: "Sign in" }).click();
    await expect(page.getByRole("alert").filter({ hasText: "Incorrect email or password" })).toBeVisible();
    await expect(page).toHaveURL(/\/login/);
    // Regression lock: a failed attempt must not leak the submitted
    // credentials into the URL (native GET fallback would put them there).
    expect(page.url()).not.toContain("password");
    expect(page.url()).not.toContain(encodeURIComponent(E2E_USERS.manager.email));
  });

  test("J06 forgot password answers unknown emails identically (no enumeration)", async ({ page }) => {
    await page.goto("/forgot");
    await page.getByLabel("Email").fill(`nobody-${Date.now().toString(36)}@${E2E_EMAIL_DOMAIN}`);
    await page.getByRole("button", { name: "Send reset link" }).click();
    await expect(page.getByRole("heading", { name: "Check your inbox" })).toBeVisible();
  });

  test("J07 Google sign-in button starts OAuth when configured", async ({ page }) => {
    await page.goto("/login");
    const google = page.getByRole("button", { name: /Continue with Google/ });
    test.skip(!(await google.count()), "Google OAuth is not configured on this disposable project — button correctly hidden");
    await google.click();
    // The app hands off to the project's own Supabase authorize endpoint.
    await page.waitForURL(/\/auth\/v1\/authorize|accounts\.google\.com/);
  });

  test("J08 reset without a recovery session reports the link invalid", async ({ page }) => {
    await page.goto("/reset");
    await page.getByLabel("New password").fill("J08-New-Passw0rd!");
    await page.getByLabel("Confirm password").fill("J08-New-Passw0rd!");
    await page.getByRole("button", { name: "Set new password" }).click();
    await expect(page.getByText(/invalid or has expired/i)).toBeVisible();
  });

  test("J19 sign out ends the session and /dashboard redirects to /login", async ({ page }) => {
    await uiSignIn(page, E2E_USERS.outsider);
    await page.goto("/profile");
    await page.getByRole("button", { name: "Sign out" }).click();
    // Sign-out is async: wait until the app has finished it (it replaces to
    // /login) before probing the route guard with a fresh navigation —
    // otherwise the hard goto races the in-flight logout POST and the
    // request still carries the old session cookie.
    await expect(page).toHaveURL(/\/login/);
    await page.goto("/dashboard");
    await expect(page).toHaveURL(/\/login/);
  });
});
