// @vitest-environment jsdom
import React from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { SquadScreen } from "@/components/SquadScreen";
import { AppProvider } from "@/components/LeagueContext";
import { AppShell } from "@/components/AppShell";
import DashboardPage from "@/app/(app)/dashboard/page";
import type { PlayerPerformance, LatestPlayerGames } from "@/lib/player-performance";
import type { NextMatchLineup } from "@/lib/next-match-lineup";
import type { SquadResponse, PoolPlayer } from "@/lib/squad";
import type { SessionLeague, SessionPayload } from "@/lib/client/api";

const router = vi.hoisted(() => ({ replace: vi.fn(), push: vi.fn() }));
vi.mock("next/navigation", () => ({ useRouter: () => router, usePathname: () => "/team" }));
const league = (id: string, name: string, format: SessionLeague["format"], role: SessionLeague["role"]): SessionLeague => ({
  id, name, format, role, starters: format === "5v5" ? 5 : 7, subsCount: 1, teamName: null,
  rank: null, inviteCode: "ABC", totalPoints: null,
});
const a = league("league-a", "Morning League", "5v5", "leader");
const b = league("league-b", "Evening League", "7v7", "organizer");
const session: SessionPayload = { user: { id: "me", username: "testuser", displayName: "Test user", email: "me@example.com",
  avatarUrl: null, bio: null, emailVerified: true, createdAt: "2026-11-19" }, leagues: [a,b], unread: 0 };
const red = { id: "reds", leagueId: a.id, name: "Reds", shortName: null, crestUrl: null };
const blue = { ...red, id: "blues", name: "Blues" };
const player = (id: string, fullName: string, position: PoolPlayer["position"], team: string | null = null, status = "active"): PoolPlayer => ({
  id, fullName, position, leagueId: a.id, teamId: team, description: null, status,
  availability: status === "archived" ? "injured" : "available", shirtNumber: null, photoUrl: null,
});
const pool = [player("gk-a", "Ada Keeper", "GK", red.id), player("gk-b", "Zed Keeper", "GK", red.id),
  player("gk-c", "Bert Keeper", "GK", blue.id), player("gk-x", "Archived Keeper", "GK", blue.id, "archived"),
  player("def-a", "Dana Defender", "DEF", blue.id), player("mid-a", "Moe Midfielder", "MID", red.id),
  player("fwd-a", "Finn Forward", "FWD", blue.id),
  player("def-b", "Dee Defender", "DEF"), player("mid-b", "Max Midfielder", "MID"), player("fwd-b", "Fay Forward", "FWD"),
  { ...player("def-x", "Injured Defender", "DEF"), availability: "injured" }];
const empty = (l: SessionLeague): SquadResponse => ({ squad: null, players: [], vicePolicy: "auto_captain",
  rules: { format: l.format, starters: l.starters, subsCount: l.subsCount, squadSize: l.starters + 2 } });
const click = (name: string | RegExp) => fireEvent.click(screen.getByRole("button", { name }));
const dialog = () => within(screen.getByRole("dialog"));
function renderInShell(child: React.ReactNode = <SquadScreen />) {
  return render(<AppProvider initialSession={session}><AppShell>{child}</AppShell></AppProvider>);
}
let sequence = 0;
function fixture() {
  const saved = new Map([[a.id, empty(a)], [b.id, empty(b)]]);
  const put = vi.fn();
  const nextLineups = new Map<string, NextMatchLineup>();
  const putNext = vi.fn();
  const latest: LatestPlayerGames = {};
  const matchScores = new Map<string, LatestPlayerGames>();
  const histories = new Map<string, PlayerPerformance>();
  const historyError = new Set<string>();
  const older = new Map<string, PlayerPerformance>();
  const fetch = vi.fn(async (url: string, options?: RequestInit) => {
    if (url === "/api/auth/session") return Response.json(session);
    const parsed = new URL(url, "http://local.test");
    const [, , , leagueId, collection, playerId, action] = parsed.pathname.split("/");
    if (collection === "next-match-lineup") {
      const data = nextLineups.get(leagueId) ?? { previous: null, match: null, saved: null, serverNow: "2026-11-19T08:00:00Z" };
      if (options?.method !== "PUT") return Response.json(data);
      const body = JSON.parse(String(options.body));
      putNext(leagueId, body);
      if (!data.previous) return Response.json({ error: "No previous saved lineup" }, { status: 409 });
      const saved = { revision: "2026-11-19T08:00:01.000001+00:00", lineup: { ...data.previous.lineup, formation: body.formation, captainId: body.captainId, viceId: body.viceId,
        players: body.entries.map((e: { id: string; slot: string; order: number }) => ({ ...pool.find((p) => p.id === e.id), name: pool.find((p) => p.id === e.id)?.fullName, ...e })) } };
      nextLineups.set(leagueId, { ...data, ...(data.match && body.matchId === null ? { preparation: saved } : { saved }) });
      return Response.json({ matchId: body.matchId, ...saved });
    }
    if (collection === "player-performance") {
      const match = parsed.searchParams.get("match");
      const scores = (match && matchScores.get(match)) || latest;
      return Response.json(Object.fromEntries(parsed.searchParams.getAll("player")
        .filter((id) => scores[id] && (!match || scores[id].matchId === match)).map((id) => [id, scores[id]])));
    }
    if (collection === "players" && action === "performance") {
      if (historyError.has(playerId) || (parsed.searchParams.has("before") && historyError.has(`${playerId}:older`))) return Response.json({ error: "Could not load finalized games" }, { status: 500 });
      if (parsed.searchParams.has("before")) return Response.json(older.get(playerId));
      const p = pool.find((p) => p.id === playerId)!;
      return Response.json(histories.get(playerId) ?? { player: { name: p.fullName, position: p.position, team: p.teamId === red.id ? red.name : null, photoUrl: p.photoUrl }, games: [], next: null });
    }
    if (collection === "players") return Response.json(leagueId === a.id ? { players: pool, teams: [red,blue] } : { players: [], teams: [] });
    if (collection !== "squad") throw new Error(`Unexpected route ${url}`);
    const old = saved.get(leagueId)!;
    if (options?.method !== "PUT") return Response.json(old);
    const body = JSON.parse(String(options.body));
    put(leagueId, body);
    const next: SquadResponse = { ...old, squad: { id: `squad-${leagueId}`, formation: body.formation,
      captainId: body.captainId, viceCaptainId: body.viceCaptainId, completedAt: null,
      updatedAt: `2026-11-19T01:02:03.00000${++sequence}Z` },
      players: body.entries.map((e: { playerId: string; order: number; slot: string }) => {
        const p = pool.find((row) => row.id === e.playerId)!;
        return { ...p, name: p.fullName, order: e.order, slot: e.slot };
      }),
    };
    saved.set(leagueId, next);
    return Response.json({ state: "applied", ...next });
  });
  vi.stubGlobal("fetch", fetch);
  return { put, fetch, saved, latest, matchScores, histories, historyError, older, nextLineups, putNext };
}
afterEach(() => { cleanup(); window.localStorage.clear(); vi.unstubAllGlobals(); });

describe("squad screen HTTP contract", () => {
  it("shows every empty spot, filters eligible players, and saves captaincy and bench on reload", async () => {
    const { put, fetch } = fixture();
    const page = renderInShell();
    const pitch = within(await screen.findByRole("region", { name: "Starting lineup" }));
    expect(pitch.getAllByRole("button", { name: /^Add (GK|DEF|MID|FWD)/ })).toHaveLength(5);
    expect(fetch.mock.calls.some(([url]) => url.includes("/players"))).toBe(false);
    click("Add GK 1");
    await dialog().findByRole("button", { name: /Ada Keeper/ });
    expect(dialog().queryByRole("button", { name: /Dana Defender/ })).toBeNull();
    const sort = dialog().getByRole("combobox", { name: "Sort players" });
    fireEvent.change(sort, { target: { value: "reverse" } });
    expect(dialog().getAllByRole("button", { name: /Keeper/ })[0].textContent).toContain("Zed");
    fireEvent.change(dialog().getByRole("combobox", { name: "Real team" }), { target: { value: blue.id } });
    expect(dialog().queryByText("Ada Keeper")).toBeNull();
    expect((dialog().getByRole("button", { name: /Archived Keeper/ }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.change(dialog().getByRole("searchbox"), { target: { value: "Bert" } });
    fireEvent.click(dialog().getByRole("button", { name: /Bert Keeper/ }));
    click(/Bert Keeper, GK/); click("Make captain");
    click("Pick bench goalkeeper");
    expect((await dialog().findByRole("button", { name: /Bert Keeper.*Selected/ }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(dialog().getByRole("button", { name: /Zed Keeper/ }));
    fireEvent.click(screen.getAllByRole("button", { name: "Save draft" })[0]);
    expect(await screen.findByText("Squad draft saved.")).toBeTruthy();
    expect(put).toHaveBeenCalledWith(a.id, expect.objectContaining({ captainId: "gk-c", entries: expect.arrayContaining([
      expect.objectContaining({ playerId: "gk-b", slot: "sub", order: 0 }),
    ]) }));
    page.unmount();
    renderInShell();
    expect(await screen.findByRole("button", { name: "Bert Keeper, GK, captain" })).toBeTruthy();
    expect(screen.getByRole("button", { name: /Zed Keeper/ })).toBeTruthy();
  });

  it.each([
    ["GK", "Ada Keeper", "Zed Keeper", "gk-b", 0],
    ["DEF", "Dana Defender", "Dee Defender", "def-b", 1],
    ["MID", "Moe Midfielder", "Max Midfielder", "mid-b", 2],
    ["FWD", "Finn Forward", "Fay Forward", "fwd-b", 3],
  ])("replaces %s with only eligible same-position players and persists in the same slot", async (pos, oldName, newName, newId, order) => {
    const { put, saved } = fixture();
    const players = [0,4,5,6,2].map((index, i) => ({ ...pool[index], name: pool[index].fullName,
      slot: (i === 4 ? "sub" : "starter") as "sub" | "starter", order: i === 4 ? 0 : i }));
    saved.set(a.id, { ...empty(a), squad: { id: "existing", formation: "1-2-1", captainId: "gk-a", viceCaptainId: "def-a",
      updatedAt: "2026-11-19T01:02:03Z", completedAt: null }, players });
    const page = renderInShell();
    fireEvent.click(await screen.findByRole("button", { name: "Edit squad" }));
    click(new RegExp(`${oldName}, ${pos}`)); click("Replace player");
    const replacement = await dialog().findByRole("button", { name: new RegExp(newName) });
    for (const p of pool.filter((p) => p.fullName !== newName)) expect(dialog().queryByRole("button", { name: new RegExp(p.fullName) })).toBeNull();
    fireEvent.change(dialog().getByRole("searchbox"), { target: { value: "does-not-exist" } });
    expect(dialog().getByText(/No available, unselected players/)).toBeTruthy();
    fireEvent.change(dialog().getByRole("searchbox"), { target: { value: "" } });
    expect(replacement.textContent).toContain(pos);
    fireEvent.click(dialog().getByRole("button", { name: new RegExp(newName) }));
    expect((screen.getByRole("combobox", { name: "Formation" }) as HTMLSelectElement).value).toBe("1-2-1");
    fireEvent.click(screen.getAllByRole("button", { name: "Save draft" })[0]);
    expect(await screen.findByText("Squad draft saved.")).toBeTruthy();
    expect(put).toHaveBeenCalledWith(a.id, expect.objectContaining({ formation: "1-2-1", entries: expect.arrayContaining([
      { playerId: newId, slot: "starter", order }, ...players.filter((p) => p.name !== oldName).map((p) => ({ playerId: p.id, slot: p.slot, order: p.order })),
    ]) }));
    page.unmount(); renderInShell();
    expect(await screen.findByRole("button", { name: new RegExp(`${newName}, ${pos}`) })).toBeTruthy();
    expect(screen.queryByRole("button", { name: new RegExp(`${oldName}, ${pos}`) })).toBeNull();
  });

  it("keeps the bench keeper first and persists outfield priority plus a finalized substitution report", async () => {
    const { saved, put } = fixture();
    const players = [0,1,5,6].map((index, i) => ({ ...pool[index], name: pool[index].fullName,
      slot: (i ? "sub" : "starter") as "sub" | "starter", order: i ? i - 1 : 0 }));
    const data = { ...empty(a), rules: { ...empty(a).rules, subsCount: 3, squadSize: 10 }, players,
      squad: { id: "saved", formation: "1-2-1", captainId: null, viceCaptainId: null, updatedAt: "2026-11-19T01:02:03Z", completedAt: null },
      recentSubs: [{ matchId: "m1", title: "Previous match", substitutions: [{ outId: "gk-a", inId: "gk-b", outName: "Ada Keeper", inName: "Zed Keeper", position: "GK" as const, priority: 0 }] }] };
    saved.set(a.id, data);
    const page = renderInShell();
    await screen.findByText("Recent automatic substitutions");
    expect(screen.getByText("replaced").parentElement?.textContent).toBe("Zed Keeper replaced Ada Keeper");
    click("Edit squad"); click("Raise Finn Forward priority");
    fireEvent.click(screen.getAllByRole("button", { name: "Save draft" })[0]);
    await screen.findByText("Squad draft saved.");
    expect(put).toHaveBeenCalledWith(a.id, expect.objectContaining({ entries: expect.arrayContaining([
      { playerId: "gk-b", slot: "sub", order: 0 }, { playerId: "fwd-a", slot: "sub", order: 1 }, { playerId: "mid-a", slot: "sub", order: 2 },
    ]) }));
    page.unmount(); renderInShell();
    await screen.findByRole("region", { name: "Starting lineup" });
    const rows = within(screen.getByRole("region", { name: "Starting lineup" })).getAllByRole("listitem");
    expect(rows.map((row) => row.textContent)).toEqual([expect.stringContaining("Zed Keeper"), expect.stringContaining("Finn Forward"), expect.stringContaining("Moe Midfielder")]);
  });

  it("switches leagues without carrying edits or creating squads and remembers the choice", async () => {
    const { put } = fixture();
    const page = renderInShell();
    await screen.findByRole("region", { name: "Starting lineup" });
    click("Add GK 1");
    fireEvent.click(await dialog().findByRole("button", { name: /Ada Keeper/ }));
    const switcher = screen.getByRole("combobox", { name: "Active league" });
    fireEvent.change(switcher, { target: { value: b.id } });
    const pitch = within(await screen.findByRole("region", { name: "Starting lineup" }));
    expect(pitch.getAllByRole("button", { name: /^Add (GK|DEF|MID|FWD)/ })).toHaveLength(7);
    expect(pitch.queryByText("Ada Keeper")).toBeNull();
    expect(screen.queryByRole("link", { name: "Manage players & teams" })).toBeNull();
    click("More");
    const mobileNav = within(screen.getByRole("navigation", { name: "More navigation" }));
    for (const label of ["Player pool", "Fixtures", "Members", "League settings", "My leagues"]) {
      expect(mobileNav.getByRole("link", { name: label })).toBeTruthy();
    }
    page.unmount();
    renderInShell();
    expect((await screen.findByRole("combobox", { name: "Active league" }) as HTMLSelectElement).value).toBe(b.id);
    expect(put).not.toHaveBeenCalled();
  });

  it("keeps failed saves visible, offers reload, and never shows success", async () => {
    const { fetch } = fixture();
    const send = fetch.getMockImplementation()!;
    fetch.mockImplementation((url, init) => init?.method === "PUT" ? Promise.resolve(Response.json({ error: "Squad changed. Reload." }, { status: 409 })) : send(url, init));
    renderInShell();
    fireEvent.click(await screen.findByRole("button", { name: "Add GK 1" }));
    fireEvent.click(await dialog().findByRole("button", { name: /Ada Keeper/ }));
    fireEvent.click(screen.getAllByRole("button", { name: "Save draft" })[0]);
    expect(await screen.findByText("Squad changed. Reload.")).toBeTruthy();
    expect(screen.queryByText("Squad draft saved.")).toBeNull();
    click("Discard changes & reload");
    expect(await screen.findByRole("button", { name: "Add GK 1" })).toBeTruthy();
  });
});

it("refreshes the dashboard's selected-league Last Game Points without replacing standings totals", async () => {
  let aScore: number | null = null;
  vi.stubGlobal("fetch", vi.fn(async (url: string) => {
    if (url === "/api/auth/session") return Response.json(session);
    const l = url.endsWith(b.id) ? b : a;
    return Response.json({ league: { ...l, squadSize: 9 }, squad: null,
      standings: [{ profileId: "me", rank: 1, totalPoints: "45", matchesPlayed: 3, displayName: "Test user" }],
      myRank: 1, lastGame: l === a ? { matchId: "match-a", title: "Morning final", points: aScore } : null,
      fixtures: [], matches: [], notifications: [], rulesApproved: true, emailVerified: true, memberCount: 2 });
  }));
  renderInShell(<DashboardPage />);
  expect(await screen.findByText("Last Game Points")).toBeTruthy();
  expect(screen.getByText("Morning final · No score")).toBeTruthy();
  aScore = 0;
  fireEvent.focus(window);
  expect(await screen.findByText("Morning final")).toBeTruthy();
  expect(within(screen.getByText("Last Game Points").parentElement!).getByText("0")).toBeTruthy();
  expect(screen.getByText("45")).toBeTruthy();
  fireEvent.change(screen.getByRole("combobox", { name: "Active league" }), { target: { value: b.id } });
  expect(await screen.findByText("No finalized game yet")).toBeTruthy();
  expect(screen.queryByText("Morning final")).toBeNull();
});

it("previews real starters, captaincy and substitutes, refreshes an edited squad, and renders the other league's empty pitch", async () => {
  const make = (p: PoolPlayer, slot: "starter" | "sub", order: number) => ({ ...p, slot, order, name: p.fullName });
  const photoUrl = "/api/leagues/league-a/players/gk-a/photo?v=photo.jpg";
  let players = [make({ ...pool[0], photoUrl }, "starter", 0), make(pool[4], "starter", 1), make(pool[5], "sub", 0)];
  vi.stubGlobal("fetch", vi.fn(async (url: string) => {
    if (url === "/api/auth/session") return Response.json(session);
    if (url.includes("/player-performance?")) return Response.json({ "gk-a": { matchId: "game-a", points: 8 } });
    const l = url.endsWith(b.id) ? b : a;
    return Response.json({ league: { ...l, squadSize: 9 }, squad: l === a ? { formation: "1-2-1", captainId: "gk-a", viceCaptainId: "def-a", players } : null,
      standings: [], myRank: null, lastGame: null, fixtures: [], matches: [], notifications: [], rulesApproved: true, emailVerified: true, memberCount: 1 });
  }));
  renderInShell(<DashboardPage />);
  const pitch = within(await screen.findByRole("region", { name: "5v5 football pitch, formation 1-2-1" }));
  expect(pitch.getAllByRole("img", { name: /^Empty/ })).toHaveLength(3);
  expect(pitch.getByRole("button", { name: "Ada Keeper, GK, captain" }).querySelector("img")?.getAttribute("src")).toBe(photoUrl);
  expect(pitch.getByRole("button", { name: "Dana Defender, DEF, vice-captain" }).textContent).toContain("VC");
  expect(await pitch.findByText("8 pts")).toBeTruthy();
  expect(pitch.queryByText("Moe Midfielder")).toBeNull();
  expect(screen.getByText("Moe Midfielder")).toBeTruthy();
  expect(screen.getByRole("link", { name: "View Full Squad" }).getAttribute("href")).toBe("/team");
  players = [make(pool[1], "starter", 0), ...players.slice(1)];
  fireEvent(window, new StorageEvent("storage", { key: `ff:league-content-changed:${a.id}` }));
  expect(await pitch.findByRole("button", { name: "Zed Keeper, GK" })).toBeTruthy();
  expect(pitch.queryByText("Ada Keeper")).toBeNull();
  fireEvent.change(screen.getByRole("combobox", { name: "Active league" }), { target: { value: b.id } });
  const other = within(await screen.findByRole("region", { name: /7v7 football pitch/ }));
  expect(other.getAllByRole("img", { name: /^Empty/ })).toHaveLength(7);
  expect(screen.getByRole("link", { name: "Pick Your Squad" }).getAttribute("href")).toBe("/team/pick");
});

it("shows individual points on the pitch and bench and keeps the separate official team total above the squad", async () => {
  const { saved, fetch, latest, histories, historyError, put } = fixture();
  saved.set(a.id, { ...empty(a), squad: { id: "s-a", formation: "1-2-1", captainId: "gk-a", viceCaptainId: null, completedAt: null, updatedAt: "2026-11-01T12:00:00Z" },
    players: [{ ...pool[0], slot: "starter", name: pool[0].fullName, order: 0 }, { ...pool[1], slot: "sub", name: pool[1].fullName, order: 0 },
      { ...pool[4], slot: "starter", name: pool[4].fullName, order: 1 }] });
  latest["gk-a"] = { matchId: "match-8", title: "Cup match", kickOff: "2026-11-19T10:00:00Z", points: 8, captainPoints: 16 };
  histories.set("gk-a", { player: { name: "Ada Keeper", position: "GK", team: "Reds", photoUrl: "https://example.com/keeper.jpg" }, next: null, games: [
    { matchId: "match-8", kickOff: "2026-11-19T10:00:00Z", title: "Cup match", gameweek: 8, opponent: "Blues", participation: "played", points: 8,
      breakdown: [{ category: "penalty_saved", label: "Penalty saved", count: 1, pointsPer: 5, points: 5 }, { category: "assist", label: "Assist", count: 1, pointsPer: 3, points: 3 }] },
    { matchId: "match-3", kickOff: "2026-11-03T10:00:00Z", title: "Opening match", gameweek: 3, opponent: null, participation: "played", points: 0, breakdown: [] },
  ] });
  histories.set("gk-b", { player: { name: "Zed Keeper", position: "GK", team: "Reds", photoUrl: null }, next: null, games: [
    { matchId: "match-9", title: "Late match", kickOff: "2026-11-20T10:00:00Z", gameweek: null, opponent: null, points: null, participation: "did_not_play", breakdown: [] },
  ] });
  const page = renderInShell();
  const starter = await screen.findByRole("button", { name: "Ada Keeper, GK, captain" });
  const bench = screen.getByRole("button", { name: /Zed Keeper/ });
  expect(await within(starter).findByText("8 pts")).toBeTruthy();
  expect(within(starter).getByText("C: 16 pts")).toBeTruthy();
  expect(within(screen.getByRole("button", {name:"Dana Defender, DEF"})).getByText("—")).toBeTruthy();
  expect(within(bench).getByText("—")).toBeTruthy();
  expect(fetch.mock.calls.filter(([url]) => url.includes("/player-performance?")).map(([url]) => url.split("?")[1]))
    .toEqual(["player=def-a&player=gk-a&player=gk-b"]);
  expect(fetch.mock.calls.some(([url]) => url.endsWith("/performance"))).toBe(false);
  const region = await screen.findByRole("region", { name: "Points" });
  const summary = within(region);
  expect(region.compareDocumentPosition(screen.getByRole("region", {name:"Starting lineup"})) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  expect(summary.getByText("No finalized match yet")).toBeTruthy();
  const lastMatch = { matchId: "match-8", title: "Cup match", kickOff: "2026-11-19T10:00:00Z", points: 27.5 };
  const refresh = (points: number | null) => {
    saved.set(a.id, { ...saved.get(a.id)!, lastMatch: { ...lastMatch, points } });
    fireEvent(window, new StorageEvent("storage", {key: `ff:league-content-changed:${a.id}`}));
  };
  refresh(null);
  expect(await summary.findByText("No squad score recorded")).toBeTruthy();
  refresh(0);
  expect(await summary.findByText("0 pts")).toBeTruthy();
  latest["def-a"] = { ...latest["gk-a"], points: 0, captainPoints: undefined };
  latest["gk-b"] = { ...latest["gk-a"], points: 4, captainPoints: undefined };
  refresh(lastMatch.points);
  expect(await summary.findByText("27.5 pts")).toBeTruthy();
  expect(await within(screen.getByRole("button", {name:"Dana Defender, DEF"})).findByText("0 pts")).toBeTruthy();
  expect(await within(bench).findByText("4 pts")).toBeTruthy();
  expect(summary.getByText(/Cup match/).querySelector("time")?.dateTime).toBe(lastMatch.kickOff);
  expect(summary.queryByText(/Ada Keeper|Zed Keeper/)).toBeNull();
  expect(summary.queryByRole("list")).toBeNull();
  starter.focus(); fireEvent.click(starter);
  const history = within(await screen.findByRole("region", { name: "Finalized match history" }));
  expect(await history.findByText("Cup match · GW 8")).toBeTruthy();
  expect(history.getAllByRole("listitem").filter((li) => li.parentElement?.tagName === "OL").map((li) => li.querySelector("summary")?.textContent))
    .toEqual([expect.stringContaining("Cup match"), expect.stringContaining("Opening match")]);
  expect(history.getByText("0 pts")).toBeTruthy();
  expect(dialog().getByText("Reds")).toBeTruthy();
  expect(await dialog().findByText("16 pts (C ×2)")).toBeTruthy();
  const cupSummary = history.getByText("Cup match · GW 8").closest("summary")!;
  fireEvent.click(cupSummary);
  expect(cupSummary.closest("details")?.open).toBe(true);
  expect(history.getByText("Penalty saved")).toBeTruthy();
  click("Close dialog");
  expect(document.activeElement).toBe(starter);
  fireEvent.click(bench);
  expect(await screen.findByText("Did not play")).toBeTruthy();
  expect(dialog().queryByText("0 pts")).toBeNull();
  click("Close dialog");
  historyError.add("def-a");
  click(/Dana Defender, DEF/);
  expect(await screen.findByText("Could not load finalized games")).toBeTruthy();
  historyError.delete("def-a");
  click("Retry");
  expect(await screen.findByText("No finalized games yet.")).toBeTruthy();
  expect(put).not.toHaveBeenCalled();
  page.unmount(); renderInShell();
  expect(await within(await screen.findByRole("region", {name:"Points"})).findByText("27.5 pts")).toBeTruthy();
  click("Ada Keeper, GK, captain");
  expect(await screen.findByText("Cup match · GW 8")).toBeTruthy();
});


it("loads older history only on demand and retries without losing the latest games", async () => {
  const { saved, histories, historyError, older, fetch } = fixture();
  saved.set(a.id, { ...empty(a), players: [{ ...pool[0], name: pool[0].fullName, slot: "starter", order: 0 }] });
  const player = { name: pool[0].fullName, position: "GK" as const, team: null, photoUrl: null };
  const first = { matchId: "latest", kickOff: "2026-11-19T12:34:56.123456+00:00", title: "Most recent game", gameweek: null,
    opponent: null, participation: "played" as const, points: 5, breakdown: [] };
  histories.set(pool[0].id, { player, games: [first], next: { matchId: first.matchId, kickOff: first.kickOff } });
  older.set(pool[0].id, { player, next: null, games: [{ ...first, matchId: "old", title: "Older game", kickOff: "2026-11-02T12:00:00Z" }] });
  historyError.add(`${pool[0].id}:older`);
  renderInShell();
  fireEvent.click(await screen.findByRole("button", { name: "Ada Keeper, GK" }));
  expect(await screen.findByText("Most recent game")).toBeTruthy();
  expect(fetch.mock.calls.some(([url]) => url.includes("before="))).toBe(false);
  click("Load older games");
  expect(await screen.findByRole("button", { name: "Retry older games" })).toBeTruthy();
  expect(screen.getByText("Most recent game")).toBeTruthy();
  historyError.delete(`${pool[0].id}:older`);
  click("Retry older games");
  expect(await screen.findByText("Older game")).toBeTruthy();
  expect(screen.queryByRole("button", { name: "Load older games" })).toBeNull();
  const url = new URL(fetch.mock.calls.filter(([url]) => url.includes("before=")).at(-1)![0], "http://local.test");
  expect(url.searchParams.get("before")).toBe(first.kickOff);
  expect(url.searchParams.get("match")).toBe(first.matchId);
});

it("shows a countdown, locks at kickoff, and disables edit actions without sending a write", async () => {
  const { saved, put } = fixture();
  const serverNow = "2026-11-19T18:00:00.000Z";
  saved.set(a.id, { ...empty(a), deadline: { serverNow, kickOff: "2026-11-19T18:00:00.900Z", locked: false, title: "Cup match", matchId: "cup" } });
  renderInShell(<SquadScreen editInitially />);
  expect(await screen.findByText("00:00:01")).toBeTruthy();
  expect(await screen.findByText("Squad Locked.", {}, { timeout: 3000 })).toBeTruthy();
  expect(screen.queryByRole("button", { name: /^Save draft$/ })).toBeNull();
  expect(screen.queryByRole("button", { name: /^Add GK/ })).toBeNull();
  expect((screen.getByRole("button", { name: "Pick bench goalkeeper" }) as HTMLButtonElement).disabled).toBe(true);
  expect(put).not.toHaveBeenCalled();
});

it("adds a separate demo entry when enabled without showing Next Match for the live squad", async () => {
  const { saved, put } = fixture();
  saved.set(a.id, { ...empty(a), players: [{ ...pool[0], name: pool[0].fullName, slot: "starter", order: 0 }] });
  const page = renderInShell();
  await screen.findByRole("button", { name: "Edit squad" });
  expect(screen.queryByRole("link", { name: "Lineup design preview" })).toBeNull();
  page.unmount();
  renderInShell(<SquadScreen showLineupPreview />);
  await screen.findByRole("button", { name: "Edit squad" });
  const preview = screen.getByRole("link", { name: "Lineup design preview" });
  expect(preview.getAttribute("href")).toBe("/team/next-match-preview?from=squad");
  expect(screen.queryByRole("link", { name: "Next match" })).toBeNull();
  expect(put).not.toHaveBeenCalled();
});


it("gates the real Next Match view on verified history and saves a separate lineup only on explicit confirmation", async () => {
  const { fetch, saved, nextLineups, putNext, put } = fixture();
  const entries = [pool[0], pool[4], pool[5], pool[6], pool[8], pool[1]].map((p, order) => ({ ...p, name: p.fullName,
    slot: order === 5 ? "sub" as const : "starter" as const, order: order === 5 ? 0 : order }));
  saved.set(a.id, { ...empty(a), players: [entries[0]] });
  const page = renderInShell(<SquadScreen enableNextMatch />);
  await screen.findByRole("button", { name: "Edit squad" });
  await act(async () => {});
  expect(fetch).toHaveBeenCalledWith(`/api/leagues/${a.id}/next-match-lineup`, expect.objectContaining({ method: "GET" }));
  expect(screen.queryByText("No previous lineup yet")).toBeNull();
  expect(screen.queryByText(/Next Match appears once your saved starting lineup/)).toBeNull();
  expect(screen.queryByRole("button", { name: "Next Match" })).toBeNull();
  page.unmount();
  const previous = { matchId: "played-match", title: "Previous fixture", kickOff: "2026-11-18T19:00:00Z",
    lineup: { players: entries, formation: "1-2-1", captainId: entries[1].id, viceId: entries[2].id } };
  nextLineups.set(a.id, { serverNow: "2026-11-19T08:00:00Z", previous, saved: null,
    match: { id: "target-match", title: "Next fixture", kickOff: "2026-11-19T09:00:00Z", locked: false } });
  renderInShell(<SquadScreen enableNextMatch />);
  fireEvent.click(await screen.findByRole("button", { name: "Next Match" }));
  expect(screen.getByRole("heading", { name: "Next Match Lineup" })).toBeTruthy();
  expect((screen.getByRole("combobox", { name: "Captain" }) as HTMLSelectElement).value).toBe(entries[1].id);
  expect(putNext).not.toHaveBeenCalled();
  fireEvent.change(screen.getByRole("combobox", { name: "Captain" }), { target: { value: entries[0].id } });
  click("Edit Squad");
  expect(screen.getByRole("heading", { name: "Edit squad" })).toBeTruthy();
  click("Next Match");
  expect((screen.getByRole("combobox", { name: "Captain" }) as HTMLSelectElement).value).toBe(entries[0].id);
  expect(putNext).not.toHaveBeenCalled();
  click("Save changes");
  expect(await screen.findByText("Lineup saved for this match only.")).toBeTruthy();
  expect(putNext).toHaveBeenCalledWith(a.id, expect.objectContaining({ matchId: "target-match", captainId: entries[0].id, expectedUpdatedAt: null }));
  expect(nextLineups.get(a.id)?.previous?.lineup.captainId).toBe(entries[1].id);
  expect(put).not.toHaveBeenCalled();
});

it.each([false, true])("prepares a player swap with no future fixture (locked fixture present: %s) and leaves My Squad alone", async (hasLockedFixture) => {
  const { saved, nextLineups, putNext, put } = fixture();
  const entries = [pool[0], pool[4], pool[5], pool[6], pool[8], pool[1]].map((p, order) => ({ ...p, name: p.fullName,
    slot: order === 5 ? "sub" as const : "starter" as const, order: order === 5 ? 0 : order }));
  saved.set(a.id, { ...empty(a), players: entries });
  nextLineups.set(a.id, { serverNow: "2026-11-19T08:00:00Z", canPrepare: true, saved: null,
    match: hasLockedFixture ? { id: "locked-match", title: "Match awaiting result", kickOff: "2026-11-19T07:00:00Z", locked: true } : null,
    previous: { matchId: "played-match", title: "Previous fixture", kickOff: "2026-11-18T19:00:00Z",
      lineup: { players: entries, formation: "1-2-1", captainId: entries[1].id, viceId: entries[2].id } } });
  const page = renderInShell(<SquadScreen enableNextMatch />);
  fireEvent.click(await screen.findByRole("button", { name: "Next Match" }));
  if (hasLockedFixture) {
    expect((screen.getByRole("button", { name: "Save changes" }) as HTMLButtonElement).disabled).toBe(true);
    click("Prepare next lineup");
  }
  expect(screen.getByRole("heading", { name: "No next match scheduled" })).toBeTruthy();
  expect(screen.queryByRole("timer")).toBeNull();
  const pitch = () => within(screen.getByRole("region", { name: /football pitch/ }));
  fireEvent.click(pitch().getByRole("button", { name: /Ada Keeper/ }));
  fireEvent.click(within(screen.getByRole("dialog")).getByRole("button", { name: "Zed Keeper · Bench" }));
  expect(pitch().getByRole("button", { name: /Zed Keeper/ })).toBeTruthy();
  expect(putNext).not.toHaveBeenCalled();
  click("Save next lineup");
  await screen.findByText("Lineup prepared. My Squad is unchanged.");
  expect(putNext).toHaveBeenCalledWith(a.id, expect.objectContaining({ matchId: null, expectedUpdatedAt: null,
    entries: expect.arrayContaining([{ id: entries[5].id, slot: "starter", order: 0 }]) }));
  expect(put).not.toHaveBeenCalled();
  click("Edit Squad");
  fireEvent.click(screen.getAllByRole("button", { name: "Cancel" })[0]);
  expect(pitch().getByRole("button", { name: /Ada Keeper/ })).toBeTruthy();
  expect(pitch().queryByRole("button", { name: /Zed Keeper/ })).toBeNull();
  page.unmount();
  renderInShell(<SquadScreen enableNextMatch />);
  fireEvent.click(await screen.findByRole("button", { name: "Next Match" }));
  if (hasLockedFixture) click("Prepare next lineup");
  expect(pitch().getByRole("button", { name: /Zed Keeper/ })).toBeTruthy();
  expect(screen.getByText("Prepared for the next fixture")).toBeTruthy();
});

function nextMatchEditFixture(kind: "scheduled" | "unscheduled" | "locked") {
  const result = fixture();
  const entries = [pool[0], pool[4], pool[5], pool[6], pool[8]].map((p, order) => ({ ...p, name: p.fullName,
    slot: "starter" as const, order }));
  result.saved.set(a.id, { ...empty(a), players: entries, squad: { id: "default", formation: "1-2-1",
    captainId: entries[1].id, viceCaptainId: entries[2].id, completedAt: null, updatedAt: "2026-11-18T18:00:00Z" },
    ...(kind === "locked" ? { deadline: { matchId: "played", title: "Played fixture",
      kickOff: "2026-11-19T07:00:00Z", serverNow: "2026-11-19T08:00:00Z", locked: true } } : {}) });
  const previous = { matchId: "previous", title: "Previous fixture", kickOff: "2026-11-18T19:00:00Z",
    lineup: { players: entries, formation: "1-2-1", captainId: entries[1].id, viceId: entries[2].id } };
  const match = kind === "scheduled" ? { id: "scheduled", title: "Scheduled fixture", kickOff: "2026-11-19T09:00:00Z", locked: false }
    : kind === "locked" ? { id: "played", title: "Played fixture", kickOff: "2026-11-19T07:00:00Z", locked: true } : null;
  result.nextLineups.set(a.id, { serverNow: "2026-11-19T08:00:00Z", previous, saved: null, match, canPrepare: kind !== "scheduled" });
  return { ...result, entries };
}

it.each(["scheduled", "unscheduled", "locked"] as const)("saves edits made in My Team only to the next-match draft (%s)", async (kind) => {
  const { saved, put, nextLineups, putNext } = nextMatchEditFixture(kind);
  renderInShell(<SquadScreen enableNextMatch />);
  await waitFor(() => expect((screen.getByRole("button", { name: "Edit squad" }) as HTMLButtonElement).disabled).toBe(false));
  click("Edit squad");
  expect(screen.getByRole("heading", { name: "Edit squad" })).toBeTruthy();
  expect(screen.queryByRole("heading", { name: "Next Match Lineup" })).toBeNull();
  click(/Ada Keeper, GK/);
  click("Replace player");
  fireEvent.click(await dialog().findByRole("button", { name: /Zed Keeper/ }));
  expect(putNext).not.toHaveBeenCalled();
  expect(put).not.toHaveBeenCalled();
  fireEvent.click(screen.getAllByRole("button", { name: "Save for next match" })[0]);
  await screen.findByText("Lineup saved for the next match only. My Squad is unchanged.");
  expect(put).not.toHaveBeenCalled();
  expect(putNext).toHaveBeenCalledOnce();
  expect(putNext).toHaveBeenCalledWith(a.id, expect.objectContaining({ matchId: kind === "scheduled" ? "scheduled" : null,
    expectedUpdatedAt: null, entries: expect.arrayContaining([{ id: "gk-b", slot: "starter", order: 0 }]) }));
  expect(screen.getByRole("button", { name: /Ada Keeper, GK/ })).toBeTruthy();
  expect(saved.get(a.id)?.players[0].id).toBe("gk-a");
  expect(nextLineups.get(a.id)?.previous?.lineup.players[0].id).toBe("gk-a");
  click("Next Match");
  if (kind === "locked") click("Prepare next lineup");
  const pitch = within(screen.getByRole("region", { name: /football pitch/ }));
  expect(await pitch.findByRole("button", { name: /Zed Keeper/ })).toBeTruthy();
  click("Edit Squad");
  expect(screen.getByRole("button", { name: /Zed Keeper, GK/ })).toBeTruthy();
  fireEvent.click(screen.getAllByRole("button", { name: "Save for next match" })[0]);
  await waitFor(() => expect(putNext).toHaveBeenLastCalledWith(a.id, expect.objectContaining({ expectedUpdatedAt: "2026-11-19T08:00:01.000001+00:00" })));
  await screen.findByText("Lineup saved for the next match only. My Squad is unchanged.");
  expect(put).not.toHaveBeenCalled();
});

it("still saves an initial default squad if the manager has no verified lineup", async () => {
  const { put, putNext } = fixture();
  renderInShell(<SquadScreen enableNextMatch editInitially />);
  fireEvent.click(await screen.findByRole("button", { name: "Add GK 1" }));
  fireEvent.click(await dialog().findByRole("button", { name: /Ada Keeper/ }));
  fireEvent.click(screen.getAllByRole("button", { name: "Save draft" })[0]);
  await screen.findByText("Squad draft saved.");
  expect(put).toHaveBeenCalledOnce();
  expect(putNext).not.toHaveBeenCalled();
  expect(screen.queryByRole("button", { name: "Next Match" })).toBeNull();
});

it("does not retarget a dirty Edit Squad preparation when a match is scheduled", async () => {
  const { nextLineups, put, putNext } = nextMatchEditFixture("unscheduled");
  renderInShell(<SquadScreen enableNextMatch />);
  await waitFor(() => expect((screen.getByRole("button", { name: "Edit squad" }) as HTMLButtonElement).disabled).toBe(false));
  click("Edit squad");
  click(/Ada Keeper, GK/);
  click("Make captain");
  nextLineups.set(a.id, { ...nextLineups.get(a.id)!, canPrepare: false,
    match: { id: "new-fixture", title: "New fixture", kickOff: "2026-11-19T09:00:00Z", locked: false } });
  await act(async () => { window.dispatchEvent(new Event("focus")); });
  await screen.findByText(/next-match target has changed or locked/);
  for (const button of screen.getAllByRole<HTMLButtonElement>("button", { name: "Save for next match" })) {
    expect(button.disabled).toBe(true);
    fireEvent.click(button);
  }
  expect(put).not.toHaveBeenCalled();
  expect(putNext).not.toHaveBeenCalled();
});

it("shows the actual previous starting lineup even when the default squad and saved next-match draft differ", async () => {
  const { saved, nextLineups, entries, put, putNext, latest } = nextMatchEditFixture("scheduled");
  const prior = nextLineups.get(a.id)!.previous!;
  const baseline = { ...pool[2], name: pool[2].fullName, slot: "starter" as const, order: 0 };
  saved.set(a.id, { ...saved.get(a.id)!, players: [baseline, ...entries.slice(1)],
    lastMatch: { matchId: prior.matchId, title: prior.title, kickOff: prior.kickOff, points: 31 } });
  latest[entries[0].id] = { matchId: prior.matchId, title: prior.title, kickOff: prior.kickOff, points: 7 };
  latest[entries[1].id] = { matchId: "other-game", title: "Other game", kickOff: prior.kickOff, points: 99 };
  const page = renderInShell(<SquadScreen enableNextMatch />);
  const previousPitch = () => within(screen.getByRole("region", { name: "Previous match starting lineup" }));
  await screen.findByRole("region", { name: "Previous match starting lineup" });
  expect(previousPitch().getByRole("link", { name: prior.title }).getAttribute("href")).toBe(`/matches/${prior.matchId}`);
  expect(previousPitch().getByRole("button", { name: /Ada Keeper/ })).toBeTruthy();
  expect(previousPitch().queryByRole("button", { name: /Bert Keeper/ })).toBeNull();
  expect(await previousPitch().findByText("7 pts")).toBeTruthy();
  expect(previousPitch().queryByText("99 pts")).toBeNull();
  expect(within(screen.getByRole("region", { name: "Points" })).getByText("31 pts")).toBeTruthy();
  click("View default squad");
  expect(within(screen.getByRole("region", { name: "Default starting lineup" })).getByRole("button", { name: /Bert Keeper/ })).toBeTruthy();
  click("View previous lineup");
  click("Edit squad");
  const draft = within(screen.getByRole("region", { name: "Next match starters" }));
  fireEvent.click(draft.getByRole("button", { name: /Ada Keeper/ }));
  click("Replace player");
  fireEvent.click(await dialog().findByRole("button", { name: /Zed Keeper/ }));
  expect(draft.getByRole("button", { name: /Zed Keeper/ })).toBeTruthy();
  expect(putNext).not.toHaveBeenCalled();
  expect(put).not.toHaveBeenCalled();
  fireEvent.click(screen.getAllByRole("button", { name: "Save for next match" })[0]);
  await screen.findByText("Lineup saved for the next match only. My Squad is unchanged.");
  expect(put).not.toHaveBeenCalled();
  expect(nextLineups.get(a.id)?.previous?.lineup).toEqual(prior.lineup);
  expect(previousPitch().getByRole("button", { name: /Ada Keeper/ })).toBeTruthy();
  expect(previousPitch().queryByRole("button", { name: /Zed Keeper/ })).toBeNull();
  page.unmount();
  renderInShell(<SquadScreen enableNextMatch />);
  await screen.findByRole("region", { name: "Previous match starting lineup" });
  expect(previousPitch().getByRole("button", { name: /Ada Keeper/ })).toBeTruthy();
  click("Next Match");
  expect(within(screen.getByRole("region", { name: /football pitch/ })).getByRole("button", { name: /Zed Keeper/ })).toBeTruthy();
});

it("replaces the previous lineup with the locked match lineup and counts its points from zero", async () => {
  const { saved, nextLineups, entries, latest } = nextMatchEditFixture("locked");
  const previous = nextLineups.get(a.id)!.previous!;
  saved.set(a.id, { ...saved.get(a.id)!, lastMatch: { matchId: previous.matchId, title: previous.title, kickOff: previous.kickOff, points: 31 } });
  // The locked fixture used its own saved lineup: Bert Keeper started instead of Ada Keeper.
  const lockedEntries = entries.map((entry) => entry.id === "gk-a"
    ? { ...pool[2], name: pool[2].fullName, slot: "starter" as const, order: 0 } : entry);
  nextLineups.set(a.id, { ...nextLineups.get(a.id)!, inPlay: { matchId: "played", title: "Played fixture",
    kickOff: "2026-11-19T07:00:00Z", source: "saved",
    lineup: { players: lockedEntries, formation: "1-2-1", captainId: entries[1].id, viceId: entries[2].id } } });
  renderInShell(<SquadScreen enableNextMatch />);
  const lockedPitch = within(await screen.findByRole("region", { name: "Starting lineup" }));
  expect(screen.queryByRole("region", { name: "Previous match starting lineup" })).toBeNull();
  expect(lockedPitch.getByRole("link", { name: "Played fixture" }).getAttribute("href")).toBe("/matches/played");
  expect(lockedPitch.getByText(/Locked · Read-only/)).toBeTruthy();
  expect(lockedPitch.getByRole("button", { name: /Bert Keeper/ })).toBeTruthy();
  expect(lockedPitch.queryByRole("button", { name: /Ada Keeper/ })).toBeNull();
  const card = within(await screen.findByRole("region", { name: "Points" }));
  expect(card.getByText(/Played fixture/)).toBeTruthy();
  expect(card.getByText("0 pts")).toBeTruthy();
  expect(card.getByText(/updates with every event/)).toBeTruthy();
  expect(card.queryByText("31 pts")).toBeNull();
  // Every event adds to the provisional total for the match in play.
  saved.set(a.id, { ...saved.get(a.id)!, liveMatches: [{ matchId: "played", title: "Played fixture",
    kickOff: "2026-11-19T07:00:00Z", points: 9 }] });
  latest["gk-a"] = { matchId: "played", title: "Played fixture", kickOff: "2026-11-19T07:00:00Z", points: 9, provisional: true };
  fireEvent(window, new StorageEvent("storage", { key: `ff:league-content-changed:${a.id}` }));
  expect(await card.findByText("9 pts")).toBeTruthy();
  expect(screen.queryByRole("region", { name: "Live match points" })).toBeNull();
});

it("shows the default squad in play when the locked match had no saved lineup", async () => {
  const { saved, nextLineups, entries } = nextMatchEditFixture("locked");
  const lockedEntries = entries.map((entry) => entry.id === "gk-a"
    ? { ...pool[2], name: pool[2].fullName, slot: "starter" as const, order: 0 } : entry);
  saved.set(a.id, { ...saved.get(a.id)!, players: lockedEntries });
  nextLineups.set(a.id, { ...nextLineups.get(a.id)!, inPlay: { matchId: "played", title: "Played fixture",
    kickOff: "2026-11-19T07:00:00Z", source: "default",
    lineup: { players: lockedEntries, formation: "1-2-1", captainId: entries[1].id, viceId: entries[2].id } } });
  renderInShell(<SquadScreen enableNextMatch />);
  const lockedPitch = within(await screen.findByRole("region", { name: "Starting lineup" }));
  expect(lockedPitch.getByRole("button", { name: /Bert Keeper/ })).toBeTruthy();
  expect(lockedPitch.queryByRole("button", { name: /Ada Keeper/ })).toBeNull();
  expect(within(screen.getByRole("region", { name: "Points" })).getByText("0 pts")).toBeTruthy();
  click("View default squad");
  expect(within(screen.getByRole("region", { name: "Default starting lineup" })).getByRole("button", { name: /Bert Keeper/ })).toBeTruthy();
  click("View locked lineup");
  expect(within(screen.getByRole("region", { name: "Starting lineup" })).getByRole("button", { name: /Bert Keeper/ })).toBeTruthy();
});

it("does not present the default starters as match history when a result has no verified lineup", async () => {
  const { saved, nextLineups, put, putNext } = nextMatchEditFixture("unscheduled");
  nextLineups.set(a.id, { ...nextLineups.get(a.id)!, previous: null, canPrepare: false });
  saved.set(a.id, { ...saved.get(a.id)!, lastMatch: { matchId: "result", title: "Finalized fixture", kickOff: null, points: 12 } });
  renderInShell(<SquadScreen enableNextMatch />);
  expect(await screen.findByText("No verified lineup saved for Finalized fixture.")).toBeTruthy();
  expect(screen.queryByRole("region", { name: "Previous match starting lineup" })).toBeNull();
  expect(within(screen.getByRole("region", { name: "Default starting lineup" })).getByRole("button", { name: /Ada Keeper/ })).toBeTruthy();
  click("Edit squad");
  click(/Ada Keeper, GK/);
  click("Replace player");
  fireEvent.click(await dialog().findByRole("button", { name: /Zed Keeper/ }));
  fireEvent.click(screen.getAllByRole("button", { name: "Save draft" })[0]);
  await waitFor(() => expect(put).toHaveBeenCalledOnce());
  expect(putNext).not.toHaveBeenCalled();
});

it("refreshes provisional squad totals after a scoring event is added and removed without changing the previous lineup", async () => {
  const { saved, nextLineups, latest, matchScores } = nextMatchEditFixture("scheduled");
  const previous = nextLineups.get(a.id)!.previous!;
  const lastMatch = { matchId: previous.matchId, title: previous.title, kickOff: previous.kickOff, points: 31 };
  saved.set(a.id, { ...saved.get(a.id)!, lastMatch });
  matchScores.set(previous.matchId, { "gk-a": { matchId: previous.matchId, title: previous.title, kickOff: previous.kickOff, points: 7 } });
  renderInShell(<SquadScreen enableNextMatch />);
  const previousPitch = () => within(screen.getByRole("region", { name: "Previous match starting lineup" }));
  await screen.findByRole("region", { name: "Previous match starting lineup" });
  expect(await previousPitch().findByText("7 pts")).toBeTruthy();
  const sync = () => fireEvent(window, new StorageEvent("storage", { key: `ff:league-content-changed:${a.id}` }));
  const liveMatch = { matchId: "scheduled", title: "Live fixture", kickOff: "2026-11-19T09:00:00Z", points: 10 };
  saved.set(a.id, { ...saved.get(a.id)!, liveMatches: [liveMatch] });
  latest["gk-a"] = { ...liveMatch, points: 5, provisional: true };
  sync();
  const live = within(await screen.findByRole("region", { name: "Live match points" }));
  expect(live.getByText("10 pts")).toBeTruthy();
  expect(previousPitch().queryByText("5 pts")).toBeNull();
  expect(previousPitch().getByText("7 pts")).toBeTruthy();
  click("Next Match");
  const nextPitch = within(screen.getByRole("region", { name: /football pitch/ }));
  expect(await nextPitch.findByText("5 pts")).toBeTruthy();
  expect(nextPitch.getByText("Live")).toBeTruthy();
  saved.set(a.id, { ...saved.get(a.id)!, liveMatches: [] });
  delete latest["gk-a"];
  sync();
  await waitFor(() => expect(nextPitch.queryByText("5 pts")).toBeNull());
  // The collapsed My Squad screen (including official points) is still mounted.
  expect(screen.queryByText("10 pts")).toBeNull();
  expect(screen.getByText("31 pts")).toBeTruthy();
});
