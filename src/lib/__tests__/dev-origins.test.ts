import { describe, expect, it } from "vitest";

/**
 * Regression pin for the dead-hydration incident (CI run 45521666919):
 * Next's dev server cross-site protection allowlists `localhost` by default
 * but not `127.0.0.1`. Browsing the dev server via http://127.0.0.1 made
 * every /_next/hmr WebSocket handshake fail with 403; the dev Flight debug
 * channel rides that socket, so `hydrate()` awaited a payload that never
 * resolved and client JS stayed dead with zero console errors. The E2E
 * suite drives the app at 127.0.0.1, so the dev config must allowlist it.
 */

// NODE_ENV is "test" under vitest, so the config module evaluates its
// normal (non-preview) branch — the one the dev server and E2E suite use.
import nextConfig from "../../../next.config";

describe("dev-server origin allowlist (dead-hydration regression)", () => {
  it("allowlists 127.0.0.1 for dev-internal requests", () => {
    const origins = (nextConfig as { allowedDevOrigins?: string[] }).allowedDevOrigins;
    expect(origins, "next.config normal branch must set allowedDevOrigins").toBeDefined();
    expect(origins).toContain("127.0.0.1");
  });

  it("allowlists loopback only — no wildcard or external origins", () => {
    const origins = (nextConfig as { allowedDevOrigins?: string[] }).allowedDevOrigins ?? [];
    for (const origin of origins) {
      expect(origin).toMatch(/^(127\.0\.0\.1|localhost|\*?\.?localhost)$/);
    }
  });
});
