import { expect, test, type Page } from "@playwright/test";
import { addPlayer, addTeam, approveScoringRules, createLeague, LEADER_STATE, nameOf, pageAs, seededName, selectLeague } from "./helpers";

/**
 * J14–J16 build one league with two teams and six players, then run a match
 * through its full lifecycle: create → record an event → submit the result →
 * the leader approves. Kickoff is set in the past so approval is immediately
 * available (the approve RPC enforces the scheduled kickoff itself).
 * seededName: a worker restart re-evaluates module constants, so cross-test
 * names resolve the per-file seed lazily instead (see helpers.seededName).
 */
const leagueName = seededName("E2E Match League");
const teamA = seededName("E2E Reds");
const teamB = seededName("E2E Blues");
const matchTitle = seededName("E2E Round");

function pastKickoffLocal(): string {
  const d = new Date(Date.now() - 2 * 60 * 60 * 1000);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/**
 * Save a starting XI for one team on the match's Line-ups tab. The only
 * formation rule that matters for the six-player pool J14 registers (GK,
 * DEF, MID, FWD + two more) is exactly five starters with one goalkeeper,
 * so five clicks on the first five players always satisfy it. Each click
 * re-renders the roster list, so locate every target by its row position
 * and the unpressed XI button inside it instead of a static handle.
 */
async function setLineup(page: Page, team: string) {
  const panel = page.locator("section").filter({ has: page.getByRole("heading", { name: team, exact: true }) });
  try {
    // The roster list re-renders after every click, so always operate on the
    // current first row whose XI button is still unpressed.
    for (let i = 0; i < 5; i++) {
      await panel.locator('ul li:has(button[aria-pressed="false"])').first()
        .locator('button[aria-pressed="false"]').first().click();
    }
    await panel.getByRole("button", { name: "Save line-up" }).click();
    await expect(panel.getByRole("button", { name: "Save line-up" })).toBeEnabled();
  } catch (err) {
    const rows = await panel.locator("ul li").allTextContents().catch(() => [] as string[]);
    const xi = await panel.locator('button[aria-pressed="false"]').allTextContents().catch(() => [] as string[]);
    const disabled = await panel.locator('button[aria-pressed="false"][disabled]').allTextContents().catch(() => [] as string[]);
    throw new Error(
      `setLineup(${team}) failed: ${xi.length} unpressed XI (${JSON.stringify(xi)}), ${disabled.length} disabled. Rows: ${JSON.stringify(rows)}.`,
      { cause: err },
    );
  }
}

async function createMatch(page: Page) {
  await page.goto("/matches/new");
  await page.getByLabel("Match title").fill(nameOf(matchTitle));
  await page.getByLabel("Team A").selectOption({ label: nameOf(teamA) });
  await page.getByLabel("Team B").selectOption({ label: nameOf(teamB) });
  await page.getByLabel("Kick-off").fill(pastKickoffLocal());
  await page.getByLabel(/Match duration/).fill("60");
  await page.getByRole("button", { name: "Create match" }).click();
  await expect(page).toHaveURL(/\/matches\/[^/]+$/);
}

test.describe("journeys J14–J16 — match lifecycle", () => {
  test.use({ storageState: LEADER_STATE });

  test("J14 the leader creates a match and it lands on its match page", async ({ page }) => {
    await createLeague(page, nameOf(leagueName));
    await addTeam(page, nameOf(teamA));
    await addTeam(page, nameOf(teamB));
    let shirt = 0;
    for (const [team, positions] of [[nameOf(teamA), ["GK", "DEF", "FWD"]], [nameOf(teamB), ["GK", "DEF", "FWD"]]] as const) {
      for (const position of positions) {
        await addPlayer(page, `${team} ${position} ${nameOf(matchTitle).split(" ").pop()}`, position, team, String(++shirt));
      }
    }
    await createMatch(page);
    await expect(page.getByText(nameOf(matchTitle)).first()).toBeVisible();
    // J15's event roster and J16's result both need persisted lineups, so
    // save the starting XIs for both teams before leaving the match page.
    await setLineup(page, nameOf(teamA));
    await setLineup(page, nameOf(teamB));
    await page.goto("/matches");
    await expect(page.getByText(nameOf(matchTitle)).first()).toBeVisible();
    // Result submission is blocked until the leader approves the league's
    // scoring rules (J16's "All scoring rules must be approved" alert).
    await approveScoringRules(page, nameOf(leagueName));
  });

  test("J15 the organizer records a goal event on the match", async ({ page }) => {
    await selectLeague(page, nameOf(leagueName));
    await page.goto("/matches");
    await page.getByText(nameOf(matchTitle)).first().click();
    await expect(page).toHaveURL(/\/matches\/[^/]+$/);

    await page.getByRole("button", { name: /^Events \(\d+\)$/ }).click();
    // Both the "Record an event" and "Record a substitution" panels have
    // Team/Event/Player selects — scope strictly to the event panel.
    const eventPanel = page.locator("section").filter({ hasText: "Record an event" });
    await eventPanel.getByLabel("Team").selectOption({ label: nameOf(teamA) });
    await eventPanel.getByLabel("Event").selectOption("goal");
    await eventPanel.getByLabel("Player").selectOption({ index: 1 });
    await eventPanel.getByRole("button", { name: "Add event" }).click();
    await expect(page.getByRole("button", { name: "Events (1)" })).toBeVisible();
  });

  test("J16 the result is submitted and the leader approves it; the table shows the team", async ({ page }) => {
    await selectLeague(page, nameOf(leagueName));
    await page.goto("/matches");
    await page.getByText(nameOf(matchTitle)).first().click();

    await page.getByLabel(/Home score/).fill("1");
    await page.getByLabel(/Away score/).fill("0");
    await page.getByRole("button", { name: "Submit for review" }).click();
    await expect(page.getByText("Submitted for approval")).toBeVisible();

    // Product rule: the League Leader may approve their own submission.
    await page.getByRole("button", { name: "Approve" }).click();
    await expect(page.getByText(/Approved — points calculated/)).toBeVisible();

    await page.goto("/standings");
    await expect(page.getByRole("heading", { name: "League table" })).toBeVisible();
    await expect(page.getByText(`${nameOf(leagueName)} XI`)).toBeVisible();
    await page.goto("/points");
    await expect(page).toHaveURL(/\/points/);
  });
});
