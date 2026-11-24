// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, render } from "@testing-library/react";
import { useSession } from "@/lib/client/api";
import { useAppRefresh } from "@/lib/client/refresh";

// Regression: clicking Sign out used to leave the shared refresh coordinator
// armed, so a poll tick (or focus event) landing in the window between the
// session cookies being cleared and the signed-in tree unmounting fired one
// last authenticated read — observed in production as `GET /api/me 401`.
// The 401 itself is correct server behavior; the bug was the client issuing
// a request it already knew could not succeed.

const replace = vi.hoisted(() => vi.fn());
vi.mock("next/navigation", () => ({ useRouter: () => ({ replace }) }));

const calls = vi.hoisted(() => vi.fn<(url: string, init?: RequestInit) => void>());
const fetchMock = vi.hoisted(() => vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
  calls(String(input), init);
  return Response.json({ ok: true });
}));

const initial = {
  user: { id: "user-1", email: "m@example.test", username: "manager", displayName: "Manager", avatarUrl: null, emailVerified: true },
  leagues: [],
  unread: 0,
};

function Harness({ onPoll }: { onPoll: () => void }) {
  const session = useSession(initial as never);
  useAppRefresh(onPoll, { pollMs: 50 });
  return <button onClick={() => void session.logout()}>Sign out</button>;
}

describe("sign out", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.stubGlobal("fetch", fetchMock);
    calls.mockClear();
    fetchMock.mockClear();
    replace.mockClear();
  });
  afterEach(() => {
    cleanup();
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it("clears the session, navigates to /login, and stops all polling before the tree unmounts", async () => {
    const poll = vi.fn();
    const view = render(<Harness onPoll={poll} />);

    // The coordinator is live before sign-out: a poll tick fires the subscriber.
    act(() => { vi.advanceTimersByTime(120); });
    expect(poll).toHaveBeenCalled();

    await act(async () => {
      view.getByRole("button", { name: "Sign out" }).click();
      await Promise.resolve();
    });

    // The logout POST went out…
    expect(calls).toHaveBeenCalledWith("/api/auth/logout", expect.objectContaining({ method: "POST" }));
    expect(replace).toHaveBeenCalledWith("/login");

    // …and no poll tick or focus event can fire an authenticated read now.
    poll.mockClear();
    calls.mockClear();
    act(() => { vi.advanceTimersByTime(60_000); });
    act(() => { window.dispatchEvent(new Event("focus")); });
    expect(poll).not.toHaveBeenCalled();
    expect(calls.mock.calls.filter(([url]) => url === "/api/me")).toEqual([]);
    expect(calls).not.toHaveBeenCalled();
  });

  it("keeps the 401 response behavior intact for any direct unauthenticated request", async () => {
    // The client must not issue post-logout reads, but if one is made anyway
    // (direct navigation, another tab), the server-side 401 path is untouched
    // — covered route-side in identity-routes.test.ts. Here we assert the
    // client layer still surfaces server errors instead of swallowing them.
    fetchMock.mockImplementationOnce(async () => Response.json({ error: "You are signed out" }, { status: 401 }));
    const { api } = await import("@/lib/client/api");
    await expect(api("/api/me")).rejects.toMatchObject({ status: 401, message: "You are signed out" });
  });
});
