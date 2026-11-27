/**
 * Request identity.
 *
 * The caller is identified by the subject (`sub`) of the access token that
 * Supabase Auth signed. The token is verified locally against the project's
 * signing key (JWKS), so a hot request path no longer waits for a round trip
 * to the Auth server on every call.
 *
 * Only the verified subject is ever used for access control. Everything else a
 * token carries (email, user metadata) is presentation data and is treated as
 * unverified input: it can be rendered, but it never grants a permission.
 */

export type IdentitySource = "claims" | "auth";

export type Identity = {
  /** Subject (`sub`) of the verified access token. */
  id: string;
  email: string | null;
  metadata: Record<string, unknown>;
  /** Where the identity came from: local claim verification or the Auth server. */
  source: IdentitySource;
  /** Authenticator assurance level of the session ("aal1" = password only, "aal2" = second step done). */
  aal: string | null;
  /** True once the account has turned on two-step verification. */
  mfaEnrolled: boolean;
};

/** Minimal structural view of the Supabase client used for identity checks. */
export type IdentityClient = {
  auth: {
    getClaims?: () => Promise<{ data?: { claims?: unknown } | null; error?: unknown }>;
    getUser: () => Promise<{
      data?: { user?: { id?: unknown; email?: unknown; user_metadata?: unknown; app_metadata?: unknown } | null } | null;
      error?: unknown;
    }>;
  };
};

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

/**
 * Establishes the caller from the signed access token.
 *
 * Returns `null` when there is no usable session. An expired, tampered or
 * missing token never produces an identity: the claim check fails and the
 * Auth server confirms the session instead.
 */
export async function resolveIdentity(client: IdentityClient): Promise<Identity | null> {
  const identity = (await identityFromClaims(client)) ?? (await identityFromAuth(client));
  // An account with two-step verification is not signed in until the second
  // step is done. A password-only (aal1) session is treated as no session.
  if (identity && identity.mfaEnrolled && identity.aal !== "aal2") return null;
  return identity;
}

/**
 * Verifies the access token locally. The SDK validates the signature and the
 * expiry before returning the claims, so a valid `sub` here means Supabase
 * Auth issued this token.
 */
async function identityFromClaims(client: IdentityClient): Promise<Identity | null> {
  if (typeof client.auth.getClaims !== "function") return null;
  try {
    const { data, error } = await client.auth.getClaims();
    if (error || !data) return null;
    const claims = asRecord(data.claims);
    const subject = typeof claims.sub === "string" ? claims.sub.trim() : "";
    if (!subject) return null;
    return {
      id: subject,
      email: typeof claims.email === "string" ? claims.email : null,
      metadata: asRecord(claims.user_metadata),
      source: "claims",
      aal: typeof claims.aal === "string" ? claims.aal : null,
      mfaEnrolled: asRecord(claims.app_metadata).mfa_enrolled === true,
    };
  } catch {
    return null;
  }
}

/**
 * Fallback for environments the local verifier cannot handle (legacy
 * symmetric signing keys, missing WebCrypto) and for tokens the local
 * verifier rejected.
 */
async function identityFromAuth(client: IdentityClient): Promise<Identity | null> {
  try {
    const { data, error } = await client.auth.getUser();
    if (error || !data?.user) return null;
    const user = data.user;
    const subject = typeof user.id === "string" ? user.id.trim() : "";
    if (!subject) return null;
    return {
      id: subject,
      email: typeof user.email === "string" ? user.email : null,
      metadata: asRecord(user.user_metadata),
      source: "auth",
      aal: null,
      mfaEnrolled: asRecord(user.app_metadata).mfa_enrolled === true,
    };
  } catch {
    return null;
  }
}
