import { describe, expect, it, vi } from "vitest";
import { resolveIdentity, type IdentityClient } from "@/lib/identity";

type ClaimOptions = {
  claims?: unknown;
  claimsError?: unknown;
  user?: unknown;
  userError?: unknown;
  withoutClaims?: boolean;
};

function makeClient(options: ClaimOptions) {
  const getClaims = vi.fn(async () => ({
    data: options.claims === undefined ? null : { claims: options.claims },
    error: options.claimsError ?? null,
  }));
  const getUser = vi.fn(async () => ({
    data: options.user === undefined ? null : { user: options.user },
    error: options.userError ?? null,
  }));
  const client: IdentityClient = {
    auth: {
      getClaims: options.withoutClaims ? undefined : getClaims,
      getUser,
    },
  };
  return { client, getClaims, getUser };
}

describe("request identity", () => {
  it("takes the subject from the locally verified access token", async () => {
    const { client, getUser } = makeClient({
      claims: { sub: "user-1", email: "manager@example.test", user_metadata: { username: "manager" } },
    });
    const identity = await resolveIdentity(client);
    expect(identity).toEqual({
      id: "user-1",
      email: "manager@example.test",
      metadata: { username: "manager" },
      source: "claims",
    });
    expect(getUser).not.toHaveBeenCalled();
  });

  it("confirms the session with the Auth server when the token cannot be verified locally", async () => {
    const { client, getUser } = makeClient({
      claimsError: { name: "AuthInvalidJwtError", message: "Invalid JWT signature" },
      user: { id: "user-2", email: "fallback@example.test", user_metadata: {} },
    });
    const identity = await resolveIdentity(client);
    expect(identity).toMatchObject({ id: "user-2", email: "fallback@example.test", source: "auth" });
    expect(getUser).toHaveBeenCalledTimes(1);
  });

  it("rejects an expired or tampered token instead of trusting it", async () => {
    const { client } = makeClient({
      claimsError: { name: "AuthInvalidJwtError", message: "JWT validation failed" },
      userError: { name: "AuthSessionMissingError", message: "Auth session missing!" },
    });
    expect(await resolveIdentity(client)).toBeNull();
  });

  it("never accepts a token without a subject", async () => {
    const { client, getUser } = makeClient({
      claims: { email: "manager@example.test" },
      userError: { message: "no session" },
    });
    expect(await resolveIdentity(client)).toBeNull();
    expect(getUser).toHaveBeenCalledTimes(1);
  });

  it("treats email and metadata as presentation data only", async () => {
    const { client } = makeClient({ claims: { sub: "user-3", email: 42, user_metadata: "not-an-object" } });
    const identity = await resolveIdentity(client);
    expect(identity).toMatchObject({ id: "user-3", email: null, metadata: {} });
  });

  it("falls back to the Auth server when the runtime cannot verify claims", async () => {
    const { client, getUser } = makeClient({ user: { id: "user-4" }, withoutClaims: true });
    const identity = await resolveIdentity(client);
    expect(identity).toMatchObject({ id: "user-4", source: "auth" });
    expect(getUser).toHaveBeenCalledTimes(1);
  });

  it("survives a client that throws while checking the session", async () => {
    const client: IdentityClient = {
      auth: {
        getClaims: async () => { throw new Error("boom"); },
        getUser: async () => { throw new Error("boom"); },
      },
    };
    expect(await resolveIdentity(client)).toBeNull();
  });
});
