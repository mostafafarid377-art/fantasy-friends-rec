import { describe, expect, it } from "vitest";
import { z } from "zod";

// Mirrors the profile PATCH schema in src/app/api/me/route.ts.
// A stored javascript:, data: or vbscript: URL must never pass validation;
// only real web URLs (https/http) or an explicit clear are accepted.
const patchSchema = z.object({
  avatarUrl: z.url({ protocol: /^https?$/ }).nullable().optional().or(z.literal("").transform(() => null)),
});

describe("profile avatar URL validation", () => {
  it("accepts a real https image URL", () => {
    expect(patchSchema.safeParse({ avatarUrl: "https://lh3.googleusercontent.com/a/photo" }).success).toBe(true);
  });

  it("accepts an http web URL", () => {
    expect(patchSchema.safeParse({ avatarUrl: "http://cdn.example/x.png" }).success).toBe(true);
  });

  it("accepts clearing the avatar with null or an empty string", () => {
    expect(patchSchema.safeParse({ avatarUrl: null }).success).toBe(true);
    const cleared = patchSchema.safeParse({ avatarUrl: "" });
    expect(cleared.success).toBe(true);
    if (cleared.success) expect(cleared.data.avatarUrl).toBeNull();
  });

  it("rejects a javascript: URL", () => {
    expect(patchSchema.safeParse({ avatarUrl: "javascript:alert(1)" }).success).toBe(false);
  });

  it("rejects a data: URL", () => {
    expect(patchSchema.safeParse({ avatarUrl: "data:image/svg+xml,<svg onload=alert(1)>" }).success).toBe(false);
  });

  it("rejects a vbscript: URL", () => {
    expect(patchSchema.safeParse({ avatarUrl: "vbscript:msgbox(1)" }).success).toBe(false);
  });

  it("rejects a scheme-relative URL", () => {
    expect(patchSchema.safeParse({ avatarUrl: "//evil.example/x.png" }).success).toBe(false);
  });
});
