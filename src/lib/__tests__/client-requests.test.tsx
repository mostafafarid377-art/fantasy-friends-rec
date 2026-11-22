// @vitest-environment jsdom
import React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, waitFor } from "@testing-library/react";
import { AppProvider } from "@/components/LeagueContext";
import { AppShell } from "@/components/AppShell";
import DashboardPage from "@/app/(app)/dashboard/page";
import StandingsPage from "@/app/(app)/standings/page";
import PointsPage from "@/app/(app)/points/page";
import HistoryPage from "@/app/(app)/history/page";

const router = vi.hoisted(() => ({ replace: vi.fn(), push: vi.fn() }));
vi.mock("next/navigation", () => ({
  useRouter: () => router,
  usePathname: () => "/dashboard",
  useSearchParams: () => new URLSearchParams(),
  useParams: () => ({}),
  redirect: vi.fn(),
  notFound: vi.fn(),
}));

const league = {
  id: "league-a", name: "Morning League", format: "5v5" as const, role: "leader" as const,
  starters: 5, subsCount: 1, teamName: "XI", rank: 1, inviteCode: "ABC", totalPoints: null,
};
const session = {
  user: { id: "me", username: "tester", displayName: "Test", email: "me@example.test", avatarUrl: null, bio: null, emailVerified: true, createdAt: "2026-11-19" },
  leagues: [league], unread: 0,
};

const bodies: Record<string, unknown> = {
  "/api/dashboard": {
    league: { id: league.id, name: league.name, format: "5v5", starters: 5, subsCount: 1, squadSize: 7, inviteCode: "ABC", role: "leader" },
    squad: { id: "squad-1", formation: "2-2-1", captainId: "p1", viceCaptainId: "p2", size: 7, starters: 5, subs: 1, complete: true,
      players: Array.from({ length: 7 }, (_, i) => ({ id: `p${i + 1}`, slot: i < 5 ? "starter" : "sub", order: i, name: `Player ${i + 1}`,
        position: "MID", status: "active", teamId: null, shirtNumber: null, availability: "available",
        photoUrl: `/api/leagues/league-a/players/p${i + 1}/photo?v=aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee` })) },
    standings: [{ profileId: "me", rank: 1, prevRank: 2, totalPoints: 10, matchesPlayed: 2, displayName: "Test", teamName: "XI" }],
    myRank: 1, lastGame: { matchId: "m1", title: "M1", points: 5 }, liveMatches: [],
    latestPlayerGames: { p1: { matchId: "m1", title: "M1", kickOff: "2026-11-19T08:00:00Z", points: 6 } },
    provisional: false, fixtures: [], matches: [], notifications: [], rulesApproved: true, memberCount: 2, emailVerified: true,
  },
  "/api/leagues/league-a/standings": { provisional: false, standings: [], history: [], you: "me" },
  "/api/leagues/league-a/points": { approvedRules: true, rows: [], matches: [] },
  "/api/matches": { total: 0, hasMore: false, matches: [] },
  "/api/auth/session": session,
};

let calls: string[] = [];

beforeEach(() => {
  calls = [];
  vi.stubGlobal("fetch", vi.fn(async (url: string) => {
    const path = String(url);
    calls.push(path);
    const key = Object.keys(bodies).find((k) => path.startsWith(k));
    return Response.json(key ? bodies[key] : {});
  }));
});

afterEach(() => { cleanup(); vi.useRealTimers(); vi.unstubAllGlobals(); });

function renderInShell(child: React.ReactNode) {
  return render(<AppProvider initialSession={session}><AppShell>{child}</AppShell></AppProvider>);
}

/** Waits until the page has settled, then reports the requests it made. */
async function requestsOf(child: React.ReactNode) {
  cleanup();
  calls = [];
  renderInShell(child);
  await waitFor(() => expect(calls.length).toBeGreaterThan(0));
  await new Promise((resolve) => setTimeout(resolve, 150));
  return [...calls];
}

describe("client request boundaries", () => {
  it("loads the dashboard with a single request", async () => {
    const requests = await requestsOf(<DashboardPage />);
    expect(requests).toEqual(["/api/dashboard?leagueId=league-a"]);
  });

  it("never asks for the squad player points in a second request", async () => {
    const requests = await requestsOf(<DashboardPage />);
    expect(requests.some((url) => url.includes("/player-performance"))).toBe(false);
  });

  it("loads the standings table with a single request", async () => {
    const requests = await requestsOf(<StandingsPage />);
    expect(requests).toEqual(["/api/leagues/league-a/standings"]);
  });

  it("loads the points screen with a single request", async () => {
    const requests = await requestsOf(<PointsPage />);
    expect(requests).toEqual(["/api/leagues/league-a/points"]);
  });

  it("keeps the history screen on its two parallel requests", async () => {
    const requests = await requestsOf(<HistoryPage />);
    expect(requests.sort()).toEqual([
      "/api/leagues/league-a/standings",
      "/api/matches?leagueId=league-a&status=approved&page=1",
    ]);
  });
});
