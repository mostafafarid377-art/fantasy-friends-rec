import { describe, expect, it } from "vitest";
import { motmStats } from "@/lib/motm";
import { managedMotmPhotoKey, motmPhotoUrl, MOTM_PHOTO_BUCKET } from "@/lib/motm-photo";

describe("motmStats", () => {
  it("reads points, goals and assists from the scoring record", () => {
    const breakdown = [
      { category: "goal", label: "Goal", count: 2, pointsPer: 4, points: 8 },
      { category: "assist", label: "Assist", count: 1, pointsPer: 3, points: 3 },
      { category: "appearance", label: "Appearance", count: 1, pointsPer: 1, points: 1 },
    ];
    expect(motmStats(12, breakdown)).toEqual({ points: 12, goals: 2, assists: 1 });
  });

  it("coerces a numeric-string points column", () => {
    expect(motmStats("7.5", [])).toEqual({ points: 7.5, goals: 0, assists: 0 });
  });

  it("falls back to the breakdown sum when points are missing", () => {
    const breakdown = [{ category: "goal", label: "Goal", count: 1, pointsPer: 4, points: 4 }];
    expect(motmStats(null, breakdown).points).toBe(4);
  });

  it("handles an absent breakdown without throwing", () => {
    expect(motmStats(3, null)).toEqual({ points: 3, goals: 0, assists: 0 });
    expect(motmStats(0, undefined)).toEqual({ points: 0, goals: 0, assists: 0 });
  });
});

describe("motmPhotoUrl", () => {
  const league = "league1";
  const match = "match1";
  const key = `${league}/${match}/123e4567-e89b-42d3-a456-426614174000.jpg`;

  it("builds a versioned proxy URL for a managed photo", () => {
    const url = motmPhotoUrl(`${MOTM_PHOTO_BUCKET}/${key}`, league, match);
    expect(url).toBe(`/api/leagues/${league}/matches/${match}/motm/photo?v=123e4567-e89b-42d3-a456-426614174000`);
  });

  it("passes through an external http link", () => {
    expect(motmPhotoUrl("https://cdn.example.com/p.jpg", league, match)).toBe("https://cdn.example.com/p.jpg");
  });

  it("rejects a null or malformed photo reference", () => {
    expect(motmPhotoUrl(null, league, match)).toBeNull();
    expect(motmPhotoUrl(`${MOTM_PHOTO_BUCKET}/other/${match}/123e4567-e89b-42d3-a456-426614174000.jpg`, league, match)).toBeNull();
    expect(motmPhotoUrl("not-a-url", league, match)).toBeNull();
  });
});

describe("managedMotmPhotoKey", () => {
  const league = "league1";
  const match = "match1";

  it("accepts a key scoped to the league and match", () => {
    expect(managedMotmPhotoKey(`${MOTM_PHOTO_BUCKET}/${league}/${match}/123e4567-e89b-42d3-a456-426614174000.jpg`, league, match))
      .toBe(`${league}/${match}/123e4567-e89b-42d3-a456-426614174000.jpg`);
  });

  it("rejects keys outside the match namespace or with extra segments", () => {
    expect(managedMotmPhotoKey(`${MOTM_PHOTO_BUCKET}/${league}/other/123e4567-e89b-42d3-a456-426614174000.jpg`, league, match)).toBeNull();
    expect(managedMotmPhotoKey(`${MOTM_PHOTO_BUCKET}/${league}/${match}/123e4567-e89b-42d3-a456-426614174000.jpg/extra`, league, match)).toBeNull();
    expect(managedMotmPhotoKey(`${MOTM_PHOTO_BUCKET}/${league}/${match}/not-a-uuid.jpg`, league, match)).toBeNull();
  });
});
