import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { createClient } from "@/lib/supabase/server";
import { enforceLimits, guardWrite } from "@/lib/request-guard";
import { pendingMfaFactor, setMfaFlag } from "@/lib/mfa";

export const dynamic = "force-dynamic";

const schema = z.object({
  factorId: z.string().uuid(),
  code: z.string().regex(/^\d{6}$/),
});

/** Which factor the half-signed-in session must answer (used after Google or email-link sign-in). */
export async function GET() {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Not authenticated" }, { status: 401 });
  const pending = await pendingMfaFactor(supabase);
  if (!pending) return NextResponse.json({ error: "No verification needed" }, { status: 404 });
  return NextResponse.json({ factorId: pending.factorId });
}

/** Checks an authenticator code. Finishes sign-in, or finishes turning two-step on. */
export async function POST(req: NextRequest) {
  const blocked = guardWrite(req);
  if (blocked) return blocked;

  const parsed = schema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json({ error: "Enter the 6-digit code from your authenticator app" }, { status: 422 });
  }

  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Not authenticated" }, { status: 401 });

  const limited = await enforceLimits(req, [
    { name: "mfa-verify", limit: 10, windowSeconds: 600, subject: user.id },
  ]);
  if (limited) return limited;

  const { error } = await supabase.auth.mfa.challengeAndVerify({
    factorId: parsed.data.factorId,
    code: parsed.data.code,
  });
  if (error) {
    return NextResponse.json({ error: "That code did not work. Check your authenticator app and try again." }, { status: 400 });
  }

  if (user.app_metadata?.mfa_enrolled !== true) {
    try {
      await setMfaFlag(user.id, true);
    } catch (err) {
      console.error("[mfa]", err instanceof Error ? err.message : "flag update failed");
      return NextResponse.json({ error: "Could not finish turning on two-step verification. Try again." }, { status: 500 });
    }
  }
  return NextResponse.json({ ok: true });
}
