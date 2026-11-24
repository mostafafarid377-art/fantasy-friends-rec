import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { createClient } from "@/lib/supabase/server";
import { rateLimitUser } from "@/lib/server/rate-limit";

const schema = z.object({ captchaToken: z.string().min(1).max(2048).optional() });

export async function POST(req: NextRequest) {
  const supabase = await createClient();
  const { data: { user }, error: userError } = await supabase.auth.getUser();
  if (userError || !user?.email) {
    return NextResponse.json({ error: "Sign in to request a new verification email" }, { status: 401 });
  }

  // Optional Turnstile token — forwarded only when the caller completed a
  // challenge. Callers that never render one are unaffected.
  const body = await req.json().catch(() => null);
  const parsed = schema.safeParse(body ?? {});
  if (!parsed.success) {
    return NextResponse.json({ error: "Check the highlighted fields" }, { status: 422 });
  }
  const { captchaToken } = parsed.data;

  const limited = await rateLimitUser("auth.resend", user.id);
  if (limited) return limited;

  const origin = req.headers.get("origin") ?? new URL(req.url).origin;
  const { error } = await supabase.auth.resend({
    type: "signup",
    email: user.email,
    options: {
      emailRedirectTo: `${origin}/auth/callback?next=/dashboard`,
      captchaToken: captchaToken ?? undefined,
    },
  });
  if (error) return NextResponse.json({ error: error.message }, { status: 400 });
  return NextResponse.json({ ok: true });
}
