// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import LoginPage from "@/app/(auth)/login/page";
import SignupPage from "@/app/(auth)/signup/page";

vi.mock("next/navigation", () => ({ useRouter: () => ({ push: vi.fn(), refresh: vi.fn() }) }));
afterEach(() => { cleanup(); vi.unstubAllEnvs(); });

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
