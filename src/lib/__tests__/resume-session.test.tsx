// @vitest-environment jsdom
import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { ResumeSession } from "@/components/ResumeSession";
import LoginPage from "@/app/(auth)/login/page";
import ProtectedLayout from "@/app/(app)/layout";

const { router, sessionSnapshot } = vi.hoisted(() => ({ router: { replace: vi.fn() }, sessionSnapshot: vi.fn() }));
vi.mock("@/lib/session", () => ({ getSessionSnapshot: sessionSnapshot }));
vi.mock("next/navigation", () => ({ useRouter: () => router }));
vi.mock("next/headers", () => ({ cookies: async () => ({ get: () => undefined }) }));
afterEach(() => { cleanup(); router.replace.mockReset(); vi.unstubAllGlobals(); vi.unstubAllEnvs(); });

it("opens the dashboard only after the session check succeeds", async () => {
  const fetch = vi.fn().mockResolvedValue(Response.json({ user: { id: "manager" }, leagues: [], unread: 0 }));
  vi.stubGlobal("fetch", fetch);
  render(<ResumeSession destination="/dashboard" />);
  await waitFor(() => expect(router.replace).toHaveBeenCalledWith("/dashboard"));
  expect(fetch).toHaveBeenCalledWith("/api/auth/session", expect.objectContaining({ credentials: "same-origin", cache: "no-store" }));
});

it.each(["signed out", "site error", "network error"])("leaves the public page usable when the background check reports %s", async (outcome) => {
  const fetch = vi.fn().mockImplementation(async () => {
    if (outcome === "network error") throw new Error("Offline");
    return outcome === "site error" ? new Response("Internal Server Error", { status: 500 }) : Response.json({ user: null });
  });
  vi.stubGlobal("fetch", fetch);
  await act(async () => { render(<><h1>Home</h1><ResumeSession destination="/dashboard" /></>); });
  expect(document.querySelector("h1")?.textContent).toBe("Home");
  expect(fetch).toHaveBeenCalledOnce();
  expect(router.replace).not.toHaveBeenCalled();
});

it.each([["/team", "/team"], ["//outside.example", "/dashboard"], ["/login?next=/team", "/dashboard"]])("resumes sign-in destination %s safely", async (next, destination) => {
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue(Response.json({ user: { id: "manager" } })));
  render(await LoginPage({ searchParams: Promise.resolve({ next }) }));
  await waitFor(() => expect(router.replace).toHaveBeenCalledWith(destination));
});

it("does not auto-redirect away from an explicit sign-in recovery prompt", async () => {
  const fetch = vi.fn();
  vi.stubGlobal("fetch", fetch);
  await act(async () => { render(await LoginPage({ searchParams: Promise.resolve({ auth_error: "session_unavailable" }) })); });
  expect(fetch).not.toHaveBeenCalled();
  expect(router.replace).not.toHaveBeenCalled();
});


it("offers safe recovery without rendering protected content when the session cannot be loaded", async () => {
  sessionSnapshot.mockRejectedValueOnce(new Error("sensitive server detail"));
  render(await ProtectedLayout({ children: <p>Private league content</p> }));
  expect(screen.getByRole("heading", { name: "Couldn’t open the app" })).toBeTruthy();
  expect(screen.getByRole("link", { name: "Back to homepage" }).getAttribute("href")).toBe("/");
  expect(screen.getByRole("link", { name: "Sign in again" }).getAttribute("href")).toBe("/login?auth_error=session_unavailable");
  expect(screen.queryByText("Private league content")).toBeNull();
  expect(screen.queryByText("sensitive server detail")).toBeNull();
});
