import { randomUUID } from "node:crypto";
import { NextRequest } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { ApiError, handler, ok, requireIdentity } from "@/lib/server";
import { enforceLimits } from "@/lib/request-guard";
import { setMfaFlag } from "@/lib/mfa";

export const dynamic = "force-dynamic";

/** Is two-step verification on for this account? */
export const GET = handler(async () => {
  const supabase = await createClient();
  await requireIdentity(supabase);
  const { data } = await supabase.auth.mfa.listFactors();
  const factor = data?.totp?.[0];
  return ok({ enabled: Boolean(factor), factorId: factor?.id ?? null });
});

/** Start setup: returns a QR code and a text secret for the authenticator app. */
export const POST = handler(async (req: NextRequest) => {
  const supabase = await createClient();
  const identity = await requireIdentity(supabase);
  const limited = await enforceLimits(req, [
    { name: "mfa-enroll", limit: 5, windowSeconds: 3600, subject: identity.id },
  ]);
  if (limited) return limited;

  const { data: factors } = await supabase.auth.mfa.listFactors();
  if (factors?.totp?.length) throw new ApiError("Two-step verification is already on", 409);
  // Remove an abandoned, never-verified attempt before starting a new one.
  for (const factor of factors?.all ?? []) {
    if (factor.status === "unverified") await supabase.auth.mfa.unenroll({ factorId: factor.id });
  }
  const { data, error } = await supabase.auth.mfa.enroll({
    factorType: "totp",
    friendlyName: `Authenticator ${randomUUID().slice(0, 8)}`,
  });
  if (error || !data) throw new ApiError("Could not start setup. Try again.", 400);
  return ok({ factorId: data.id, qrCode: data.totp.qr_code, secret: data.totp.secret });
});

/** Turn two-step verification off. The session must already have passed it. */
export const DELETE = handler(async () => {
  const supabase = await createClient();
  const identity = await requireIdentity(supabase);
  const { data: factors } = await supabase.auth.mfa.listFactors();
  // Clear the flag first: if removal then fails the account is still covered
  // by the authenticator, and it is never left flagged with no factor.
  await setMfaFlag(identity.id, false);
  for (const factor of factors?.all ?? []) {
    const { error } = await supabase.auth.mfa.unenroll({ factorId: factor.id });
    if (error) throw new ApiError("Could not turn off two-step verification", 400);
  }
  return ok({ enabled: false });
});
