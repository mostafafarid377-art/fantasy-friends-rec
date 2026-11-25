import { expect, test } from "@playwright/test";
import { E2E_USERS } from "./env";
import { addTeam, createLeague, inviteCodeOf, joinLeague, LEADER_STATE, MANAGER_STATE, nameOf, pageAs, seededName, unique } from "./helpers";

/**
 * J17–J18 cover the account surface: notifications driven by a real league
 * event (creating a match notifies every other member) and profile editing
 * with a verified read-back.
 * seededName: a worker restart re-evaluates module constants, so cross-test
 * names resolve the per-file seed lazily instead (see helpers.seededName).
 */
const leagueName = seededName("E2E Notify League");
const teamA = seededName("E2E Notify A");
const teamB = seededName("E2E Notify B");
const matchTitle = seededName("E2E Notify Match");

test.describe("journeys J17–J18 — notifications and profile", () => {
  test("J17 a league event notifies the other member and mark-all-read clears it", async ({ browser }) => {
    const leader = await pageAs(browser, LEADER_STATE);
    await createLeague(leader.page, nameOf(leagueName));
    await addTeam(leader.page, nameOf(teamA));
    await addTeam(leader.page, nameOf(teamB));
    const code = await inviteCodeOf(leader.page, nameOf(leagueName));

    const member = await pageAs(browser, MANAGER_STATE);
    await joinLeague(member.page, code);
    await member.close();

    // Leader creates a match — every other member is notified.
    await leader.page.goto("/matches/new");
    await leader.page.getByLabel("Match title").fill(nameOf(matchTitle));
    await leader.page.getByLabel("Team A").selectOption({ label: nameOf(teamA) });
    await leader.page.getByLabel("Team B").selectOption({ label: nameOf(teamB) });
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
      const save = async () => {
        await page.getByRole("button", { name: "Save profile" }).click();
        const saved = page.getByText("All changes saved");
        const toast = page.getByRole("status").first();
        // Race the success indicator against the error toast, which
        // auto-dismisses after ~4s — an un-raced timeout would lose the
        // actual failure message from the page.
        await expect(saved.or(toast)).toBeVisible();
        const toastText = ((await toast.textContent().catch(() => "")) ?? "").trim();
        if (toastText && !toastText.includes("Profile saved")) {
          throw new Error(`Profile save surfaced an error toast: ${toastText}`);
        }
        await expect(saved).toBeVisible();
      };
      await page.goto("/profile");
      await page.getByLabel("Display name").fill(newName);
      await save();
      await page.reload();
      await expect(page.getByLabel("Display name")).toHaveValue(newName);

      // Restore the canonical display name for the other journeys.
      await page.getByLabel("Display name").fill(E2E_USERS.manager.displayName);
      await save();
    } finally {
      await member.close();
    }
  });
});
