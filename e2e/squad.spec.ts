import { expect, test, type Page } from "@playwright/test";
import {
  addPlayer, addTeam, createLeague, inviteCodeOf, joinLeague,
  LEADER_STATE, MANAGER_STATE, nameOf, pageAs, seededName,
} from "./helpers";

/**
 * J12–J13 build one league: the leader registers a team and six players
 * (covering the default 5v5 formation 1-2-1 plus a bench goalkeeper), then a
 * second account joins and picks a complete squad through the real picker UI.
 * seededName: a worker restart re-evaluates module constants, so cross-test
 * names resolve the per-file seed lazily instead (see helpers.seededName).
 */
const leagueName = seededName("E2E Squad League");
const teamName = seededName("E2E Reds");
const players = [
  { name: seededName("Keeper One"), position: "GK" },
  { name: seededName("Keeper Two"), position: "GK" },
  { name: seededName("Defender"), position: "DEF" },
  { name: seededName("Midfielder A"), position: "MID" },
  { name: seededName("Midfielder B"), position: "MID" },
  { name: seededName("Forward"), position: "FWD" },
] as const;

/** Pick the first eligible player inside the open picker dialog. */
async function pickFirstInDialog(page: Page) {
  const dialog = page.getByRole("dialog");
  await dialog.locator("li button:not([disabled])").first().click();
  await expect(dialog).not.toBeVisible();
}

test.describe("journeys J12–J13 — player pool and squad picking", () => {
  test("J12 the leader registers a team and six players in the league pool", async ({ browser }) => {
    const leader = await pageAs(browser, LEADER_STATE);
    try {
      await createLeague(leader.page, nameOf(leagueName));
      await addTeam(leader.page, nameOf(teamName));
      let shirt = 0;
      for (const p of players) {
        await addPlayer(leader.page, nameOf(p.name), p.position, nameOf(teamName), String(++shirt));
      }
      await leader.page.goto("/players");
      for (const p of players) {
        await expect(leader.page.getByText(nameOf(p.name)).first()).toBeVisible();
      }
    } finally {
      await leader.close();
    }
  });

  test("J13 a member picks a complete squad — starters, bench keeper, captain — and saves", async ({ browser }) => {
    const leader = await pageAs(browser, LEADER_STATE);
    const code = await inviteCodeOf(leader.page, nameOf(leagueName));
    await leader.close();

    const member = await pageAs(browser, MANAGER_STATE);
    try {
      const page = member.page;
      await joinLeague(page, code);
      await page.goto("/team/pick");
      await expect(page.getByRole("heading", { name: /Pick squad|Edit squad/ })).toBeVisible();

      // Five starters: the pitch offers one empty slot per position.
      for (let slot = 0; slot < 5; slot++) {
        await page.getByRole("button", { name: /^Add (GK|DEF|MID|FWD) \d+$/ }).first().click();
        await pickFirstInDialog(page);
      }
      // First bench spot is reserved for a goalkeeper.
      await page.getByRole("button", { name: "Pick bench goalkeeper" }).click();
      await pickFirstInDialog(page);

      // A played lineup names a captain and a different vice-captain.
      const pitch = page.getByRole("region", { name: /football pitch/ });
      const starterNames = [nameOf(players[2].name), nameOf(players[3].name)]; // a DEF and a MID are starters in the default 1-2-1
      await pitch.getByRole("button", { name: new RegExp(`^${starterNames[0]},`) }).click();
      await page.getByRole("button", { name: "Make captain" }).click();
      await page.getByRole("button", { name: "Close dialog" }).click();
      await pitch.getByRole("button", { name: new RegExp(`^${starterNames[1]},`) }).click();
      await page.getByRole("button", { name: "Make vice" }).click();
      await page.getByRole("button", { name: "Close dialog" }).click();

      await page.getByRole("button", { name: "Save squad" }).click();
      await expect(page.getByText("Complete").first()).toBeVisible();
      await expect(page.getByRole("heading", { name: "My squad" })).toBeVisible();
    } finally {
      await member.close();
    }
  });
});
