import { describe, expect, it } from "vitest";
import {
  FORMATIONS,
  applySubstitution,
  isFormationForFormat,
  layoutFormation,
  suggestFormation,
  validateLineup,
  validateSquad,
  validateSquadDraft,
  type LeagueRules,
  type Position,
  type SquadPlayer,
} from "@/lib/domain";

const rules5: LeagueRules = { format: "5v5", squadSize: 15, starters: 5, subsCount: 5 };
const rules7: LeagueRules = { format: "7v7", squadSize: 15, starters: 7, subsCount: 5 };

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
    ...["s1", "s2", "s3", "s4", "s5"].map((id, i) => player(id, "MID", "sub", i)),
    ...["r1", "r2", "r3"].map((id) => player(id, "DEF", "reserve")),
  ];
}

describe("league format rules", () => {
  it("requires exactly 5 starters in a 5v5 league", () => {
    expect(validateSquad(rules5, squad5(), { formation: "1-2-1" }).ok).toBe(true);
    const withExtra = squad5().map((p) =>
      p.slot === "reserve" && p.id === "res1" ? { ...p, slot: "starter" as const, order: 5 } : p,
    );
    const result = validateSquad(rules5, withExtra, { formation: "1-2-1" });
    expect(result.ok).toBe(false);
    expect(result.ok === false && result.errors.join(" ")).toMatch(/Exactly 5 starters/);
  });

  it("requires exactly 7 starters in a 7v7 league", () => {
    expect(validateSquad(rules7, squad7(), { formation: "1-2-3" }).ok).toBe(true);
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
    expect(validateSquad(rules5, squad5(), { formation: "1-2-1" }).ok).toBe(true);
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
      validateSquad(rules5, squad5(), { formation: "1-2-1", captainId: "def1", viceId: "mid1" }).ok,
    ).toBe(true);
    expect(
      validateSquad(rules5, squad5(), { formation: "1-2-1", captainId: "sub4", viceId: "mid1" }).ok,
    ).toBe(false);
    expect(
      validateSquad(rules5, squad5(), { formation: "1-2-1", captainId: "def1", viceId: "def1" }).ok,
    ).toBe(false);
  });

  it("draft validation allows an incomplete squad but never exceeds caps", () => {
    const partial = squad5().slice(0, 6);
    expect(validateSquadDraft(rules5, partial).ok).toBe(true);
    expect(validateSquad(rules5, partial, { formation: "1-2-1" }).ok).toBe(false);

    const overflow = [...squad5(), player("x1", "FWD", "starter", 9)];
    expect(validateSquadDraft(rules5, overflow).ok).toBe(false);
  });
});

describe("formation recalculation after a substitution", () => {
  it("re-shapes the team when the position mix changes", () => {
    // 7v7 starting shape: GK + DEF,DEF,DEF,MID,MID,FWD → 1-3-1-1
    const squad = squad7();
    const shape = suggestFormation(
      squad.filter((p) => p.slot === "starter" && p.position !== "GK"),
      "7v7",
      "1-3-1-1",
    );
    expect(shape.lines.reduce((a, b) => a + b, 0)).toBe(6);

    // swap a defender for a midfielder
    const result = applySubstitution(rules7, squad, "def1", "s1", "1-3-1-1");
    expect("error" in result).toBe(false);
    if ("error" in result) return;

    expect(result.players.filter((p) => p.slot === "starter")).toHaveLength(7);
    expect(result.players.find((p) => p.id === "def1")?.slot).toBe("sub");
    expect(result.players.find((p) => p.id === "s1")?.slot).toBe("starter");

    const outfield = result.players.filter((p) => p.slot === "starter" && p.position !== "GK");
    expect(outfield).toHaveLength(6);
    const formation = FORMATIONS["7v7"].find((f) => f.label === result.formation);
    expect(formation).toBeDefined();
    expect(formation!.lines.reduce((a, b) => a + b, 0)).toBe(6);
    // one fewer defender available → the shape must have changed
    expect(outfield.filter((p) => p.position === "DEF")).toHaveLength(2);
  });

  it("refuses illegal goalkeeper changes", () => {
    const squad = squad5();
    expect(applySubstitution(rules5, squad, "gk1", "sub3", "1-2-1")).toHaveProperty("error");
    expect(applySubstitution(rules5, squad, "mid1", "sub1", "1-2-1")).toHaveProperty("error");
    expect(applySubstitution(rules5, squad, "mid1", "res1", "1-2-1")).toHaveProperty("error");
  });

  it("suggests a formation that places every outfield player", () => {
    const outfield = squad7().filter((p) => p.slot === "starter" && p.position !== "GK");
    const shape = suggestFormation(outfield, "7v7", null);
    const laid = layoutFormation(outfield, shape);
    expect(laid.unplaced).toHaveLength(0);
    expect(laid.slots).toHaveLength(6);
    const ys = laid.slots.map((s) => s.y);
    expect(Math.min(...ys)).toBeLessThan(Math.max(...ys));
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
