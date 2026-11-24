import { describe, expect, it } from "vitest";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

// Regression: /images/floodlit-pitch.jpg and /images/tunnel.jpg were referenced
// by the auth and marketing pages but never committed, so every page served a
// 404. This walks the source and asserts every referenced public asset exists.

const SRC = join(__dirname, "../..");
const PUBLIC = join(__dirname, "../../..", "public");

function* walk(dir: string): Generator<string> {
  for (const entry of readdirSync(dir)) {
    if (entry === "node_modules" || entry.startsWith(".")) continue;
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) yield* walk(full);
    else if (/\.(tsx?|css)$/.test(entry)) yield full;
  }
}

function referencedPublicAssets(): string[] {
  const refs = new Set<string>();
  for (const file of walk(SRC)) {
    const text = readFileSync(file, "utf8");
    for (const match of text.matchAll(/["'(]\/(images|icons|assets)\/[^"')]+\.(?:jpg|jpeg|png|webp|svg|gif|ico|woff2?)["')]/g)) {
      refs.add(match[0].slice(1, -1));
    }
  }
  return [...refs].sort();
}

describe("referenced public assets", () => {
  it("every /images/* (or similar) reference resolves to a real file in public/", () => {
    const refs = referencedPublicAssets();
    // The two known design assets must be referenced (guards the scan itself).
    expect(refs).toContain("/images/floodlit-pitch.jpg");
    expect(refs).toContain("/images/tunnel.jpg");
    for (const ref of refs) {
      expect(existsSync(join(PUBLIC, ref)), `${ref} is referenced but missing from public/`).toBe(true);
    }
  });

  it("the design images are real JPEGs of a reasonable size", () => {
    for (const name of ["floodlit-pitch.jpg", "tunnel.jpg"]) {
      const path = join(PUBLIC, "images", name);
      expect(existsSync(path)).toBe(true);
      const bytes = readFileSync(path);
      expect(bytes.subarray(0, 3).toString("hex")).toBe("ffd8ff"); // JPEG magic
      expect(bytes.length).toBeGreaterThan(10_000);
      expect(bytes.length).toBeLessThan(2_000_000); // keep hero art lean
    }
  });
});
