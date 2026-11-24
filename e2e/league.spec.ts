import { expect, test } from "@playwright/test";
import { E2E_USERS } from "./env";
import { createLeague, inviteCodeOf, joinLeague, LEADER_STATE, MANAGER_STATE, pageAs } from "./helpers";

test.describe("journeys J09–J11 — leagues and membership", () => {
  const leagueName = `E2E League ${Date.now().toString(36)}`;

  test.describe("as the leader", () => {
    test.use({ storageState: LEADER_STATE });

    test("J09 the dashboard loads with league, squad and standings sections", async ({ page }) => {
      await page.goto("/dashboard");
      await expect(page.getByRole("heading", { name: /Matchday HQ/i })).toBeVisible();
      // Signed-in chrome renders the app navigation.
      await expect(page.getByRole("link", { name: "My Team" }).first()).toBeVisible();
      await expect(page.getByRole("link", { name: "Standings" }).first()).toBeVisible();
    });

    test("J10 the leader creates a league and it appears in the list", async ({ page }) => {
      await createLeague(page, leagueName);
      await page.goto("/leagues");
      await expect(page.locator("li", { hasText: leagueName })).toBeVisible();
      await expect(page.locator("li", { hasText: leagueName })).toContainText(/code [A-Z0-9]{4,20}/i);
    });
  });

  test("J11 a second account joins by invitation code and both see two members", async ({ browser }) => {
    const leader = await pageAs(browser, LEADER_STATE);
    const code = await inviteCodeOf(leader.page, leagueName);
    await leader.close();

    const member = await pageAs(browser, MANAGER_STATE);
    try {
      await joinLeague(member.page, code);
      await member.page.goto("/members");
      await expect(member.page.getByText(E2E_USERS.leader.displayName)).toBeVisible();
      await expect(member.page.getByText(E2E_USERS.manager.displayName)).toBeVisible();
    } finally {
      await member.close();
    }

    const again = await pageAs(browser, LEADER_STATE);
    try {
      await again.page.goto("/members");
      await expect(again.page.getByText(E2E_USERS.manager.displayName)).toBeVisible();
    } finally {
      await again.close();
    }
  });
});
