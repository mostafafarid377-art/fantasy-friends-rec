import { expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

// The handler is the single choke point that turns a thrown error into an
// HTTP response. An unexpected (non-ApiError) failure must never leak its
// internal message — SQL fragments, file paths or library internals — to the
// client; only ApiError messages, which are written for users, may cross.

const { handler, ApiError } = await vi.importActual<typeof import("@/lib/server")>("@/lib/server");
const req = () => new NextRequest("http://local.test/api/x");

it("hides internal error details from a 500 response", async () => {
  const secret = "duplicate key value violates unique constraint \"profiles_username_key\"";
  const route = handler(() => { throw new Error(secret); });
  const res = await route(req());
  expect(res.status).toBe(500);
  const body = await res.json();
  expect(body.error).toBe("Unexpected error");
  expect(JSON.stringify(body)).not.toContain(secret);
});

it("still returns a deliberate ApiError message to the client", async () => {
  const route = handler(() => { throw new ApiError("That username is already taken", 409); });
  const res = await route(req());
  expect(res.status).toBe(409);
  expect((await res.json()).error).toBe("That username is already taken");
});
