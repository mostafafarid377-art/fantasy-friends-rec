import { expect, test } from "@playwright/test";
import { addPlayer, addTeam, createLeague, LEADER_STATE, nameOf, seededName } from "./helpers";

/**
 * Standalone J14 diagnostic: build the league + teams + players + match,
 * then attempt the lineup save with full DOM logging at every step so the
 * real reason the XI clicks fail is visible in the run output.
 */
const leagueName = seededName("E2E Diag League");
const teamA = seededName("E2E Diag A");
const teamB = seededName("E2E Diag B");

test.describe("J14-DIAG", () => {
  test.use({ storageState: LEADER_STATE });

  test("lineup save with full DOM tracing", async ({ page }) => {
    test.setTimeout(5 * 60 * 1000);

  await createLeague(page, nameOf(leagueName));
  await addTeam(page, nameOf(teamA));
  await addTeam(page, nameOf(teamB));
  let shirt = 0;
  for (const [team, positions] of [[nameOf(teamA), ["GK", "DEF", "MID", "FWD", "FWD"]], [nameOf(teamB), ["GK", "DEF", "MID", "FWD", "FWD"]]] as const) {
    for (const position of positions) {
      await addPlayer(page, `${team} ${position} ${++shirt}`, position, team, String(shirt));
    }
  }

  await page.goto("/matches/new");
  await page.getByLabel("Match title").fill("DIAG MATCH");
  await page.getByLabel("Team A").selectOption({ label: nameOf(teamA) });
  await page.getByLabel("Team B").selectOption({ label: nameOf(teamB) });
  const d = new Date(Date.now() - 2 * 60 * 60 * 1000);
  const pad = (n: number) => String(n).padStart(2, "0");
  await page.getByLabel("Kick-off").fill(`${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`);
  await page.getByLabel(/Match duration/).fill("60");
  await page.getByRole("button", { name: "Create match" }).click();
  await expect(page).toHaveURL(/\/matches\/[^/]+$/);

  // Now diagnose the lineup panel for teamA.
  const team = nameOf(teamA);
  console.log(`[J14-DIAG] team = ${JSON.stringify(team)}`);

  const headingCount = await page.getByRole("heading", { name: team, exact: true }).count();
  console.log(`[J14-DIAG] heading count (exact): ${headingCount}`);
  const headingLoose = await page.getByRole("heading", { name: team }).count();
  console.log(`[J14-DIAG] heading count (loose): ${headingLoose}`);

  const panel = page.locator("section").filter({ has: page.getByRole("heading", { name: team, exact: true }) });
  const panelCount = await panel.count();
  console.log(`[J14-DIAG] panel count: ${panelCount}`);

  const rows = panel.locator("ul li");
  const rowCount = await rows.count();
  console.log(`[J14-DIAG] roster rows in panel: ${rowCount}`);
  const rowTexts = await rows.allTextContents().catch(() => [] as string[]);
  console.log(`[J14-DIAG] row texts: ${JSON.stringify(rowTexts)}`);

  const xiButtons = panel.locator('button[aria-pressed="false"]');
  const xiCount = await xiButtons.count();
  const xiTexts = await xiButtons.allTextContents().catch(() => [] as string[]);
  console.log(`[J14-DIAG] unpressed buttons in panel: ${xiCount} texts=${JSON.stringify(xiTexts)}`);

  const xiNamed = panel.locator('button[aria-pressed="false"]').filter({ hasText: "XI" });
  console.log(`[J14-DIAG] unpressed XI-named buttons: ${await xiNamed.count()}`);

  const disabledXi = panel.locator('button[aria-pressed="false"][disabled]');
  console.log(`[J14-DIAG] disabled unpressed buttons: ${await disabledXi.count()}`);

  const saveBtn = panel.getByRole("button", { name: "Save line-up" });
  console.log(`[J14-DIAG] save-lineup count: ${await saveBtn.count()} enabled: ${await saveBtn.isEnabled().catch(() => "n/a")}`);

  // Dump the whole panel HTML (trimmed) so the exact markup is in the log.
  const html = await panel.innerHTML().catch(() => "(no html)");
  console.log(`[J14-DIAG] panel html (first 3000): ${html.slice(0, 3000)}`);

  // Attempt the actual clicks with the diagnostic counts available.
  for (let i = 0; i < 5; i++) {
    const target = panel.locator("ul li").filter({ has: page.locator('button[aria-pressed="false"]') }).first()
      .locator('button[aria-pressed="false"]').first();
    const t = await target.count();
    console.log(`[J14-DIAG] click ${i}: target count=${t}`);
    await target.click();
  }
  await saveBtn.click();
  await expect(saveBtn).toBeEnabled();
  console.log("[J14-DIAG] lineup saved OK");
  });
});
