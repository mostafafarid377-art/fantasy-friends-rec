import { describe, expect, it } from "vitest";
import {
  FORMATIONS,
  moveSquadPlayer,
  compatibleFormations,
  deriveFormation,
  isFormationForFormat,
  layoutFormation,
  validateLineup,
  validateMatchLineup,
  validateSquad,
  validateSquadDraft,
  type LeagueRules,
  type Position,
  type SquadPlayer,
} from "@/lib/domain";

const rules5: LeagueRules = { format: "5v5", squadSize: 15, starters: 5, subsCount: 5 };
const rules7: LeagueRules = { format: "7v7", squadSize: 15, starters: 7, subsCount: 5 };
// A squad that is played always names a captain and a vice-captain.
const captaincy5 = { captainId: "def1", viceId: "mid1" };
const captaincy7 = { captainId: "def1", viceId: "mid1" };

function player(id: string, position: Position, slot: SquadPlayer["slot"], order = 0): SquadPlayer {
  return { id, position, slot, order, name: id };
}

/** A legal 5v5 squad: 15 players, 5 starters (1 GK), 5 subs, 5 reserves. */
function squad5(): SquadPlayer[] {
  return [
    player("gk1", "GK", "starter", 0),
    player("def1", "DEF", "starter", 1),
    player("def2", "DEF", "starter", 2),
    player("mid1", "MID", "starter", 3),
    player("mid2", "MID", "starter", 4),
    player("sub1", "GK", "sub", 0),
    player("sub2", "DEF", "sub", 1),
    player("sub3", "MID", "sub", 2),
    player("sub4", "FWD", "sub", 3),
    player("sub5", "FWD", "sub", 4),
    player("res1", "DEF", "reserve"),
    player("res2", "MID", "reserve"),
    player("res3", "FWD", "reserve"),
    player("res4", "FWD", "reserve"),
    player("res5", "MID", "reserve"),
  ];
}

/** A legal 7v7 squad. */
function squad7(): SquadPlayer[] {
  return [
    player("gk1", "GK", "starter", 0),
    player("def1", "DEF", "starter", 1),
    player("def2", "DEF", "starter", 2),
    player("def3", "DEF", "starter", 3),
    player("mid1", "MID", "starter", 4),
    player("mid2", "MID", "starter", 5),
    player("fwd1", "FWD", "starter", 6),
    ...["s1", "s2", "s3", "s4", "s5"].map((id, i) => player(id, i === 0 ? "GK" : "MID", "sub", i)),
    ...["r1", "r2", "r3"].map((id) => player(id, "DEF", "reserve")),
  ];
}

describe("league format rules", () => {
  it("requires exactly 5 starters in a 5v5 league", () => {
    expect(validateSquad(rules5, squad5(), { formation: "2-2-0", ...captaincy5 }).ok).toBe(true);
    const withExtra = squad5().map((p) =>
      p.slot === "reserve" && p.id === "res1" ? { ...p, slot: "starter" as const, order: 5 } : p,
    );
    const result = validateSquad(rules5, withExtra, { formation: "1-2-1" });
    expect(result.ok).toBe(false);
    expect(result.ok === false && result.errors.join(" ")).toMatch(/Exactly 5 starters/);
  });

  it("requires exactly 7 starters in a 7v7 league", () => {
    expect(validateSquad(rules7, squad7(), { formation: "3-2-1", ...captaincy7 }).ok).toBe(true);
    const missing = squad7().filter((p) => p.id !== "fwd1");
    const result = validateSquad(rules7, missing, { formation: "1-2-3" });
    expect(result.ok).toBe(false);
    expect(result.ok === false && result.errors.join(" ")).toMatch(/Exactly 7 starters/);
  });

  it("always requires exactly one goalkeeper among the starters", () => {
    const noKeeper = squad5().map((p) =>
      p.id === "gk1" ? { ...p, slot: "sub" as const } : p,
    );
    const result = validateSquad(rules5, noKeeper, { formation: "1-2-1" });
    expect(result.ok).toBe(false);
    expect(result.ok === false && result.errors.join(" ")).toMatch(/exactly one goalkeeper/i);

    const twoKeepers = squad5().map((p) =>
      p.id === "sub1" ? { ...p, slot: "starter" as const, order: 5 } : p,
    );
    expect(validateSquad(rules5, twoKeepers, { formation: "1-2-1" }).ok).toBe(false);
  });

  it("keeps substitutes out of the starting count", () => {
    const subsOnly = squad5().filter((p) => p.slot === "starter").length;
    expect(subsOnly).toBe(rules5.starters);
    expect(validateSquad(rules5, squad5(), { formation: "2-2-0", ...captaincy5 }).ok).toBe(true);
  });

  it("rejects an eleven-a-side lineup in a small-sided league", () => {
    const eleven = squad5().map((p, i) =>
      i < 11 && p.slot !== "starter" ? { ...p, slot: "starter" as const, order: i } : p,
    );
    expect(validateSquad(rules5, eleven, { formation: "1-2-1" }).ok).toBe(false);
  });

  it("rejects formations that do not fit the format", () => {
    expect(isFormationForFormat("1-2-3", "5v5")).toBe(false);
    expect(isFormationForFormat("1-2-1", "7v7")).toBe(false);
    expect(isFormationForFormat("1-2-1", "5v5")).toBe(true);
    expect(isFormationForFormat("1-2-3", "7v7")).toBe(true);

    const bad = validateSquad(rules5, squad5(), { formation: "1-2-3" });
    expect(bad.ok).toBe(false);
  });

  it("every registered formation fields the correct number of outfield players", () => {
    for (const f of FORMATIONS["5v5"]) {
      expect(f.lines.reduce((a, b) => a + b, 0)).toBe(4);
    }
    for (const f of FORMATIONS["7v7"]) {
      expect(f.lines.reduce((a, b) => a + b, 0)).toBe(6);
    }
  });

  it("enforces captain and vice-captain membership", () => {
    expect(
      validateSquad(rules5, squad5(), { formation: "2-2-0", captainId: "def1", viceId: "mid1" }).ok,
    ).toBe(true);
    expect(
      validateSquad(rules5, squad5(), { formation: "2-2-0", captainId: "sub4", viceId: "mid1" }).ok,
    ).toBe(false);
    expect(
      validateSquad(rules5, squad5(), { formation: "2-2-0", captainId: "def1", viceId: "def1" }).ok,
    ).toBe(false);
  });

  it("draft validation allows an incomplete squad but never exceeds caps", () => {
    const partial = squad5().slice(0, 6);
    expect(validateSquadDraft(rules5, partial, { formation: "2-2-0" }).ok).toBe(true);
    expect(validateSquad(rules5, partial, { formation: "1-2-1" }).ok).toBe(false);

    const overflow = [...squad5(), player("x1", "FWD", "starter", 9)];
    expect(validateSquadDraft(rules5, overflow, { formation: "2-2-0" }).ok).toBe(false);
  });

  it("requires a captain and a vice-captain for a complete squad", () => {
    const withoutCaptain = validateSquad(rules5, squad5(), { formation: "2-2-0" });
    expect(withoutCaptain.ok).toBe(false);
    expect(withoutCaptain.ok === false && withoutCaptain.errors.join(" ")).toMatch(/Choose a captain/);

    const withoutVice = validateSquad(rules5, squad5(), { formation: "2-2-0", captainId: "def1" });
    expect(withoutVice.ok).toBe(false);
    expect(withoutVice.ok === false && withoutVice.errors.join(" ")).toMatch(/Choose a vice-captain/);

    // A squad that is still being picked up does not need captaincy yet.
    expect(validateSquadDraft(rules5, squad5().slice(0, 6), { formation: "2-2-0" }).ok).toBe(true);
  });
});

describe("match lineup validation", () => {
  it("requires captaincy and a full starting lineup", () => {
    const starters = squad5().filter((p) => p.slot === "starter");
    const bench = squad5().filter((p) => p.slot === "sub");

    expect(validateMatchLineup(rules5, [...starters, ...bench], { formation: "2-2-0", ...captaincy5 }).ok).toBe(true);

    const withoutCaptaincy = validateMatchLineup(rules5, [...starters, ...bench], { formation: "2-2-0" });
    expect(withoutCaptaincy.ok).toBe(false);
    expect(withoutCaptaincy.ok === false && withoutCaptaincy.errors.join(" ")).toMatch(/Choose a captain/);

    const tooFew = validateMatchLineup(rules5, [...starters.slice(0, 4), ...bench], { formation: "2-2-0", ...captaincy5 });
    expect(tooFew.ok).toBe(false);
    expect(tooFew.ok === false && tooFew.errors.join(" ")).toMatch(/Exactly 5 starters/);

    // A match lineup never needs the reserves of a full squad.
    expect(validateMatchLineup(rules5, starters, { formation: "2-2-0", ...captaincy5 }).ok).toBe(true);
  });
});

describe("strict position layouts and editing", () => {
  it.each([rules5, rules7])("renders every empty pitch spot and one goalkeeper ($format)", (rules) => {
    const shape = deriveFormation(rules, [])!;
    const slots = layoutFormation([], shape);
    expect(slots).toHaveLength(rules.starters);
    expect(slots.filter((s) => s.position === "GK")).toHaveLength(1);
    expect(slots.every((s) => s.playerId === null)).toBe(true);
  });

  it("renders each selected player in their own position, including a legacy-label recovery", () => {
    const players = squad7();
    const shape = deriveFormation(rules7, players, "1-3-1-1")!;
    expect(shape.label).toBe("3-2-1");
    const slots = layoutFormation(players, shape);
    expect(slots).toHaveLength(7);
    expect(slots.every((s) => players.find((p) => p.id === s.playerId)?.position === s.position)).toBe(true);
    expect(slots.find((s) => s.position === "GK")!.y).toBeGreaterThan(slots.find((s) => s.position === "FWD")!.y);
  });

  it("derives a new shape when swapping a defender for a midfielder and preserves unrelated entries", () => {
    const squad = squad7();
    const result = moveSquadPlayer(rules7, squad, "def1", "sub", "3-2-1", "s2");
    expect(result).toMatchObject({ formation: "2-3-1" });
    if ("error" in result) return;
    expect(result.players.find((p) => p.id === "def1")).toMatchObject({ slot: "sub", order: 1 });
    expect(result.players.find((p) => p.id === "s2")).toMatchObject({ slot: "starter", order: 1 });
    expect(result.players.find((p) => p.id === "gk1")).toBe(squad[0]);
  });

  it("allows a goalkeeper swap only for another goalkeeper", () => {
    const squad = squad5();
    expect(moveSquadPlayer(rules5, squad, "gk1", "sub", "2-2-0", "sub3")).toHaveProperty("error");
    expect(moveSquadPlayer(rules5, squad, "mid1", "sub", "2-2-0", "sub1")).toHaveProperty("error");
    expect(moveSquadPlayer(rules5, squad, "gk1", "sub", "2-2-0", "sub1")).toMatchObject({ formation: "2-2-0" });
    expect(moveSquadPlayer(rules5, squad, "sub1", "starter", "2-2-0")).toHaveProperty("error");
  });

  it("requires compatible partial shapes and only allows the exact positional counts when full", () => {
    const starters = squad5().filter((p) => p.slot === "starter");
    const partial = starters.slice(0, 3);
    expect(compatibleFormations(rules5, partial).every((f) => f.lines[0] >= 2)).toBe(true);
    expect(compatibleFormations(rules5, starters).map((f) => f.label)).toEqual(["2-2-0"]);
    expect(deriveFormation(rules5, starters.map((p) => p.id === "def1" ? { ...p, position: "FWD" } : p))?.label).toBe("1-2-1");
    expect(validateSquadDraft(rules5, partial, { formation: "2-1-1", captainId: "missing" }).ok).toBe(false);
  });

  it("uses the actual squad and sub limits, not the format to size the bench", () => {
    const rules = { ...rules5, squadSize: 7, subsCount: 1 };
    const players = squad5().filter((p) => p.slot === "starter" || ["sub1", "res1"].includes(p.id));
    expect(validateSquad(rules, players, { formation: "2-2-0", captainId: "def1", viceId: "mid1" }).ok).toBe(true);
    expect(validateSquadDraft(rules, [...players, player("extra", "DEF", "sub")], { formation: "2-2-0" }).ok).toBe(false);
  });
});

describe("real-match lineup validation", () => {
  it("accepts 5 starters for 5v5 and 7 for 7v7", () => {
    const five = [
      { position: "GK" as Position },
      { position: "DEF" as Position },
      { position: "DEF" as Position },
      { position: "MID" as Position },
      { position: "FWD" as Position },
    ];
    expect(validateLineup(rules5, five, [{ position: "MID" }]).ok).toBe(true);
    expect(validateLineup(rules7, five, []).ok).toBe(false);

    const seven = [...five, { position: "MID" as Position }, { position: "DEF" as Position }];
    expect(validateLineup(rules7, seven, []).ok).toBe(true);
  });

  it("rejects a lineup without a goalkeeper or with too many bench players", () => {
    const noKeeper = [
      { position: "DEF" as Position },
      { position: "DEF" as Position },
      { position: "MID" as Position },
      { position: "MID" as Position },
      { position: "FWD" as Position },
    ];
    expect(validateLineup(rules5, noKeeper, []).ok).toBe(false);

    const sixBench = Array.from({ length: 6 }, () => ({ position: "MID" as Position }));
    const five = [
      { position: "GK" as Position },
      { position: "DEF" as Position },
      { position: "DEF" as Position },
      { position: "MID" as Position },
      { position: "FWD" as Position },
    ];
    expect(validateLineup(rules5, five, sixBench).ok).toBe(false);
  });
});
