import { describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import { POST as createPlayer } from "@/app/api/leagues/[id]/players/route";
import { POST as createTeam } from "@/app/api/leagues/[id]/teams/route";

const doubles = vi.hoisted(() => ({ from: vi.fn(), getUser: vi.fn() }));
vi.mock("@/db", () => ({ getSupabase: async () => ({ from: doubles.from, auth: { getUser: doubles.getUser } }) }));

const leagueId = "league-a";
const ctx = { params: Promise.resolve({ id: leagueId }) };
const cases = [
  { entity: "player", table: "players", route: createPlayer, payload: { fullName: "Test player", position: "MID" } },
  { entity: "team", table: "teams", route: createTeam, payload: { name: "Test team" } },
] as const;

type Outcome = { data: Record<string, unknown> | null; error: { code: string; message: string } | null };

describe.each(cases)("$entity API", ({ entity, table, route, payload }) => {
  const request = () => new NextRequest(`http://local.test/api/leagues/${leagueId}/${table}`, {
    method: "POST", body: JSON.stringify(payload), headers: { "x-operation-id": "test-operation" },
  });
  const setup = (outcome: Outcome, role = "leader", signedIn = true) => {
    const actor = "authenticated-actor";
    const insert = vi.fn();
    const filters: unknown[][] = [];
    let insertedId: string | undefined;
    const db = { select: () => db, eq: (...args: unknown[]) => { filters.push(args); return db; },
      maybeSingle: () => outcome.data && outcome.data.id === "inserted" ? { ...outcome, data: { ...outcome.data, id: insertedId } } : outcome,
      insert: (row: { id: string }) => { insertedId = row.id; insert(row); return db; } };
    const membership = { select: () => membership,
      eq: (...args: unknown[]) => { filters.push(args); return membership; },
      maybeSingle: () => ({ error: null, data: { role, leagues: { id: leagueId } } }) };
    doubles.getUser.mockResolvedValue({ error: null, data: { user: signedIn ? { id: actor } : null } });
    doubles.from.mockImplementation((name) => name === "league_members" ? membership : db);
    return { actor, insert, filters };
  };

  it("requires a confirmed row, never a successful status on PostgREST errors or null data", async () => {
    const cases: [Outcome, number][] = [
      [{ data: null, error: { code: "42501", message: "row-level security failure" } }, 403],
      [{ data: null, error: null }, 409],
      [{ data: { id: "record", league_id: "other-league" }, error: null }, 409],
    ];
    for (const [outcome, expected] of cases) {
      setup(outcome);
      const res = await route(request(), ctx);
      expect(res.status).toBe(expected);
      expect(await res.json()).not.toHaveProperty(entity);
    }
  });

  it("assigns a nonempty ID, validates actor and scope, and returns the confirmed DTO", async () => {
    const { actor, insert, filters } = setup({ error: null, data: { id: "inserted", league_id: leagueId } });
    const res = await route(request(), ctx);
    expect(res.status).toBe(201);
    expect(filters).toContainEqual(["league_id", leagueId]);
    expect(filters).toContainEqual(["profile_id", actor]);
    expect(insert).toHaveBeenCalledWith(expect.objectContaining({ id: expect.any(String), league_id: leagueId,
      ...(entity === "player" ? { created_by: actor } : {}) }));
    expect((await res.json())[entity]).toMatchObject({ id: insert.mock.calls[0][0].id, leagueId });
  });

  it("does not issue writes for a manager or a signed-out request", async () => {
    for (const [role, signedIn, status] of [["manager", true, 403], ["leader", false, 401]] as const) {
      const { insert } = setup({ error: null, data: null }, role, signedIn);
      expect((await route(request(), ctx)).status).toBe(status);
      expect(insert).not.toHaveBeenCalled();
    }
  });
});
