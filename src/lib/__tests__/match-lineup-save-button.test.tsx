// @vitest-environment jsdom
import { afterEach, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import MatchPage from "@/app/(app)/matches/[id]/page";

vi.mock("@/components/LeagueContext", () => ({ useActiveLeague: () => ({ league: { id: "league", name: "League" } }) }));
vi.mock("@/components/AppShell", () => ({ PageHeader: ({ title, eyebrow }: { title: React.ReactNode; eyebrow?: string }) => <><p>{eyebrow}</p><h1>{title}</h1></> }));

afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

const mk = (id: string, fullName: string, position: string, teamId: string) =>
  ({ id, fullName, position, teamId, photoUrl: null, shirtNumber: null, status: "active", availability: "available" });
const players = [
  mk("p0", "Keeper One", "GK", "home"), mk("p1", "Def One", "DEF", "home"), mk("p2", "Mid One", "MID", "home"),
  mk("p3", "Mid Two", "MID", "home"), mk("p4", "Fwd One", "FWD", "home"), mk("p5", "Keeper Two", "GK", "home"),
  mk("p6", "Mid Three", "MID", "home"),
  mk("q0", "Away Keeper", "GK", "away"), mk("q1", "Away Def", "DEF", "away"), mk("q2", "Away Mid", "MID", "away"),
  mk("q3", "Away Mid Two", "MID", "away"), mk("q4", "Away Fwd", "FWD", "away"), mk("q5", "Away Def Two", "DEF", "away"),
];
const teams = [{ id: "home", name: "Home" }, { id: "away", name: "Away" }];
const homeSaved = [
  ...["p0", "p1", "p2", "p3", "p4"].map((playerId, order) => ({ id: `line-${playerId}`, teamId: "home", playerId, slot: "starter", order })),
  { id: "line-p5", teamId: "home", playerId: "p5", slot: "sub", order: 0 },
];

function server({ canOrganize = true, matchId = "m", initial = homeSaved }: { canOrganize?: boolean; matchId?: string; initial?: typeof homeSaved } = {}) {
  let lineups: typeof homeSaved = [...initial];
  const puts: { teamId: string; starters: { playerId: string; order: number }[]; subs: { playerId: string; order: number }[] }[] = [];
  let failNext = false;
  let holdPuts = false;
  let heldResolve: ((r: Response) => void) | null = null;
  const rowsFor = (teamId: string, starters: { playerId: string; order: number }[], subs: { playerId: string; order: number }[]) => [
    ...starters.map((e) => ({ id: `srv-${teamId}-${e.playerId}`, teamId, playerId: e.playerId, slot: "starter", order: e.order })),
    ...subs.map((e) => ({ id: `srv-${teamId}-${e.playerId}`, teamId, playerId: e.playerId, slot: "sub", order: e.order })),
  ];
  const fetch = vi.fn(async (url: string, init?: RequestInit) => {
    if (url.endsWith("/lineup")) {
      const body = JSON.parse(String(init?.body));
      if (failNext) { failNext = false; return Response.json({ error: "Could not save lineup: database unavailable" }, { status: 500 }); }
      if (holdPuts) {
        holdPuts = false;
        return new Promise<Response>((resolve) => { heldResolve = (r) => { puts.push(body); heldResolve = null; resolve(r); }; });
      }
      puts.push(body);
      lineups = [...lineups.filter((l) => l.teamId !== body.teamId), ...rowsFor(body.teamId, body.starters, body.subs)];
      return Response.json({ lineups: lineups.filter((l) => l.teamId === body.teamId) });
    }
    if (!url.endsWith(`/${matchId}`)) throw new Error(`Unexpected ${url}`);
    return Response.json({
      serverNow: "2026-11-19T19:00:00Z",
      match: { id: matchId, leagueId: "league", title: "Game", status: "draft", kickOff: "2026-11-19T18:00:00Z", teamAId: "home", teamBId: "away", version: 1 },
      rules: { format: "5v5", starters: 5, subsCount: 2, squadSize: 10 }, canOrganize, teams, roster: players,
      lineups, events: [], substitutions: [], approvals: [],
    });
  });
  return {
    fetch, puts, rowsFor,
    failNextSave: () => { failNext = true; },
    holdNextPut: () => { holdPuts = true; },
    releaseHeldPut: (rows: ReturnType<typeof rowsFor>) => {
      if (rows.length) lineups = [...lineups.filter((l) => l.teamId !== rows[0].teamId), ...rows];
      heldResolve?.(Response.json({ lineups: rows }));
    },
  };
}

const paramsOf = (id: string) => Promise.resolve({ id });
const row = (name: string) => within(screen.getByText(name).closest("li")!);
const savedButton = () => screen.queryAllByRole("button", { name: "Lineup Saved" });
const saveButtons = () => screen.queryAllByRole("button", { name: "Save line-up" });

it("shows the green saved state for an unchanged lineup, enables Save on a bench change, and restores green on revert", async () => {
  const { fetch } = server();
  vi.stubGlobal("fetch", fetch);
  render(<MatchPage params={paramsOf("m")} />);
  const saved = (await screen.findAllByRole("button", { name: "Lineup Saved" }))[0] as HTMLButtonElement;
  expect(saved.disabled).toBe(true);
  expect(saved.className).toContain("#34e07f");
  // The away team has no persisted lineup: plain outline save, disabled while invalid, not green.
  expect(saveButtons()).toHaveLength(1);
  expect((saveButtons()[0] as HTMLButtonElement).disabled).toBe(true);

  fireEvent.click(row("Mid Three").getByRole("button", { name: "Sub" }));
  expect(savedButton()).toHaveLength(0);
  const save = saveButtons();
  expect(save).toHaveLength(2);
  expect((save[0] as HTMLButtonElement).disabled).toBe(false); // home: dirty and valid
  expect((save[1] as HTMLButtonElement).disabled).toBe(true); // away: still empty/invalid

  // Reverting the change restores the saved state without any save call.
  fireEvent.click(row("Mid Three").getByRole("button", { name: "Sub" }));
  expect(savedButton()).toHaveLength(1);
  expect(saveButtons()).toHaveLength(1);
  expect(fetch.mock.calls.filter(([url]) => String(url).endsWith("/lineup"))).toHaveLength(0);
});

it("enables Save for a valid XI/Sub reassignment, then turns green only after server confirmation, ignoring double clicks", async () => {
  const { fetch, puts } = server();
  vi.stubGlobal("fetch", fetch);
  render(<MatchPage params={paramsOf("m")} />);
  await screen.findByRole("button", { name: "Lineup Saved" });

  fireEvent.click(row("Keeper One").getByRole("button", { name: "Sub" })); // 4 starters → invalid
  expect(savedButton()).toHaveLength(0);
  expect((saveButtons()[0] as HTMLButtonElement).disabled).toBe(true);
  fireEvent.click(row("Keeper Two").getByRole("button", { name: "XI" })); // valid again, dirty
  const save = saveButtons()[0] as HTMLButtonElement;
  expect(save.disabled).toBe(false);

  fireEvent.click(save);
  fireEvent.click(save);
  const saved = (await screen.findAllByRole("button", { name: "Lineup Saved" }))[0] as HTMLButtonElement;
  expect(saved.disabled).toBe(true);
  expect(puts).toEqual([{ teamId: "home", starters: ["p1", "p2", "p3", "p4", "p5"].map((playerId, order) => ({ playerId, order })), subs: [{ playerId: "p0", order: 0 }] }]);
  expect(await screen.findByText("Line-up saved")).toBeTruthy();
});

it("keeps edits and the clickable state after a failed save, shows the error, and turns green on a successful retry", async () => {
  const { fetch, failNextSave } = server();
  vi.stubGlobal("fetch", fetch);
  render(<MatchPage params={paramsOf("m")} />);
  await screen.findByRole("button", { name: "Lineup Saved" });

  fireEvent.click(row("Mid Three").getByRole("button", { name: "Sub" }));
  failNextSave();
  fireEvent.click(saveButtons()[0]);
  expect(await screen.findByText("Could not save lineup: database unavailable")).toBeTruthy();
  expect(screen.getByText("Line-up not saved")).toBeTruthy();
  expect(savedButton()).toHaveLength(0); // no green state on failure
  const retry = saveButtons()[0] as HTMLButtonElement;
  expect(retry.disabled).toBe(false);
  expect(row("Mid Three").getByRole("button", { name: "Sub" }).getAttribute("aria-pressed")).toBe("true"); // edits preserved

  fireEvent.click(retry);
  expect((await screen.findAllByRole("button", { name: "Lineup Saved" }))[0]).toBeTruthy();
});

it("never shows the saved state before confirmation and blocks edits while a save is in flight", async () => {
  const srv = server();
  srv.holdNextPut();
  vi.stubGlobal("fetch", srv.fetch);
  render(<MatchPage params={paramsOf("m")} />);
  await screen.findByRole("button", { name: "Lineup Saved" });

  fireEvent.click(row("Mid Three").getByRole("button", { name: "Sub" }));
  fireEvent.click(saveButtons()[0]);
  await screen.findAllByText("Working…");
  expect(savedButton()).toHaveLength(0); // not green while unconfirmed
  expect((row("Mid One").getByRole("button", { name: "XI" }) as HTMLButtonElement).disabled).toBe(true);
  expect((row("Mid One").getByRole("button", { name: "Sub" }) as HTMLButtonElement).disabled).toBe(true);
  expect(srv.fetch.mock.calls.filter(([url]) => String(url).endsWith("/lineup"))).toHaveLength(1);

  // The server confirms; the green state appears only now and no second PUT fired.
  srv.releaseHeldPut(srv.rowsFor("home",
    ["p0", "p1", "p2", "p3", "p4"].map((playerId, order) => ({ playerId, order })),
    [{ playerId: "p5", order: 0 }, { playerId: "p6", order: 1 }]));
  expect((await screen.findAllByRole("button", { name: "Lineup Saved" }))[0]).toBeTruthy();
  expect(srv.puts).toHaveLength(1);
  expect(srv.fetch.mock.calls.filter(([url]) => String(url).endsWith("/lineup"))).toHaveLength(1);
});

it("keeps per-team baselines independent and restores both saved states after a refresh", async () => {
  const srv = server();
  vi.stubGlobal("fetch", srv.fetch);
  const page = render(<MatchPage params={paramsOf("m")} />);
  await screen.findByRole("button", { name: "Lineup Saved" });

  for (const name of ["Away Keeper", "Away Def", "Away Mid", "Away Mid Two", "Away Fwd"])
    fireEvent.click(row(name).getByRole("button", { name: "XI" }));
  expect(savedButton()).toHaveLength(1); // home still green while away is dirty
  fireEvent.click(saveButtons()[0]);
  await screen.findByText("Line-up saved"); // toast fires after confirmation + reload
  expect(savedButton()).toHaveLength(2);

  page.unmount();
  render(<MatchPage params={paramsOf("m")} />);
  expect(await screen.findAllByRole("button", { name: "Lineup Saved" })).toHaveLength(2); // refresh restores saved state
  expect(saveButtons()).toHaveLength(0);
});

it("loads each match's own baseline when switching between matches", async () => {
  const first = server({ matchId: "m1" });
  vi.stubGlobal("fetch", first.fetch);
  const page = render(<MatchPage params={paramsOf("m1")} />);
  expect(await screen.findAllByRole("button", { name: "Lineup Saved" })).toHaveLength(1);
  page.unmount();

  const second = server({ matchId: "m2", initial: [] });
  vi.stubGlobal("fetch", second.fetch);
  render(<MatchPage params={paramsOf("m2")} />);
  await screen.findByText("Keeper One");
  expect(savedButton()).toHaveLength(0); // no saved lineup for this match → no green state
  expect(saveButtons()).toHaveLength(2);
});

it("keeps the plain disabled button for viewers without the saved state", async () => {
  const { fetch } = server({ canOrganize: false });
  vi.stubGlobal("fetch", fetch);
  render(<MatchPage params={paramsOf("m")} />);
  await screen.findByText("Keeper One");
  expect(savedButton()).toHaveLength(0);
  const buttons = saveButtons() as HTMLButtonElement[];
  expect(buttons).toHaveLength(2);
  expect(buttons.every((b) => b.disabled)).toBe(true);
  expect((row("Keeper One").getByRole("button", { name: "XI" }) as HTMLButtonElement).disabled).toBe(true);
});
