// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, render } from "@testing-library/react";
import { api, useSession } from "@/lib/client/api";
import { useAppRefresh } from "@/lib/client/refresh";

// Regression: clicking Sign out fired one last `GET /api/me` that could only
// fail 401 — the refresh coordinator stayed armed while the logout request was
// in flight, and nothing stopped other late reads either. The 401 itself is
// correct server behavior; the client must simply stop issuing requests it
// knows cannot succeed.

const replace = vi.hoisted(() => vi.fn());
vi.mock("next/navigation", () => ({ useRouter: () => ({ replace }) }));

const calls = vi.hoisted(() => vi.fn<(url: string, init?: RequestInit) => void>());

type Deferred = { resolve: (r: Response) => void; reject: (e: unknown) => void };
let pending: Deferred | null = null;

const fetchMock = vi.hoisted(() => vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
  calls(String(input), init);
  const url = String(input);
  if (url === "/api/auth/logout" && holdLogout) {
    return new Promise<Response>((resolve, reject) => { pending = { resolve, reject }; });
  }
  return Promise.resolve(Response.json({ ok: true }));
}));

let holdLogout = false;

const initial = {
  user: { id: "user-1", email: "m@example.test", username: "manager", displayName: "Manager", avatarUrl: null, emailVerified: true },
  leagues: [],
  unread: 0,
};

function Harness({ onPoll }: { onPoll: () => void }) {
  const session = useSession(initial as never);
  useAppRefresh(onPoll, { pollMs: 50 });
  return <button onClick={() => void session.logout().catch(() => {})}>Sign out</button>;
}

describe("sign out", () => {
  beforeEach(async () => {
    vi.useFakeTimers();
    vi.stubGlobal("fetch", fetchMock);
    calls.mockClear();
    fetchMock.mockClear();
    replace.mockClear();
    pending = null;
    holdLogout = false;
    // Reset the signed-out circuit breaker (module state) between tests.
    await api("/api/auth/login", { method: "POST", body: {} });
    calls.mockClear();
  });
  afterEach(() => {
    cleanup();
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it("pauses polling the moment sign-out starts, clears the session, and navigates to /login", async () => {
    const poll = vi.fn();
    const view = render(<Harness onPoll={poll} />);

    // The coordinator is live before sign-out.
    act(() => { vi.advanceTimersByTime(120); });
    expect(poll).toHaveBeenCalled();

    // Hold the logout response so the request is still in flight…
    holdLogout = true;
    await act(async () => {
      view.getByRole("button", { name: "Sign out" }).click();
      await Promise.resolve();
    });
    expect(calls).toHaveBeenCalledWith("/api/auth/logout", expect.objectContaining({ method: "POST" }));

    // …and while it is, no poll tick or focus event may fire an authenticated read.
    poll.mockClear();
    calls.mockClear();
    act(() => { vi.advanceTimersByTime(60_000); });
    act(() => { window.dispatchEvent(new Event("focus")); });
    expect(poll).not.toHaveBeenCalled();
    expect(calls).not.toHaveBeenCalled();

    // Once the server confirms, the session is cleared and polling stays stopped.
    holdLogout = false;
    await act(async () => {
      pending!.resolve(Response.json({ ok: true }));
      await Promise.resolve();
    });
    expect(replace).toHaveBeenCalledWith("/login");
    act(() => { vi.advanceTimersByTime(60_000); });
    act(() => { window.dispatchEvent(new Event("focus")); });
    expect(poll).not.toHaveBeenCalled();
    expect(calls).not.toHaveBeenCalled();
  });

  it("issues no authenticated GET after sign-out, but keeps session discovery reachable", async () => {
    const view = render(<Harness onPoll={vi.fn()} />);
    await act(async () => {
      view.getByRole("button", { name: "Sign out" }).click();
      await Promise.resolve();
    });
    calls.mockClear();

    // A late read (any source) is refused locally with the same 401 shape the
    // server would return — without a network request, so nothing lands in
    // the console.
    await expect(api("/api/me")).rejects.toMatchObject({ status: 401, message: "You are signed out" });
    expect(calls).not.toHaveBeenCalled();

    // Session discovery must keep working so a fresh login in another tab can
    // still be picked up.
    await api("/api/auth/session");
    expect(calls.mock.calls.map(([url]) => url)).toContain("/api/auth/session");

    // And a successful credential sign-in lifts the circuit breaker.
    await api("/api/auth/login", { method: "POST", body: { email: "m@example.test", password: "x" } });
    await api("/api/me");
    expect(calls.mock.calls.map(([url]) => url)).toContain("/api/me");
  });

  it("resumes polling when the sign-out request itself fails", async () => {
    fetchMock.mockImplementation((input: RequestInfo | URL) => {
      calls(String(input));
      if (String(input) === "/api/auth/logout") return Promise.resolve(Response.json({ error: "boom" }, { status: 500 }));
      return Promise.resolve(Response.json({ ok: true }));
    });
    const poll = vi.fn();
    const view = render(<Harness onPoll={poll} />);

    await act(async () => {
      view.getByRole("button", { name: "Sign out" }).click();
      await Promise.resolve();
    });
    // Still signed in: no navigation, and the coordinator is armed again.
    expect(replace).not.toHaveBeenCalled();
    poll.mockClear();
    act(() => { vi.advanceTimersByTime(120); });
    expect(poll).toHaveBeenCalled();

    // The failed attempt must not trip the signed-out circuit breaker.
    calls.mockClear();
    fetchMock.mockImplementation((input: RequestInfo | URL) => {
      calls(String(input));
      return Promise.resolve(Response.json({ ok: true }));
    });
    await api("/api/me");
    expect(calls.mock.calls.map(([url]) => url)).toContain("/api/me");
  });
});
