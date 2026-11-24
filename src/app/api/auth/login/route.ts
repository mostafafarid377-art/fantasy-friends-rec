import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { createClient } from "@/lib/supabase/server";
import { rateLimitAuth } from "@/lib/server/rate-limit";

const schema = z.object({
  email: z.string().email(),
  password: z.string().min(1),
  captchaToken: z.string().min(1).max(2048).optional(),
});

export async function POST(req: NextRequest) {
  const body = await req.json().catch(() => null);
  const parsed = schema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: "Enter your email and password" }, { status: 422 });
  }

  const limited = await rateLimitAuth(req, "auth.login", parsed.data.email);
  if (limited) return limited;

  const supabase = await createClient();
  const { captchaToken } = parsed.data;
  const { data, error } = await supabase.auth.signInWithPassword({
    email: parsed.data.email.trim().toLowerCase(),
    password: parsed.data.password,
    options: captchaToken ? { captchaToken } : undefined,
  });

  if (error || !data.user) {
    return NextResponse.json({ error: "Incorrect email or password" }, { status: 401 });
  }

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
