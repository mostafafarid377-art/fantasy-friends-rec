import { createClient } from "@/lib/supabase/server";

export type SessionUser = {
  id: string;
  email: string;
  username: string;
  displayName: string;
  avatarUrl: string | null;
  bio: string | null;
  emailVerified: boolean;
  createdAt: string;
};

/**
 * Native Supabase Auth session adapter.
 * Keeps the existing app's SessionUser shape while identity comes only from
 * the verified Supabase Auth user. Profile metadata is never used for access
 * control; it is presentation data only.
 */
export async function getSessionProfile(): Promise<SessionUser | null> {
  const supabase = await createClient();
  const { data: { user }, error } = await supabase.auth.getUser();
  if (error || !user) return null;

  const { data: profile } = await supabase
    .from("profiles")
    .select("id,email,username,display_name,avatar_url,bio,email_verified_at,created_at")
    .eq("id", user.id)
    .maybeSingle();

  const metadata = user.user_metadata ?? {};
  const username =
    profile?.username ??
    (typeof metadata.username === "string" ? metadata.username : user.email?.split("@")[0] ?? "manager");
  const displayName =
    profile?.display_name ??
    (typeof metadata.display_name === "string" ? metadata.display_name : username);

  return {
    id: user.id,
    email: user.email ?? profile?.email ?? "",
    username,
    displayName,
    avatarUrl: profile?.avatar_url ?? null,
    bio: profile?.bio ?? null,
    emailVerified: Boolean(user.email_confirmed_at),
    createdAt: user.created_at,
  };
}

export async function destroySession() {
  const supabase = await createClient();
  await supabase.auth.signOut();
}
