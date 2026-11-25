// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Regression coverage for J18: after a successful profile save the form
 * stayed dirty, so the indicator kept reading "Unsaved changes" and the
 * journey waiting for "All changes saved" timed out. The save handler now
 * resets the form baseline to the server-returned profile.
 */

import ProfilePage from "@/app/(app)/profile/page";
import { api, useApi } from "@/lib/client/api";

const PROFILE = {
  id: "p1",
  email: "fixture@example.invalid",
  username: "e2e_manager",
  displayName: "E2E Manager",
  avatarUrl: null as string | null,
  bio: null as string | null,
  emailVerified: true,
  createdAt: "2026-01-01T00:00:00.000Z",
};
const DATA = {
  profile: PROFILE,
  stats: { leagues: 1, roles: { manager: 1 }, totalPoints: 0, matchesPlayed: 0, bestRank: null },
};

vi.mock("next/navigation", () => ({ useRouter: () => ({ push: vi.fn(), replace: vi.fn(), refresh: vi.fn() }) }));
vi.mock("@/components/AppShell", () => ({
  PageHeader: ({ title, actions }: { title: string; actions?: React.ReactNode }) => (
    <div>
      <h1>{title}</h1>
      {actions}
    </div>
  ),
}));
vi.mock("@/components/LeagueContext", () => ({
  useLeague: () => ({ refresh: vi.fn(async () => ({ user: null, leagues: [], unread: 0 })), logout: vi.fn(), league: null }),
}));
vi.mock("@/lib/client/league-updates", () => ({ useLiveLeaguePoints: () => {} }));
vi.mock("@/lib/client/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/client/api")>();
  return { ...actual, api: vi.fn(), useApi: vi.fn() };
});
const apiMock = vi.mocked(api);
const useApiMock = vi.mocked(useApi);

describe("profile save feedback (J18 regression)", () => {
  beforeEach(() => {
    useApiMock.mockReturnValue({
      data: DATA,
      loading: false,
      error: null,
      reload: vi.fn(),
      setData: vi.fn(),
    } as unknown as ReturnType<typeof useApi>);
    apiMock.mockImplementation(async () => ({ profile: { ...PROFILE, displayName: "Renamed Manager" } }));
  });
  afterEach(() => cleanup());

  it("flips back to 'All changes saved' after a successful save", async () => {
    render(<ProfilePage />);
    const input = await screen.findByLabelText("Display name");
    await waitFor(() => expect((input as HTMLInputElement).value).toBe("E2E Manager"));

    // Clean baseline shows the saved indicator before editing.
    expect(screen.queryByText("All changes saved")).not.toBeNull();

    fireEvent.change(input, { target: { value: "Renamed Manager" } });
    expect(screen.queryByText("Unsaved changes")).not.toBeNull();

    fireEvent.click(screen.getByRole("button", { name: /Save profile/ }));

    await waitFor(() => expect(screen.queryByText("All changes saved")).not.toBeNull());
    expect(screen.queryByText("Unsaved changes")).toBeNull();
    expect(apiMock).toHaveBeenCalledWith("/api/me", expect.objectContaining({ method: "PATCH" }));
  });
});
