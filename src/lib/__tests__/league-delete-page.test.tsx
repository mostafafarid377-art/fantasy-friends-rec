// @vitest-environment jsdom
import { afterEach, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import SettingsPage from "@/app/(app)/settings/page";
import { AppProvider, useLeague } from "@/components/LeagueContext";
import type { SessionPayload } from "@/lib/client/api";

const router = vi.hoisted(() => ({ replace: vi.fn() }));
vi.mock("next/navigation", () => ({ useRouter: () => router }));
vi.mock("@/components/AppShell", () => ({ PageHeader: ({ title }: { title: string }) => <h1>{title}</h1> }));
const league = { id: "owned", name: "Friends League", format: "5v5", role: "leader", starters: 5, subsCount: 2, inviteCode: "ABC",
  rank: null, teamName: null, totalPoints: null } as const;
const other = { ...league, id: "other", name: "Other League", role: "manager" } as const;
const session: SessionPayload = { user: { id:"me", email:"me@example.test", username:"owner", displayName:"Owner", avatarUrl:null,
  bio:null, emailVerified:true, createdAt:"2026-11-19" }, leagues:[league, other], unread:0 };
const settings = (l: typeof league | typeof other, canDelete: boolean) => ({ league: { ...l, squadSize: 12, description: null }, role: l.role, canDelete });

function ActiveLeague() {
  const { league } = useLeague();
  return <p data-testid="active">{league?.name ?? "none"}</p>;
}
afterEach(() => { cleanup(); window.localStorage.clear(); router.replace.mockClear(); vi.unstubAllGlobals(); });

it("requires typed confirmation, keeps the league after an error, and clears the deleted active league on success", async () => {
  let ok = false;
  window.localStorage.setItem("ff.active.league", league.id);
  const fetch = vi.fn(async (url: string, options: RequestInit) => {
    if (url === "/api/leagues/other") return Response.json(settings(other, false));
    if (url === "/api/leagues/owned" && options.method !== "DELETE") return Response.json(settings(league, true));
    if (url === "/api/leagues/owned") return ok ? Response.json({ deletedId:"owned" }) : Response.json({ error:"Could not delete league" }, { status:409 });
    throw new Error(`Unexpected ${url}`);
  });
  vi.stubGlobal("fetch", fetch);
  render(<AppProvider initialSession={session}><SettingsPage/><ActiveLeague/></AppProvider>);
  fireEvent.click(await screen.findByRole("button", { name:"Delete league" }));
  const dialog = within(screen.getByRole("dialog", { name:"Delete Friends League?" }));
  const confirm = () => dialog.getByRole("button", { name:"Permanently delete league" }) as HTMLButtonElement;
  const input = dialog.getByLabelText(/^Type the league name to confirm/);
  fireEvent.change(input, { target:{ value:"friends league" } });
  expect(confirm().disabled).toBe(true);
  fireEvent.change(input, { target:{ value:league.name } });
  fireEvent.click(confirm());
  expect(await dialog.findByText("Could not delete league")).toBeTruthy();
  expect(router.replace).not.toHaveBeenCalled();
  expect(screen.getByTestId("active").textContent).toBe(league.name);
  ok = true;
  fireEvent.click(confirm());
  await waitFor(() => expect(router.replace).toHaveBeenCalledWith("/leagues"));
  expect(screen.getByTestId("active").textContent).toBe(other.name);
  expect(window.localStorage.getItem("ff.active.league")).toBeNull();
  expect(fetch).toHaveBeenCalledWith("/api/leagues/owned", expect.objectContaining({ method:"DELETE", body:JSON.stringify({ confirmation:league.name }) }));
});

it("does not offer league deletion to a non-creator leader", async () => {
  vi.stubGlobal("fetch", vi.fn(async () => Response.json(settings(league, false))));
  render(<AppProvider initialSession={session}><SettingsPage/></AppProvider>);
  await screen.findByLabelText("League name");
  expect(screen.queryByRole("button", { name:"Delete league" })).toBeNull();
});
