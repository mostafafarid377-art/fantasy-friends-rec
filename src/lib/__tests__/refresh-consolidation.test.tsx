// @vitest-environment jsdom
import React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import { AppProvider } from "@/components/LeagueContext";
import { AppShell } from "@/components/AppShell";
import DashboardPage from "@/app/(app)/dashboard/page";
import StandingsPage from "@/app/(app)/standings/page";
import { SquadScreen } from "@/components/SquadScreen";

/**
 * Refresh regression tests.
 *
 * The app used to attach its own focus listener and its own polling timer on
 * every page, which multiplied requests. One coordinator now drives every
 * view: a single focus listener, a single poll timer, and one refresh per
 * view per trigger.
 */
const router = vi.hoisted(() => ({ replace: vi.fn(), push: vi.fn() }));
vi.mock("next/navigation", () => ({ useRouter: () => router, usePathname: () => "/dashboard" }));

const league = {
  id: "league-a", name: "Morning League", format: "5v5" as const, role: "leader" as const,
  starters: 5, subsCount: 1, teamName: null, rank: 1, inviteCode: "ABC", totalPoints: null,
};
const session = {
  user: { id: "me", username: "tester", displayName: "Test", email: "me@example.test", avatarUrl: null, bio: null, emailVerified: true, createdAt: "2026-11-19" },
  leagues: [league], unread: 0,
};

const bodies: Record<string, unknown> = {
  "/api/dashboard": {
    league: { id: league.id, name: league.name, format: "5v5", starters: 5, subsCount: 1, squadSize: 7, inviteCode: "ABC", role: "leader" },
    squad: null, standings: [], myRank: 1, lastGame: null, fixtures: [], matches: [], notifications: [],
    rulesApproved: true, memberCount: 2, emailVerified: true,
  },
  "/api/leagues/league-a/standings": { provisional: false, standings: [], history: [], ledger: [], you: "me" },
  "/api/leagues/league-a/squad": { squad: null, players: [], rules: { format: "5v5", starters: 5, subsCount: 1, squadSize: 7 }, vicePolicy: "auto_captain", deadline: null, lastMatch: null, liveMatches: [] },
  "/api/leagues/league-a/next-match-lineup": { serverNow: "2026-11-19T08:00:00Z", previous: null, match: null, saved: null },
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

describe("refresh coordination", () => {
  it("loads every view with a single request", async () => {
    renderInShell(<DashboardPage />);
    await screen.findByText("Matchday HQ");
    expect(calls).toEqual(["/api/dashboard?leagueId=league-a"]);

    cleanup();
    calls = [];
    renderInShell(<StandingsPage />);
    await waitFor(() => expect(calls.length).toBeGreaterThan(0));
    expect(calls).toEqual(["/api/leagues/league-a/standings"]);

    cleanup();
    calls = [];
    renderInShell(<SquadScreen enableNextMatch />);
    await waitFor(() => expect(calls.length).toBeGreaterThan(0));
    expect(calls.sort()).toEqual(["/api/leagues/league-a/next-match-lineup", "/api/leagues/league-a/squad"]);
  });

  it("installs a single focus listener for the whole app", async () => {
    const addEventListener = vi.spyOn(window, "addEventListener");
    renderInShell(<DashboardPage />);
    await screen.findByText("Matchday HQ");
    expect(addEventListener.mock.calls.filter(([type]) => type === "focus")).toHaveLength(1);
    addEventListener.mockRestore();
  });

  it("refreshes the view and the session once when the tab regains focus", async () => {
    renderInShell(<DashboardPage />);
    await screen.findByText("Matchday HQ");
    calls = [];

    await act(async () => { window.dispatchEvent(new Event("focus")); });
    await waitFor(() => expect(calls.length).toBe(2));
    expect(calls.sort()).toEqual(["/api/auth/session", "/api/dashboard?leagueId=league-a"]);
  });

  it("does not repeat a refresh that just ran", async () => {
    renderInShell(<DashboardPage />);
    await screen.findByText("Matchday HQ");
    calls = [];

    await act(async () => {
      window.dispatchEvent(new Event("focus"));
      window.dispatchEvent(new Event("focus"));
    });
    await waitFor(() => expect(calls.length).toBe(2));
  });

  it("refreshes every open view once when the tab regains focus", async () => {
    renderInShell(<SquadScreen enableNextMatch />);
    await waitFor(() => expect(calls.length).toBe(2));
    calls = [];

    await act(async () => { window.dispatchEvent(new Event("focus")); });
    await waitFor(() => expect(calls.length).toBe(3));
    expect(calls.sort()).toEqual([
      "/api/auth/session",
      "/api/leagues/league-a/next-match-lineup",
      "/api/leagues/league-a/squad",
    ]);
  });

  it("polls each view on its own interval and keeps a just-polled view fresh", async () => {
    vi.useFakeTimers();
    renderInShell(<SquadScreen enableNextMatch />);
    await act(async () => {});
    expect(calls).toHaveLength(2);

    calls = [];
    await act(async () => { await vi.advanceTimersByTimeAsync(10000); });
    expect(calls).toEqual(["/api/leagues/league-a/squad"]);

    calls = [];
    await act(async () => { await vi.advanceTimersByTimeAsync(5000); });
    expect(calls).toEqual(["/api/leagues/league-a/next-match-lineup"]);

    // The next match was polled a moment ago, so a focus event must not ask
    // for it again, while the views that are older still refresh.
    calls = [];
    await act(async () => { window.dispatchEvent(new Event("focus")); });
    expect(calls.sort()).toEqual(["/api/auth/session", "/api/leagues/league-a/squad"]);
  });
});
