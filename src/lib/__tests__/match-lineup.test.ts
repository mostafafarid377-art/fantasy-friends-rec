import { describe, expect, it } from "vitest";
import { lineupEquals, normalizeLineup } from "@/lib/match-lineup";

describe("normalizeLineup", () => {
  it("drops duplicate assignments and keeps each player in a single slot (starters win)", () => {
    expect(normalizeLineup({ starters: ["a", "a", "b"], subs: ["b", "c", "c"] }))
      .toEqual({ starters: ["a", "b"], subs: ["c"] });
  });

  it("ignores empty ids", () => {
    expect(normalizeLineup({ starters: ["", "a"], subs: [] })).toEqual({ starters: ["a"], subs: [] });
  });
});

describe("lineupEquals", () => {
  const saved = { starters: ["p0", "p1", "p2", "p3", "p4"], subs: ["p5"] };

  it("matches an identical selection", () => {
    expect(lineupEquals(saved, { starters: [...saved.starters], subs: [...saved.subs] })).toBe(true);
  });

  it("ignores pick order within a slot (revert-to-saved stays saved)", () => {
    expect(lineupEquals(saved, { starters: ["p4", "p3", "p2", "p1", "p0"], subs: ["p5"] })).toBe(true);
  });

  it("detects a starter change", () => {
    expect(lineupEquals(saved, { starters: ["p0", "p1", "p2", "p3", "p6"], subs: ["p5"] })).toBe(false);
  });

  it("detects a bench change", () => {
    expect(lineupEquals(saved, { starters: saved.starters, subs: ["p5", "p6"] })).toBe(false);
    expect(lineupEquals(saved, { starters: saved.starters, subs: [] })).toBe(false);
  });

  it("detects a slot move between starters and bench", () => {
    expect(lineupEquals(saved, { starters: ["p1", "p2", "p3", "p4", "p5"], subs: ["p0"] })).toBe(false);
  });

  it("normalizes duplicate entries in a draft before comparing", () => {
    expect(lineupEquals(saved, { starters: ["p0", "p0", "p1", "p2", "p3", "p4"], subs: ["p5", "p5"] })).toBe(true);
  });

  it("normalizes a player listed in both slots (starter wins)", () => {
    expect(lineupEquals(saved, { starters: saved.starters, subs: ["p4", "p5"] })).toBe(true);
  });

  it("treats empty selections as equal, and empty versus saved as different", () => {
    expect(lineupEquals({ starters: [], subs: [] }, { starters: [], subs: [] })).toBe(true);
    expect(lineupEquals(saved, { starters: [], subs: [] })).toBe(false);
  });
});
