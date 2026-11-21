// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import LoginPage from "@/app/(auth)/login/page";
import { GOOGLE_START_ERROR, GOOGLE_START_FIELD } from "@/lib/google-sign-in";
import SignupPage from "@/app/(auth)/signup/page";

const { pageNonce } = vi.hoisted(() => ({ pageNonce: "a".repeat(64) }));
vi.mock("next/headers", () => ({ cookies: async () => ({ get: (name: string) =>
  name === "__Host-ff-google-start" ? { value: pageNonce } : undefined,
}) }));
vi.mock("next/navigation", () => ({ useRouter: () => ({ push: vi.fn(), refresh: vi.fn() }) }));
afterEach(() => { cleanup(); vi.unstubAllEnvs(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });

it("offers Google as a separate form on sign-in and signup without replacing email auth", async () => {
  vi.stubEnv("GOOGLE_OAUTH_APP_ORIGIN", "https://fantasy.example.test");
  const searchParams = Promise.resolve({ next: "/matches/m1?tab=events" });
  for (const [Page, emailAction] of [[LoginPage, "Sign in"], [SignupPage, "Create account"]] as const) {
    render(await Page({ searchParams }));
    const google = screen.getByRole("button", { name: "Continue with Google" });
    const form = google.closest("form");
    expect(form?.getAttribute("method")).toBe("post");
    expect(form?.getAttribute("action")).toBe("/api/auth/google");
    expect(new FormData(form!).get("next")).toBe("/matches/m1?tab=events");
    expect(new FormData(form!).get(GOOGLE_START_FIELD)).toBe(pageNonce);
    expect(screen.getByRole("button", { name: emailAction }).closest("form")).not.toBe(form);
    cleanup();
  }
});

it("keeps email sign-in available when Google is disabled and renders only recognized auth errors", async () => {
  vi.stubEnv("GOOGLE_OAUTH_APP_ORIGIN", undefined);
  const view = render(await LoginPage({ searchParams: Promise.resolve({ auth_error: "google_cancelled" }) }));
  expect(screen.queryByRole("button", { name: "Continue with Google" })).toBeNull();
  expect(screen.getByRole("button", { name: "Sign in" })).toBeTruthy();
  expect(screen.getByRole("alert").textContent).toContain("Google sign-in was cancelled");
  view.rerender(await LoginPage({ searchParams: Promise.resolve({ auth_error: "arbitrary upstream text" }) }));
  expect(screen.queryByRole("alert")).toBeNull();
});

it("keeps the Google form and email fallback available after a failed start", async () => {
  vi.stubEnv("GOOGLE_OAUTH_APP_ORIGIN", "https://fantasy.example.test");
  render(await LoginPage({ searchParams: Promise.resolve({ next: "/team", auth_error: "google_start_failed" }) }));
  expect(screen.getByRole("alert").textContent).toBe(GOOGLE_START_ERROR);
  expect(screen.getByRole("button", { name: "Sign in" })).toBeTruthy();
  const form = screen.getByRole("button", { name: "Continue with Google" }).closest("form")!;
  expect(fireEvent.submit(form)).toBe(true);
  expect(screen.getByRole<HTMLButtonElement>("button", { name: "Opening Google…" }).disabled).toBe(true);
  expect(fireEvent.submit(form)).toBe(false);
  fireEvent(window, new Event("pageshow"));
  expect(screen.getByRole<HTMLButtonElement>("button", { name: "Continue with Google" }).disabled).toBe(false);
});
