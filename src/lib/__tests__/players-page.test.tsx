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

it("opens gallery and camera inputs, previews a compressed photo, and retries upload without duplicating the player", async () => {
  const objectUrl = vi.fn(() => "blob:photo-preview"), revoke = vi.fn();
  vi.stubGlobal("URL", Object.assign(class extends URL {}, { createObjectURL: objectUrl, revokeObjectURL: revoke }));
  vi.stubGlobal("Image", class { decode = async () => {}; naturalWidth = 1800; naturalHeight = 1200; });
  const draw = vi.fn();
  const ctx = vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue({ drawImage: draw, fillRect: () => {} } as unknown as CanvasRenderingContext2D);
  const toBlob = vi.spyOn(HTMLCanvasElement.prototype, "toBlob").mockImplementation((done) => done(new Blob(["compressed"], { type: "image/jpeg" })));
  const photoUrl = `/api/leagues/league-a/players/${player.id}/photo?v=version-2.jpg`;
  let attempts = 0, saved: typeof player | null = null;
  const fetch = vi.fn(async (url: string, init?: RequestInit) => {
    if (init?.method === "GET") return Response.json({ teams: [team], players: saved ? [saved] : [], total: saved ? 1 : 0 });
    if (url.endsWith("/photo")) {
      if (init?.method === "DELETE") {
        saved = player;
        return Response.json({ player: saved });
      }
      expect(init?.body).toBeInstanceOf(FormData);
      expect((init!.body as FormData).get("photo")).toMatchObject({ type: "image/jpeg", name: "player.jpg" });
      expect(init?.headers).not.toHaveProperty("Content-Type");
      if (++attempts === 1) return Response.json({ error: "Upload failed" }, { status: 502 });
      saved = { ...player, photoUrl } as unknown as typeof player;
    } else if (init?.method === "POST") saved = player;
    else expect(JSON.parse(String(init?.body))).not.toHaveProperty("photoUrl");
    return Response.json({ player: saved });
  });
  vi.stubGlobal("fetch", fetch);
  try {
    const view = render(<PlayersPage />);
    const editor = await openPlayer();
    const gallery = editor.getByLabelText("Choose from gallery");
    expect(gallery.getAttribute("accept")).toBe("image/*");
    expect(gallery.hasAttribute("capture")).toBe(false);
    expect(editor.getByLabelText("Take photo").getAttribute("capture")).toBe("environment");
    fireEvent.change(gallery, { target: { files: [new File(["bad"], "bad.svg", { type: "image/svg+xml" })] } });
    expect(await editor.findByRole("alert")).toBeTruthy();
    fireEvent.change(gallery, { target: { files: [new File(["original"], "image.png", { type: "image/png" })] } });
    expect(await editor.findByText(/Photo selected/)).toBeTruthy();
    expect((await editor.findByRole("img")).getAttribute("src")).toBe("blob:photo-preview");
    expect(draw.mock.calls[0].slice(-2)).toEqual([384, 384]);
    fireEvent.click(editor.getByRole("button", { name: "Add player" }));
    expect(await editor.findByText(/Player details were saved, but the photo change was not confirmed/)).toBeTruthy();
    expect(screen.queryByText("Player added")).toBeNull();
    fireEvent.click(editor.getByRole("button", { name: "Save changes" }));
    expect(await screen.findByText("Player updated")).toBeTruthy();
    expect(fetch.mock.calls.filter(([url, init]) => url.endsWith("/players") && init?.method === "POST")).toHaveLength(1);
    expect(document.querySelector(`img[src="${photoUrl}"]`)).toBeTruthy();
    view.unmount();
    render(<PlayersPage />);
    fireEvent.click(await screen.findByRole("button", { name: "Edit player" }));
    const existing = within(screen.getByRole("dialog"));
    expect(existing.getByRole("img").getAttribute("src")).toBe(photoUrl);
    fireEvent.click(existing.getByRole("button", { name: "Remove photo" }));
    fireEvent.click(existing.getByRole("button", { name: "Save changes" }));
    expect(await screen.findByText("Player updated")).toBeTruthy();
    expect(document.querySelector(`img[src="${photoUrl}"]`)).toBeNull();
    expect(revoke).toHaveBeenCalledWith("blob:photo-preview");
  } finally { ctx.mockRestore(); toBlob.mockRestore(); }
});
