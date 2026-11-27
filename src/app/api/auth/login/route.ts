import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { createClient } from "@/lib/supabase/server";
import { captchaMissing, enforceLimits, guardWrite } from "@/lib/request-guard";
import { pendingMfaFactor } from "@/lib/mfa";

const schema = z.object({
  email: z.string().email(),
  password: z.string().min(1),
  captchaToken: z.string().min(1).max(2048).optional(),
});

export async function POST(req: NextRequest) {
  const blocked = guardWrite(req);
  if (blocked) return blocked;

  const body = await req.json().catch(() => null);
  const parsed = schema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: "Enter your email and password" }, { status: 422 });
  }

  const { captchaToken } = parsed.data;
  if (captchaMissing(captchaToken)) {
    return NextResponse.json({ error: "Complete the verification challenge" }, { status: 422 });
  }
  const email = parsed.data.email.trim().toLowerCase();
  const limited = await enforceLimits(req, [
    { name: "login-ip", limit: 30, windowSeconds: 600 },
    { name: "login-email", limit: 8, windowSeconds: 600, subject: email },
  ]);
  if (limited) return limited;

  const supabase = await createClient();
  const { data, error } = await supabase.auth.signInWithPassword({
    email,
    password: parsed.data.password,
    options: captchaToken ? { captchaToken } : undefined,
  });

  if (error || !data.user) {
    return NextResponse.json({ error: "Incorrect email or password" }, { status: 401 });
  }

  // A second step is required: the session is only half signed in until the
  // authenticator code is verified, and the app's API refuses it until then.
  const mfa = await pendingMfaFactor(supabase);
  if (mfa) return NextResponse.json({ mfaRequired: true, factorId: mfa.factorId });

  const { data: profile } = await supabase
    .from("profiles")
    .select("username,display_name,avatar_url,bio")
    .eq("id", data.user.id)
    .maybeSingle();

  return NextResponse.json({
    user: {
      id: data.user.id,
      email: data.user.email,
      username: profile?.username ?? data.user.user_metadata?.username ?? "",
      displayName: profile?.display_name ?? data.user.user_metadata?.display_name ?? "",
      avatarUrl: profile?.avatar_url ?? null,
      bio: profile?.bio ?? null,
      emailVerified: Boolean(data.user.email_confirmed_at),
      createdAt: data.user.created_at,
    },
  });
}
