import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { expect, test, type Browser, type Page } from "@playwright/test";
import { E2E_PASSWORD, type E2EUser } from "./env";

/** Playwright storage states written by global-setup.ts (gitignored). */
export const LEADER_STATE = "e2e/.auth/leader.json";
export const MANAGER_STATE = "e2e/.auth/manager.json";

/** Open a page in a fresh context that already holds the user's session. */
export async function pageAs(browser: Browser, storageState: string): Promise<{ page: Page; close: () => Promise<void> }> {
  const context = await browser.newContext({ storageState });
  const page = await context.newPage();
  return { page, close: () => context.close() };
}

/** Short unique suffix so reruns never collide inside a disposable project. */
export function unique(prefix: string): string {
  return `${prefix} ${uniqueSuffix()}`;
}

/**
 * One random suffix per spec FILE, persisted under e2e/.auth (gitignored,
 * deleted by global-setup at the start of every run). Two tests in one file
 * can run in different processes when a worker restarts mid-run (run
 * 45657284354: J14 created a league named `… d0t3p`, J15 then waited for
 * `… d12ef` because the restarted worker re-evaluated module constants).
 * A seed file is the only store that survives a worker process restart, so
 * every test in a file shares one seed while different runs still get
 * different names.
 */
export function uniqueSuffix(): string {
  const file = test.info().file.replace(/[^a-z0-9]+/gi, "_");
  const seedPath = path.join(__dirname, ".auth", `seed-${file}`);
  try {
    return readFileSync(seedPath, "utf8").trim();
  } catch {
    const created = Date.now().toString(36).slice(-5);
    try {
      mkdirSync(path.dirname(seedPath), { recursive: true });
      writeFileSync(seedPath, created, { flag: "wx" });
      return created;
    } catch {
      // A concurrent worker created the seed first — use theirs.
      return readFileSync(seedPath, "utf8").trim();
    }
  }
}

/**
 * Await an expected navigation; on timeout, fail with the page's own visible
 * feedback (role="alert" notes, role="status" toasts) and the current URL so
 * a failure identifies its real cause instead of a bare locator timeout.
 */
export async function expectNavigation(page: Page, re: RegExp, action: string) {
  try {
    await expect(page).toHaveURL(re);
  } catch (err) {
    const alerts = await page.getByRole("alert").allTextContents().catch(() => [] as string[]);
    const statuses = await page.getByRole("status").allTextContents().catch(() => [] as string[]);
    throw new Error(
      `${action}: expected URL ${re}, still at ${page.url()}. ` +
        `Visible alerts: ${JSON.stringify(alerts)}. Status messages: ${JSON.stringify(statuses)}.`,
      { cause: err },
    );
  }
}

/** Sign in through the real login form (used by the login journeys). */
export async function uiSignIn(page: Page, user: E2EUser) {
  await page.goto("/login");
  await page.getByLabel("Email").fill(user.email);
  await page.getByLabel("Password").fill(E2E_PASSWORD);
  await page.getByRole("button", { name: "Sign in" }).click();
  // League-less accounts are intentionally routed from /dashboard to /leagues
  // by useActiveLeague (LeagueContext onboarding guard). Both landings prove
  // a signed-in app session; /leagues-only assertions belong to the journeys.
  await expectNavigation(page, /\/(dashboard|leagues)/, `uiSignIn(${user.username})`);
}

/** Create a league via the UI; on success the app navigates to /dashboard. */
export async function createLeague(page: Page, name: string) {
  await page.goto("/leagues");
  await page.getByRole("button", { name: "Create league" }).first().click();
  await page.getByLabel("League name").fill(name);
  await page.getByLabel("Your team name").fill(`${name} XI`);
  // league.create is rate-limited to 10 hits/hour per user in fixed epoch
  // windows (0034_rate_limiting.sql), and prior runs on the persistent
  // disposable project spend part of the shared leader account's budget.
  // Rather than failing the whole cascade, retry the submit until the next
  // window opens (worst case one full hour).
  const deadline = Date.now() + 65 * 60 * 1000;
  for (;;) {
    // The submit button shares its label with the toggle in the page header.
    await page.getByRole("button", { name: "Create league" }).last().click();
    const limited = page.getByRole("alert").filter({ hasText: /too many attempts/i }).first();
    const landed = await Promise.race([
      page.waitForURL(/\/dashboard/, { timeout: 15_000 }).then(() => true, () => false),
      limited.waitFor({ state: "visible", timeout: 15_000 }).then(() => false, () => false),
    ]);
    if (landed) return;
    if (await limited.isVisible().catch(() => false) && Date.now() < deadline) {
      await page.waitForTimeout(30_000);
      continue;
    }
    await expectNavigation(page, /\/dashboard/, `createLeague(${name})`);
    return;
  }
}

/** Join a league by invitation code via the UI; navigates to /dashboard. */
export async function joinLeague(page: Page, code: string) {
  await page.goto("/leagues");
  await page.getByRole("button", { name: "Join with code" }).click();
  await page.getByLabel("Invitation code").fill(code);
  await page.getByRole("button", { name: "Join league" }).click();
  await expectNavigation(page, /\/dashboard/, `joinLeague(code len=${code.length})`);
}

/** Select a league by exact name from /leagues (earlier runs leave same-prefix leagues behind). */
export async function selectLeague(page: Page, name: string) {
  await page.goto("/leagues");
  const row = page.locator("li").filter({ has: page.getByText(name, { exact: true }) }).first();
  await row.getByRole("link").click();
  await expect(page).toHaveURL(/\/dashboard/);
}

/** Read the invitation code printed on the league's /leagues list entry. */
export async function inviteCodeOf(page: Page, name: string): Promise<string> {
  await page.goto("/leagues");
  // Exact-name row: a substring filter can read a stale same-prefix league's
  // code from an earlier run on the shared disposable project.
  const row = page.locator("li").filter({ has: page.getByText(name, { exact: true }) }).first();
  // The code sits in its own span ("{team} · code {CODE}"). Reading the whole
  // li concatenates the role badge onto the capture (textContent adds no
  // whitespace): "AB12CD34" came back as "AB12CD34League" (len=14) and the
  // join correctly failed with "No league found with that code".
  const line = await row.locator("span").filter({ hasText: /· code / }).last().textContent();
  const match = line?.match(/code\s+([A-Z0-9]{4,20})\s*$/i);
  if (!match) throw new Error(`No invitation code visible for league "${name}" — is the caller a member?`);
  return match[1].toUpperCase();
}

/** Add a real team through the players page modal. */
export async function addTeam(page: Page, teamName: string) {
  await page.goto("/players");
  await page.getByRole("button", { name: "Add team" }).first().click();
  await page.getByLabel("Team name").fill(teamName);
  await page.getByRole("button", { name: "Add team" }).last().click();
  await expect(page.getByRole("dialog")).not.toBeVisible();
}

/** Add a player through the players page modal. */
export async function addPlayer(
  page: Page,
  fullName: string,
  position: "GK" | "DEF" | "MID" | "FWD",
  teamName: string,
  shirt: string,
) {
  await page.goto("/players");
  await page.getByRole("button", { name: "Add player" }).first().click();
  await page.getByLabel("Full name").fill(fullName);
  await page.getByLabel("Position").selectOption(position);
  await page.getByLabel("Team").selectOption({ label: teamName });
  await page.getByLabel("Shirt number").fill(shirt);
  await page.getByRole("button", { name: "Add player" }).last().click();
  await expect(page.getByRole("dialog")).not.toBeVisible();
  await expect(page.getByText(fullName).first()).toBeVisible();
}
