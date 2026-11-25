import { expect, test, type Page } from "@playwright/test";
import { addPlayer, addTeam, createLeague, LEADER_STATE, pageAs, selectLeague, unique } from "./helpers";

/**
 * J14–J16 build one league with two teams and six players, then run a match
 * through its full lifecycle: create → record an event → submit the result →
 * the leader approves. Kickoff is set in the past so approval is immediately
 * available (the approve RPC enforces the scheduled kickoff itself).
 */
const leagueName = unique("E2E Match League");
const teamA = unique("E2E Reds");
const teamB = unique("E2E Blues");
const matchTitle = unique("E2E Round");

function pastKickoffLocal(): string {
  const d = new Date(Date.now() - 2 * 60 * 60 * 1000);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

async function createMatch(page: Page) {
  await page.goto("/matches/new");
  await page.getByLabel("Match title").fill(matchTitle);
  await page.getByLabel("Team A").selectOption({ label: teamA });
  await page.getByLabel("Team B").selectOption({ label: teamB });
  await page.getByLabel("Kick-off").fill(pastKickoffLocal());
  await page.getByLabel(/Match duration/).fill("60");
  await page.getByRole("button", { name: "Create match" }).click();
  await expect(page).toHaveURL(/\/matches\/[^/]+$/);
}

test.describe("journeys J14–J16 — match lifecycle", () => {
  test.use({ storageState: LEADER_STATE });

  test("J14 the leader creates a match and it lands on its match page", async ({ page }) => {
    await createLeague(page, leagueName);
    await addTeam(page, teamA);
    await addTeam(page, teamB);
    let shirt = 0;
    for (const [team, positions] of [[teamA, ["GK", "DEF", "FWD"]], [teamB, ["GK", "DEF", "FWD"]]] as const) {
      for (const position of positions) {
        await addPlayer(page, unique(`${team} ${position}`), position, team, String(++shirt));
      }
    }
    await createMatch(page);
    await expect(page.getByText(matchTitle).first()).toBeVisible();
    await page.goto("/matches");
    await expect(page.getByText(matchTitle).first()).toBeVisible();
  });

  test("J15 the organizer records a goal event on the match", async ({ page }) => {
    await selectLeague(page, leagueName);
    await page.goto("/matches");
    await page.getByText(matchTitle).first().click();
    await expect(page).toHaveURL(/\/matches\/[^/]+$/);

    await page.getByRole("button", { name: /^Events \(\d+\)$/ }).click();
    // Both the "Record an event" and "Record a substitution" panels have
    // Team/Event/Player selects — scope strictly to the event panel.
    const eventPanel = page.locator("section").filter({ hasText: "Record an event" });
    await eventPanel.getByLabel("Team").selectOption({ label: teamA });
    await eventPanel.getByLabel("Event").selectOption("goal");
    await eventPanel.getByLabel("Player").selectOption({ index: 1 });
    await eventPanel.getByRole("button", { name: "Add event" }).click();
    await expect(page.getByRole("button", { name: "Events (1)" })).toBeVisible();
  });

  test("J16 the result is submitted and the leader approves it; the table shows the team", async ({ page }) => {
    await selectLeague(page, leagueName);
    await page.goto("/matches");
    await page.getByText(matchTitle).first().click();

    await page.getByLabel(/Home score/).fill("1");
    await page.getByLabel(/Away score/).fill("0");
    await page.getByRole("button", { name: "Submit for review" }).click();
    await expect(page.getByText("Submitted for approval")).toBeVisible();

    // Product rule: the League Leader may approve their own submission.
    await page.getByRole("button", { name: "Approve" }).click();
    await expect(page.getByText(/Approved — points calculated/)).toBeVisible();

    await page.goto("/standings");
    await expect(page.getByRole("heading", { name: "League table" })).toBeVisible();
    await expect(page.getByText(`${leagueName} XI`)).toBeVisible();
    await page.goto("/points");
    await expect(page).toHaveURL(/\/points/);
  });
});
