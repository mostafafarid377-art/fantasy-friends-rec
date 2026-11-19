// @vitest-environment jsdom
import React from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import PlayersPage from "@/app/(app)/players/page";

vi.mock("@/components/LeagueContext", () => ({
  useActiveLeague: () => ({ league: { id: "league-a", name: "Test League" }, loading: false }),
  useLeague: () => ({ isLeader: true }),
}));

const team = { id: "team-a", name: "Saturday Reds", leagueId: "league-a" };
const player = {
  id: "player-a", fullName: "Ada Footballer", leagueId: "league-a", teamId: team.id,
  position: "MID", photoUrl: null, shirtNumber: 11, availability: "available", status: "active", description: null,
};

async function openPlayer() {
  fireEvent.click(await screen.findByRole("button", { name: "Add player" }));
  const modal = within(screen.getByRole("dialog"));
  fireEvent.change(modal.getByPlaceholderText("Player name"), { target: { value: player.fullName } });
  return modal;
}

afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

describe("player and team creation UI", () => {
  it("updates the roster and team picker immediately, then refetches both on a new mount", async () => {
    // This UI regression test uses an HTTP contract double; database persistence
    // for both entities is independently exercised by the PostgreSQL suite.
    const teams: typeof team[] = [];
    const players: typeof player[] = [];
    const fetch = vi.fn(async (url: string, options?: RequestInit) => {
      if (options?.method === "GET") return Response.json({ teams, players, total: players.length });
      expect(options?.method).toBe("POST");
      if (url.endsWith("/teams")) {
        expect(JSON.parse(String(options?.body)).name).toBe(team.name);
        teams.push(team);
        return Response.json({ team }, { status: 201 });
      }
      expect(JSON.parse(String(options?.body)).teamId).toBe(team.id);
      players.push(player);
      return Response.json({ player }, { status: 201 });
    });
    vi.stubGlobal("fetch", fetch);
    const page = render(<PlayersPage />);
    fireEvent.click(await screen.findByRole("button", { name: "Add team" }));
    const modal = within(screen.getByRole("dialog"));
    fireEvent.change(modal.getByPlaceholderText("Saturday Reds"), { target: { value: team.name } });
    fireEvent.click(modal.getByRole("button", { name: "Add team" }));
    expect(await screen.findByText("Team added")).toBeTruthy();
    const editor = await openPlayer();
    const select = editor.getByRole("option", { name: team.name }).parentElement!;
    fireEvent.change(select, { target: { value: team.id } });
    fireEvent.click(editor.getByRole("button", { name: "Add player" }));
    expect(await screen.findByText("Player added")).toBeTruthy();
    expect(screen.getByRole("button", { name: /Ada Footballer/ })).toBeTruthy();
    expect(fetch.mock.calls.filter(([, options]) => options?.method === "GET")).toHaveLength(1);

    page.unmount();
    render(<PlayersPage />);
    expect(await screen.findByRole("button", { name: /Ada Footballer/ })).toBeTruthy();
    expect(screen.getByRole("option", { name: team.name })).toBeTruthy();
    expect(fetch.mock.calls.filter(([, options]) => options?.method === "GET")).toHaveLength(2);
  });

  it.each([
    [{ player: null }, 201, "The saved player could not be confirmed"],
    [{ player: { ...player, leagueId: "another-league" } }, 201, "The saved player could not be confirmed"],
    [{ error: "Could not create player: permission denied" }, 403, "Could not create player: permission denied"],
  ])("never shows success for an unconfirmed or forbidden player response %#", async (body, status, message) => {
    vi.stubGlobal("fetch", vi.fn(async (_url, options) => options.method === "GET"
      ? Response.json({ teams: [], players: [], total: 0 }) : Response.json(body, { status })));
    render(<PlayersPage />);
    const editor = await openPlayer();
    fireEvent.click(editor.getByRole("button", { name: "Add player" }));
    expect(await screen.findByText(message)).toBeTruthy();
    expect(screen.queryByText("Player added")).toBeNull();
    expect(screen.getByRole("dialog")).toBeTruthy();
  });

  it("never shows team success for an empty write response", async () => {
    vi.stubGlobal("fetch", vi.fn(async (_url, options) => options.method === "GET"
      ? Response.json({ teams: [], players: [], total: 0 }) : Response.json({ team: null }, { status: 201 })));
    render(<PlayersPage />);
    fireEvent.click(await screen.findByRole("button", { name: "Add team" }));
    const editor = within(screen.getByRole("dialog"));
    fireEvent.change(editor.getByPlaceholderText("Saturday Reds"), { target: { value: team.name } });
    fireEvent.click(editor.getByRole("button", { name: "Add team" }));
    expect(await screen.findByText("The saved team could not be confirmed")).toBeTruthy();
    expect(screen.queryByText("Team added")).toBeNull();
  });
});
