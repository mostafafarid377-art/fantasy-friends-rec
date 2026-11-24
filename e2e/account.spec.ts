import { expect, test } from "@playwright/test";
import { E2E_USERS } from "./env";
import { addTeam, createLeague, inviteCodeOf, joinLeague, LEADER_STATE, MANAGER_STATE, pageAs, unique } from "./helpers";

/**
 * J17–J18 cover the account surface: notifications driven by a real league
 * event (creating a match notifies every other member) and profile editing
 * with a verified read-back.
 */
const leagueName = unique("E2E Notify League");
const teamA = unique("E2E Notify A");
const teamB = unique("E2E Notify B");
const matchTitle = unique("E2E Notify Match");

test.describe("journeys J17–J18 — notifications and profile", () => {
  test("J17 a league event notifies the other member and mark-all-read clears it", async ({ browser }) => {
    const leader = await pageAs(browser, LEADER_STATE);
    await createLeague(leader.page, leagueName);
    await addTeam(leader.page, teamA);
    await addTeam(leader.page, teamB);
    const code = await inviteCodeOf(leader.page, leagueName);

    const member = await pageAs(browser, MANAGER_STATE);
    await joinLeague(member.page, code);
    await member.close();

    // Leader creates a match — every other member is notified.
    await leader.page.goto("/matches/new");
    await leader.page.getByLabel("Match title").fill(matchTitle);
    await leader.page.getByLabel("Team A").selectOption({ label: teamA });
    await leader.page.getByLabel("Team B").selectOption({ label: teamB });
    const d = new Date(Date.now() + 24 * 60 * 60 * 1000);
    const pad = (n: number) => String(n).padStart(2, "0");
    await leader.page.getByLabel("Kick-off").fill(
      `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`,
    );
    await leader.page.getByRole("button", { name: "Create match" }).click();
    await expect(leader.page).toHaveURL(/\/matches\/[^/]+$/);
    await leader.close();

    const again = await pageAs(browser, MANAGER_STATE);
    try {
      await again.page.goto("/notifications");
      await expect(again.page.getByRole("heading", { name: "Notifications" })).toBeVisible();
      await expect(again.page.getByText("New real match").first()).toBeVisible();
      await again.page.getByRole("button", { name: "Mark all read" }).click();
      await expect(again.page.getByText(/0 unread/)).toBeVisible();
    } finally {
      await again.close();
    }
  });

  test("J18 the profile edit persists and survives a reload", async ({ browser }) => {
    const newName = unique("E2E Manager");
    const member = await pageAs(browser, MANAGER_STATE);
    try {
      const page = member.page;
      await page.goto("/profile");
      await page.getByLabel("Display name").fill(newName);
      await page.getByRole("button", { name: "Save profile" }).click();
      await expect(page.getByText("All changes saved")).toBeVisible();
      await page.reload();
      await expect(page.getByLabel("Display name")).toHaveValue(newName);

      // Restore the canonical display name for the other journeys.
      await page.getByLabel("Display name").fill(E2E_USERS.manager.displayName);
      await page.getByRole("button", { name: "Save profile" }).click();
      await expect(page.getByText("All changes saved")).toBeVisible();
    } finally {
      await member.close();
    }
  });
});
