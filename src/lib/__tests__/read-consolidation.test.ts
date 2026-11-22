import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import {
  createInstrumentedClient,
  dispatchedTogether,
  readNames,
  type InstrumentedClient,
} from "./helpers/instrumented-client";

const state = vi.hoisted(() => ({ client: null as any }));

vi.mock("@/db", () => ({ getSupabase: async () => state.client }));

import { GET as dashboardGET } from "@/app/api/dashboard/route";
import { GET as standingsGET } from "@/app/api/leagues/[id]/standings/route";
import { GET as matchGET } from "@/app/api/matches/[id]/route";
import { GET as pointsGET } from "@/app/api/leagues/[id]/points/route";
import { GET as squadGET } from "@/app/api/leagues/[id]/squad/route";

const league = { id: "league-a", name: "Alpha", format: "5v5", starters: 5, subs_count: 2,
  squad_size: 8, invite_code: "CODE", vice_policy: "auto_captain" };
const membershipSingle = { role: "leader", leagues: league, profiles: { email_verified_at: "2026-01-01T00:00:00Z" } };
const matchRow = { id: "match-a", league_id: "league-a", status: "approved", version: 1, team_a_id: "team-a",
  team_b_id: "team-b", kick_off: "2026-02-01T18:00:00Z", duration_minutes: 90, organizer_id: "me", fixture_id: null,
  submitted_by: "me", submitted_at: null, decided_by: null, decided_at: null, rejection_reason: null,
  home_score: 2, away_score: 1 };
const lastGame = { matchId: "match-a", title: "Match A", kickOff: "2026-02-01T18:00:00Z", points: 5 };

function fixture() {
  return {
    tables: {
      league_members: [{ profile_id: "me", role: "leader", team_name: "Team Me", profiles: { username: "me", display_name: "Me", avatar_url: null } }],
      fantasy_squads: [],
      fantasy_fixtures: [{ id: "fx-1", title: "GW1", gameweek: 1, scheduled_at: "2026-02-01T18:00:00Z", status: "scheduled" }],
      real_matches: [{ id: "match-a", title: "Match A", status: "approved", kick_off: "2026-02-01T18:00:00Z", match_events: [{ count: 3 }] }],
      notifications: [{ id: "n-1", title: "Hi", body: "There", read_at: null, created_at: "2026-02-01T18:00:00Z" }],
      scoring_rules: [{ status: "approved" }],
      match_lineups: [], match_events: [], match_substitutions: [], match_approvals: [],
      teams: [{ id: "team-a", league_id: "league-a", name: "Team A", short_name: "TA", crest_url: null }],
      players: [], match_player_statistics: [], player_match_points: [], match_scoring_lineups: [],
      fantasy_points_history: [], manager_points: [], fantasy_squad_players: [],
    },
    singles: {
      league_members: membershipSingle,
      fantasy_squads: { id: "squad-a", formation: "1-2-1", captain_id: "p-1", vice_captain_id: null, completed_at: null, fantasy_squad_players: [] },
      real_matches: matchRow,
    },
    rpcs: {
      ff_display_standings: [{ profile_id: "me", rank: 1, prev_rank: 2, total_points: 10, matches_played: 3, form: [], provisional: false, live_points: 0, profiles: { display_name: "Me", username: "me", avatar_url: null } }],
      ff_my_live_match_points: [],
      ff_display_player_points: [],
      ff_my_latest_display_player_points: [{ player_id: "p-1", match_id: "match-a", title: "Match A", kick_off: "2026-02-01T18:00:00Z", points: 7, captain_points: 14, provisional: false }],
      last_game_points: [lastGame],
      ff_squad_deadline: { locked: false, kickOff: null, matchId: null, title: null, serverNow: "2026-02-01T17:00:00Z" },
      recent_fantasy_substitutions: [],
    },
    counts: { league_members: 1 },
  };
}

let instrumented: InstrumentedClient;
beforeEach(() => {
  instrumented = createInstrumentedClient(fixture());
  state.client = instrumented.client;
});

const standingsCtx = { params: Promise.resolve({ id: "league-a" }) };
const matchCtx = { params: Promise.resolve({ id: "match-a" }) };

describe("read consolidation", () => {
  it("loads the standings table, the history and the members in one round trip", async () => {
    const res = await standingsGET(new NextRequest("http://local.test/api/leagues/league-a/standings"), standingsCtx);
    expect(res.status).toBe(200);
    expect(readNames(instrumented.reads)).toEqual([
      "table:league_members", "rpc:ff_display_standings", "table:fantasy_points_history", "table:league_members",
    ]);
    // The member read must not wait for the standings and history to answer.
    expect(dispatchedTogether(instrumented.reads, [
      "rpc:ff_display_standings", "table:fantasy_points_history", "table:league_members",
    ])).toBe(true);
  });

  it("never reads the manager points ledger that no screen shows", async () => {
    const res = await standingsGET(new NextRequest("http://local.test/api/leagues/league-a/standings"), standingsCtx);
    expect(readNames(instrumented.reads)).not.toContain("table:manager_points");
    expect(await res.json()).not.toHaveProperty("ledger");
  });

  it("keeps the team name and the role on every standings row", async () => {
    const res = await standingsGET(new NextRequest("http://local.test/api/leagues/league-a/standings"), standingsCtx);
    expect((await res.json()).standings).toEqual([{
      profileId: "me", rank: 1, prevRank: 2, totalPoints: 10, livePoints: 0, matchesPlayed: 3, form: [],
      username: "me", displayName: "Me", avatarUrl: null, teamName: "Team Me", role: "leader",
    }]);
  });

  it("reads only the approval state of the scoring rules", async () => {
    const res = await pointsGET(new NextRequest("http://local.test/api/leagues/league-a/points"), standingsCtx);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.approvedRules).toBe(true);
    // The rule values themselves are not used by the screen.
    expect(body).not.toHaveProperty("rules");
  });

  it("reads the kickoff of the last match from the same snapshot as its points", async () => {
    const res = await squadGET(new NextRequest("http://local.test/api/leagues/league-a/squad"), standingsCtx);
    expect(res.status).toBe(200);
    expect((await res.json()).lastMatch).toEqual({
      matchId: "match-a", title: "Match A", kickOff: "2026-02-01T18:00:00Z", points: 5,
    });
    // No second lookup of the match may be needed for its date.
    expect(readNames(instrumented.reads).filter((n) => n === "table:real_matches")).toHaveLength(0);
  });

  it("keeps every squad read in a single batch", async () => {
    await squadGET(new NextRequest("http://local.test/api/leagues/league-a/squad"), standingsCtx);
    expect(readNames(instrumented.reads)).toEqual([
      "table:league_members", "table:fantasy_squads", "rpc:recent_fantasy_substitutions",
      "rpc:ff_squad_deadline", "rpc:last_game_points", "rpc:ff_my_live_match_points",
    ]);
    expect(dispatchedTogether(instrumented.reads, [
      "table:fantasy_squads", "rpc:recent_fantasy_substitutions", "rpc:ff_squad_deadline",
      "rpc:last_game_points", "rpc:ff_my_live_match_points",
    ])).toBe(true);
  });

  it("ships the latest points of the squad players with the dashboard", async () => {
    const res = await dashboardGET(new NextRequest("http://local.test/api/dashboard?leagueId=league-a"));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.latestPlayerGames).toEqual({
      "p-1": { matchId: "match-a", title: "Match A", kickOff: "2026-02-01T18:00:00Z", points: 7, captainPoints: 14 },
    });
    // The dashboard used to leave this to a second request.
    expect(readNames(instrumented.reads)).toContain("rpc:ff_my_latest_display_player_points");
  });

  it("keeps the last game of the dashboard unchanged", async () => {
    const res = await dashboardGET(new NextRequest("http://local.test/api/dashboard?leagueId=league-a"));
    expect((await res.json()).lastGame).toEqual({ matchId: "match-a", title: "Match A", points: 5 });
  });

  it("keeps the match detail reads in one batch", async () => {
    const res = await matchGET(new NextRequest("http://local.test/api/matches/match-a"), matchCtx);
    expect(res.status).toBe(200);
    expect(dispatchedTogether(instrumented.reads, [
      "table:match_lineups", "table:match_events", "table:match_substitutions", "table:match_approvals",
      "table:teams", "table:players", "table:match_player_statistics",
    ])).toBe(true);
  });
});
