import { beforeEach, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import { GET as latest } from "@/app/api/leagues/[id]/player-performance/route";
import { GET as performance } from "@/app/api/leagues/[id]/players/[playerId]/performance/route";

const db = vi.hoisted(() => ({ from: vi.fn(), rpc: vi.fn(), getUser: vi.fn() }));
vi.mock("@/db", () => ({ getSupabase: async () => ({ ...db, auth: { getUser: db.getUser } }) }));
const params = Promise.resolve({ id: "league-a", playerId: "player-a" });
const request = (query = "") => new NextRequest(`http://local.test/${query}`);
const filters = vi.fn();
let member: object | null, player: object | null;
const profile = { full_name: "Keeper", position: "GK", photo_url: "https://example.com/photo.jpg", teams: { id: "home", name: "Home", crest_url: "https://example.com/home.webp" } };
const date = "2026-11-19T12:34:56.012345+00:00";
beforeEach(() => {
  vi.resetAllMocks();
  member = { role: "manager", leagues: { id: "league-a" } };
  player = profile;
  db.getUser.mockResolvedValue({ data: { user: { id: "member" } }, error: null });
  db.rpc.mockResolvedValue({ data: [], error: null });
  db.from.mockImplementation((table) => ({
    select() { return this; }, eq(...args: unknown[]) { filters(table, ...args); return this; },
    maybeSingle() { return { data: table === "league_members" ? member : player, error: null }; },
  }));
});

it("batches player IDs, returns official match/date and zero points, and keeps captain points separate", async () => {
  db.rpc.mockResolvedValue({ data: [{ player_id: "player-a", match_id: "match-a", title: "Home v Away", kick_off: date, points: "0.00", captain_points: "0.00" }], error: null });
  const res = await latest(request("?player=player-a&player=player-b&player=player-a"), { params });
  expect(res.headers.get("cache-control")).toBe("private, no-store");
  expect(await res.json()).toEqual({ "player-a": { matchId: "match-a", title: "Home v Away", kickOff: date, points: 0, captainPoints: 0 } });
  expect(db.rpc).toHaveBeenCalledExactlyOnceWith("ff_latest_display_player_points", { p_league: "league-a", p_players: ["player-a", "player-b"], p_match: null });
  expect(db.from).not.toHaveBeenCalledWith("players");
  expect((await latest(request(`?${Array.from({ length: 16 }, (_, i) => `player=${i}`).join("&")}`), { params })).status).toBe(422);
});

it("returns the scoped profile and first 20 finalized rows, preserving event breakdown and cursor precision", async () => {
  const breakdown = [{ category: "penalty_saved", count: 1, pointsPer: 5, points: 5 }];
  db.rpc.mockResolvedValue({ data: Array.from({ length: 21 }, (_, i) => ({ match_id: `match-${i}`, title: `Match ${i}`, kick_off: date,
    gameweek: i, opponent: "Visitors", opponent_id: "away", opponent_crest: "https://example.com/away.webp", participation: i ? "did_not_play" : "played", points: i ? null : "5.00", breakdown: i ? null : breakdown })), error: null });
  const res = await performance(request(), { params });
  const json = await res.json();
  expect(res.headers.get("cache-control")).toBe("private, no-store");
  expect(filters).toHaveBeenCalledWith("players", "league_id", "league-a");
  expect(filters).toHaveBeenCalledWith("players", "id", "player-a");
  expect(json.player).toEqual({ name: profile.full_name, team: "Home", teamLogo: "https://example.com/home.webp", position: "GK", photoUrl: profile.photo_url });
  expect(json.games).toHaveLength(20);
  expect(json.games[0]).toEqual({ matchId: "match-0", title: "Match 0", kickOff: date, gameweek: 0, opponent: "Visitors", opponentLogo: "https://example.com/away.webp",
    participation: "played", points: 5, breakdown: [{ ...breakdown[0], label: "Penalty saved" }] });
  expect(json.games[1]).toMatchObject({ participation: "did_not_play", points: null, breakdown: [] });
  expect(json.next).toEqual({ kickOff: date, matchId: "match-19" });
  db.rpc.mockResolvedValue({ data: [], error: null });
  const query = new URLSearchParams({ before: json.next.kickOff, match: json.next.matchId });
  expect(await (await performance(request(`?${query}`), { params })).json()).toMatchObject({ games: [], next: null });
  expect(db.rpc).toHaveBeenLastCalledWith("player_finalized_games_with_logos", { p_league: "league-a", p_player: "player-a", p_limit: 21,
    p_before_kickoff: date, p_before_match: "match-19" });
  expect((await performance(request("?before=invalid"), { params })).status).toBe(422);
});

it("denies unauthorized history and distinguishes missing players, no games and read failures", async () => {
  member = null;
  expect((await latest(request("?player=player-a"), { params })).status).toBe(403);
  expect((await performance(request(), { params })).status).toBe(403);
  expect(db.rpc).not.toHaveBeenCalled();
  member = { role: "manager", leagues: { id: "league-a" } };
  player = null;
  expect((await performance(request(), { params })).status).toBe(404);
  player = profile;
  expect(await (await performance(request(), { params })).json()).toMatchObject({ games: [], next: null });
  db.rpc.mockResolvedValue({ data: null, error: { code: "42501", message: "Permission denied" } });
  expect((await performance(request(), { params })).status).toBe(403);
  expect((await latest(request("?player=player-a"), { params })).status).toBe(403);
});

it("marks live point totals and keeps them separate from finalized player history", async () => {
  const line = { category: "goal", count: 1, pointsPer: 5, points: 5 };
  const row = { player_id: "player-a", match_id: "live-a", title: "Live game", kick_off: date, points: "5.00", captain_points: "10.00", provisional: true, breakdown: [line] };
  db.rpc.mockImplementation(async (name) => ({ data: name === "player_finalized_games_with_logos" ? [] : [row], error: null }));
  expect(await (await latest(request("?player=player-a&match=live-a"), { params })).json()).toEqual({
    "player-a": { matchId: "live-a", title: "Live game", kickOff: date, points: 5, captainPoints: 10, provisional: true },
  });
  expect(db.rpc).toHaveBeenCalledWith("ff_latest_display_player_points", { p_league: "league-a", p_players: ["player-a"], p_match: "live-a" });
  expect(await (await performance(request(), { params })).json()).toMatchObject({
    games: [], liveGames: [{ matchId: "live-a", points: 5, provisional: true, breakdown: [{ ...line, label: "Goal" }] }], next: null,
  });
});
