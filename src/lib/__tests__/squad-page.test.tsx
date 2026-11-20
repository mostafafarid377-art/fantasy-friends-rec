// @vitest-environment jsdom
import React from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { SquadScreen } from "@/components/SquadScreen";
import { AppProvider } from "@/components/LeagueContext";
import { AppShell } from "@/components/AppShell";
import DashboardPage from "@/app/(app)/dashboard/page";
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
  const fetch = vi.fn(async (url: string, options?: RequestInit) => {
    if (url === "/api/auth/session") return Response.json(session);
    const [, leagueId, collection] = /\/leagues\/([^/]+)\/([^?]+)/.exec(url) ?? [];
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
  return { put, fetch, saved };
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
    const l = url.endsWith(b.id) ? b : a;
    return Response.json({ league: { ...l, squadSize: 9 }, squad: l === a ? { formation: "1-2-1", captainId: "gk-a", viceCaptainId: "def-a", players } : null,
      standings: [], myRank: null, lastGame: null, fixtures: [], matches: [], notifications: [], rulesApproved: true, emailVerified: true, memberCount: 1 });
  }));
  renderInShell(<DashboardPage />);
  const pitch = within(await screen.findByRole("region", { name: "5v5 football pitch, formation 1-2-1" }));
  expect(pitch.getAllByRole("img")).toHaveLength(5);
  expect(pitch.getByRole("img", { name: "Ada Keeper, GK, captain" }).querySelector("img")?.getAttribute("src")).toBe(photoUrl);
  expect(pitch.getByRole("img", { name: "Dana Defender, DEF, vice-captain" }).textContent).toContain("VC");
  expect(pitch.queryByText("Moe Midfielder")).toBeNull();
  expect(screen.getByText("Moe Midfielder")).toBeTruthy();
  expect(screen.getByRole("link", { name: "View Full Squad" }).getAttribute("href")).toBe("/team");
  players = [make(pool[1], "starter", 0), ...players.slice(1)];
  fireEvent(window, new StorageEvent("storage", { key: `ff:league-content-changed:${a.id}` }));
  expect(await pitch.findByRole("img", { name: "Zed Keeper, GK" })).toBeTruthy();
  expect(pitch.queryByText("Ada Keeper")).toBeNull();
  fireEvent.change(screen.getByRole("combobox", { name: "Active league" }), { target: { value: b.id } });
  const other = within(await screen.findByRole("region", { name: /7v7 football pitch/ }));
  expect(other.getAllByRole("img", { name: /^Empty/ })).toHaveLength(7);
  expect(screen.getByRole("link", { name: "Pick Your Squad" }).getAttribute("href")).toBe("/team/pick");
});
