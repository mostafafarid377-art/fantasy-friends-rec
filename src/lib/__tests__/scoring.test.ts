import { describe, expect, it } from "vitest";
import {
  computeManagerPoints,
  computePlayerPoints,
  usableRules,
  type ScoringRule,
} from "@/lib/scoring";
import type { Position } from "@/lib/domain";

const rules: ScoringRule[] = [
  { position: "FWD", category: "goal", points: 4, status: "approved" },
  { position: "MID", category: "goal", points: 5, status: "approved" },
  { position: "DEF", category: "goal", points: 6, status: "approved" },
  { position: "GK", category: "clean_sheet", points: 3, status: "approved" },
  { position: "DEF", category: "clean_sheet", points: 4, status: "approved" },
  { position: "FWD", category: "clean_sheet", points: 0, status: "approved" },
  { position: "MID", category: "assist", points: 3, status: "approved" },
  { position: "FWD", category: "appearance", points: 1, status: "approved" },
  { position: "MID", category: "appearance", points: 1, status: "approved" },
  { position: "DEF", category: "appearance", points: 1, status: "approved" },
  { position: "GK", category: "appearance", points: 1, status: "approved" },
  { position: "MID", category: "yellow_card", points: -1, status: "approved" },
  { position: "MID", category: "penalty_saved", points: 3, status: "approved" },
  { position: "MID", category: "penalty_missed", points: -1, status: "approved" },
  { position: "DEF", category: "own_goal", points: -2, status: "approved" },
  { position: "FWD", category: "red_card", points: -3, status: "approved" },
];

const posOf: Record<string, Position> = {
  p_gk: "GK",
  p_def: "DEF",
  p_mid: "MID",
  p_fwd: "FWD",
};

const lineup = (ids: string[], slot: "starter" | "sub" = "starter") =>
  ids.map((id) => ({
    playerId: id,
    teamId: "teamA",
    position: posOf[id],
    slot,
  }));

const base = {
  rules,
  result: { teamAId: "teamA", teamBId: "teamB" },
  lineup: lineup(["p_gk", "p_def", "p_mid", "p_fwd"]),
  participants: ["p_gk", "p_def", "p_mid", "p_fwd"],
};

describe("position-based scoring", () => {
  it("scores goals differently per position", () => {
    const points = computePlayerPoints({
      ...base,
      lineup: lineup(["p_fwd", "p_mid", "p_def"]),
      participants: ["p_fwd", "p_mid", "p_def"],
      events: [
        { playerId: "p_fwd", teamId: "teamA", eventType: "goal" },
        { playerId: "p_mid", teamId: "teamA", eventType: "goal" },
        { playerId: "p_def", teamId: "teamA", eventType: "goal" },
      ],
    });

    const by = new Map(points.map((p) => [p.playerId, p]));
    expect(by.get("p_fwd")?.breakdown.find((b) => b.category === "goal")?.points).toBe(4);
    expect(by.get("p_mid")?.breakdown.find((b) => b.category === "goal")?.points).toBe(5);
    expect(by.get("p_def")?.breakdown.find((b) => b.category === "goal")?.points).toBe(6);
  });

  it("awards appearances and clean sheets only to participating starters", () => {
    const points = computePlayerPoints({
      ...base,
      lineup: [...lineup(["p_gk", "p_def"]), ...lineup(["p_mid"], "sub")],
      participants: ["p_gk", "p_def", "p_mid"],
      events: [],
    });
    const by = new Map(points.map((p) => [p.playerId, p]));

    expect(by.get("p_gk")?.breakdown.map((b) => b.category)).toEqual(
      expect.arrayContaining(["appearance", "clean_sheet"]),
    );
    expect(by.get("p_def")?.breakdown.map((b) => b.category)).toEqual(
      expect.arrayContaining(["appearance", "clean_sheet"]),
    );
    // a substitute who came on gets an appearance but no clean sheet
    expect(by.get("p_mid")?.breakdown.map((b) => b.category)).toEqual(["appearance"]);
    expect(by.get("p_gk")?.points).toBe(1 + 3);
    expect(by.get("p_def")?.points).toBe(1 + 4);
  });

  it("withholds the clean sheet when the team concedes", () => {
    const points = computePlayerPoints({
      ...base,
      events: [{ playerId: "p_fwd", teamId: "teamB", eventType: "goal" }],
    });
    const gk = points.find((p) => p.playerId === "p_gk");
    expect(gk?.breakdown.some((b) => b.category === "clean_sheet")).toBe(false);
    expect(gk?.points).toBe(1);
  });

  it("counts assists, cards and never scores players who did not play", () => {
    const points = computePlayerPoints({
      ...base,
      participants: ["p_gk", "p_def", "p_mid"],
      events: [
        { playerId: "p_fwd", teamId: "teamA", eventType: "goal", assistPlayerId: "p_mid" },
        { playerId: "p_mid", teamId: "teamA", eventType: "yellow_card" },
      ],
    });
    const by = new Map(points.map((p) => [p.playerId, p]));
    expect(by.has("p_fwd")).toBe(false);
    expect(by.get("p_mid")?.breakdown.find((b) => b.category === "assist")?.points).toBe(3);
    expect(by.get("p_mid")?.breakdown.find((b) => b.category === "yellow_card")?.points).toBe(-1);
  });

  it("is deterministic — identical inputs produce identical totals", () => {
    const input = {
      ...base,
      events: [
        { playerId: "p_fwd", teamId: "teamA", eventType: "goal", assistPlayerId: "p_def" },
        { playerId: "p_mid", teamId: "teamA", eventType: "yellow_card" },
      ],
    };
    const a = computePlayerPoints(input);
    const b = computePlayerPoints(input);
    expect(a).toEqual(b);
  });
});

describe("draft rules are never used for official points", () => {
  it("drops an unapproved rule set entirely", () => {
    const draft: ScoringRule[] = rules.map((r) =>
      r.position === "MID" && r.category === "goal" ? { ...r, status: "draft" } : r,
    );
    expect(usableRules(draft)).toHaveLength(0);

    const points = computePlayerPoints({ ...base, rules: draft, events: [] });
    // no usable rules → every player scores zero
    expect(points.every((p) => p.points === 0)).toBe(true);
  });

  it("returns nothing for an empty rule set", () => {
    expect(usableRules([])).toHaveLength(0);
  });
});

describe("captain multiplier", () => {
  const playerPoints = new Map<string, number>([
    ["p_fwd", 8],
    ["p_mid", 5],
    ["p_def", 3],
    ["p_gk", 4],
  ]);
  const starters = [
    { playerId: "p_gk", position: "GK" as Position },
    { playerId: "p_def", position: "DEF" as Position },
    { playerId: "p_mid", position: "MID" as Position },
    { playerId: "p_fwd", position: "FWD" as Position },
  ];

  it("doubles the captain's points", () => {
    const result = computeManagerPoints({
      starters,
      captainId: "p_fwd",
      viceCaptainId: "p_mid",
      vicePolicy: "auto_captain",
      playerPoints,
      playedIds: new Set(starters.map((s) => s.playerId)),
      rules,
    });
    expect(result.points).toBe(4 + 3 + 5 + 8 * 2);
    expect(result.captainId).toBe("p_fwd");
    expect(result.breakdown.find((b) => b.playerId === "p_fwd")?.multiplier).toBe(2);
  });

  it("gives the double to the vice-captain when the captain does not play", () => {
    const result = computeManagerPoints({
      starters,
      captainId: "p_fwd",
      viceCaptainId: "p_mid",
      vicePolicy: "auto_captain",
      playerPoints,
      playedIds: new Set(["p_gk", "p_def", "p_mid"]),
      rules,
    });
    expect(result.captainId).toBe("p_mid");
    expect(result.breakdown.find((b) => b.playerId === "p_fwd")?.points).toBe(0);
    expect(result.breakdown.find((b) => b.playerId === "p_mid")?.points).toBe(10);
  });

  it("gives nobody the double when the policy forbids a vice stand-in", () => {
    const result = computeManagerPoints({
      starters,
      captainId: "p_fwd",
      viceCaptainId: "p_mid",
      vicePolicy: "none",
      playerPoints,
      playedIds: new Set(["p_gk", "p_def", "p_mid"]),
      rules,
    });
    expect(result.captainId).toBeNull();
    expect(result.points).toBe(4 + 3 + 5);
  });

  it("never scores players who did not appear", () => {
    const result = computeManagerPoints({
      starters,
      captainId: "p_fwd",
      viceCaptainId: "p_mid",
      vicePolicy: "auto_captain",
      playerPoints,
      playedIds: new Set(["p_gk"]),
      rules,
    });
    expect(result.points).toBe(4);
    expect(result.breakdown.filter((b) => b.points === 0)).toHaveLength(3);
  });
});


describe("scoring parity edge cases", () => {
  it("counts explicit assist events as well as goal assist_player_id attribution", () => {
    const points = computePlayerPoints({
      ...base,
      lineup: lineup(["p_mid"]),
      participants: ["p_mid"],
      events: [
        { playerId: "p_fwd", teamId: "teamA", eventType: "goal", assistPlayerId: "p_mid" },
        { playerId: "p_mid", teamId: "teamA", eventType: "assist" },
        { playerId: "p_mid", teamId: "teamA", eventType: "penalty_saved" },
        { playerId: "p_mid", teamId: "teamA", eventType: "penalty_missed" },
      ],
    });
    const mid = points[0];
    expect(mid.breakdown.find((b) => b.category === "assist")?.count).toBe(2);
    expect(mid.breakdown.find((b) => b.category === "penalty_saved")?.count).toBe(1);
    expect(mid.breakdown.find((b) => b.category === "penalty_missed")?.count).toBe(1);
  });

  it("counts an own goal against the offender team for clean-sheet eligibility", () => {
    const points = computePlayerPoints({
      ...base,
      lineup: [
        { playerId: "p_def", teamId: "teamA", position: "DEF", slot: "starter" },
        { playerId: "p_gk", teamId: "teamB", position: "GK", slot: "starter" },
      ],
      participants: ["p_def", "p_gk"],
      events: [{ playerId: "p_def", teamId: "teamA", eventType: "own_goal" }],
    });
    expect(points.find((p) => p.playerId === "p_def")?.breakdown.some((b) => b.category === "clean_sheet")).toBe(false);
    expect(points.find((p) => p.playerId === "p_gk")?.breakdown.some((b) => b.category === "clean_sheet")).toBe(true);
    expect(points.find((p) => p.playerId === "p_def")?.breakdown.find((b) => b.category === "own_goal")?.points).toBe(-2);
  });
});
