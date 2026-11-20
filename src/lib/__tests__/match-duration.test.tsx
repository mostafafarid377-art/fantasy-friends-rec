// @vitest-environment jsdom
import { afterEach, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import NewMatchPage from "@/app/(app)/matches/new/page";

const router = vi.hoisted(() => ({ push: vi.fn() }));
vi.mock("next/navigation", () => ({ useRouter: () => router }));
vi.mock("@/components/LeagueContext", () => ({
  useActiveLeague: () => ({ league: { id: "league", name: "Friends League", format: "5v5", starters: 5, subsCount: 2 } }),
  useLeague: () => ({ canOrganize: true }),
}));
vi.mock("@/components/AppShell", () => ({ PageHeader: ({ title }: { title: string }) => <h1>{title}</h1> }));
afterEach(() => { cleanup(); vi.unstubAllGlobals(); router.push.mockClear(); });

it("lets the organizer enter 60 minutes instead of 90 and requires confirmation of the saved duration", async () => {
  let confirmed = false;
  const posted = vi.fn();
  vi.stubGlobal("fetch", vi.fn(async (url: string, init: RequestInit) => {
    if (url.endsWith("/teams")) return Response.json({ teams: [{ id: "home", name: "Home" }, { id: "away", name: "Away" }] });
    if (url.endsWith("/fixtures")) return Response.json({ fixtures: [] });
    if (url !== "/api/matches") throw new Error(`Unexpected ${url}`);
    const body = JSON.parse(String(init.body));
    posted(body);
    return Response.json({ match: { id: "match", duration_minutes: confirmed ? body.durationMinutes : 90 } }, { status: 201 });
  }));
  render(<NewMatchPage />);
  const duration = await screen.findByRole("spinbutton", { name: /^Match duration/ }) as HTMLInputElement;
  expect(duration.value).toBe("90");
  fireEvent.change(screen.getByLabelText("Match title"), { target:{ value:"Evening match" } });
  fireEvent.change(screen.getByLabelText("Team A"), { target:{ value:"home" } });
  fireEvent.change(screen.getByLabelText("Team B"), { target:{ value:"away" } });
  fireEvent.change(screen.getByLabelText("Kick-off"), { target:{ value:"2026-11-19T18:00" } });
  const submit = () => screen.getByRole("button", { name:"Create match" }) as HTMLButtonElement;
  fireEvent.change(duration, { target:{ value:"0" } });
  expect(submit().disabled).toBe(true);
  fireEvent.change(duration, { target:{ value:"60" } });
  fireEvent.click(submit());
  expect(await screen.findByText("The saved match duration could not be confirmed")).toBeTruthy();
  expect(router.push).not.toHaveBeenCalled();
  confirmed = true;
  fireEvent.click(submit());
  await waitFor(() => expect(router.push).toHaveBeenCalledWith("/matches/match"));
  expect(posted).toHaveBeenLastCalledWith(expect.objectContaining({ durationMinutes: 60 }));
});
