import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { createClient } from "@/lib/supabase/server";

const schema = z.object({
  email: z.string().email(),
  username: z.string().min(3).max(24).regex(/^[a-z0-9_]+$/i),
  displayName: z.string().min(2).max(60),
  password: z.string().min(8).max(128),
  captchaToken: z.string().min(1).max(2048).optional(),
});

export async function POST(req: NextRequest) {
  const body = await req.json().catch(() => null);
  const parsed = schema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: "Check the highlighted fields", details: parsed.error.flatten().fieldErrors },
      { status: 422 },
    );
  }

  const { email, username, displayName, password, captchaToken } = parsed.data;
  const supabase = await createClient();
  const origin = req.headers.get("origin") ?? new URL(req.url).origin;

  const { data, error } = await supabase.auth.signUp({
    email: email.trim().toLowerCase(),
    password,
    options: {
      data: { username, display_name: displayName },
      emailRedirectTo: `${origin}/auth/callback?next=/dashboard`,
      ...(captchaToken ? { captchaToken } : {}),
    },
  });

  if (error) {
    const duplicate = /already registered|already exists|user already/i.test(error.message);
    return NextResponse.json(
      { error: duplicate ? "An account with that email already exists" : error.message },
      { status: duplicate ? 409 : 400 },
    );
  }

  // With confirmation enabled GoTrue may obfuscate an existing account.
  // A verification request is not proof of a newly created account.
  if (!data.session) {
    if (!data.user?.id) return NextResponse.json({ error: "Account request could not be confirmed" }, { status: 502 });
    return NextResponse.json({ requiresEmailVerification: true }, { status: 202 });
  }
  if (!data.user?.id || data.session.user.id !== data.user.id) {
    return NextResponse.json({ error: "Account session could not be confirmed" }, { status: 502 });
  }
  return NextResponse.json({ user: { id: data.user.id }, requiresEmailVerification: false }, { status: 201 });
}
