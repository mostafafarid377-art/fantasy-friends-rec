import { createClient } from "@/lib/supabase/server";
import { resolveIdentity } from "@/lib/identity";

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
 * the verified Supabase Auth token. Profile metadata is never used for access
 * control; it is presentation data only.
 */
export async function getSessionProfile(client?: Awaited<ReturnType<typeof createClient>>): Promise<SessionUser | null> {
  const supabase = client ?? await createClient();
  const user = await resolveIdentity(supabase);
  if (!user) return null;

  const { data: profile } = await supabase
    .from("profiles")
    .select("id,email,username,display_name,avatar_url,bio,email_verified_at,created_at")
    .eq("id", user.id)
    .maybeSingle();

  const metadata = user.metadata;
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
    // Mirrors auth.users.email_confirmed_at through a database trigger.
    emailVerified: Boolean(profile?.email_verified_at),
    createdAt: profile?.created_at ?? "",
  };
}

export async function destroySession() {
  const supabase = await createClient();
  await supabase.auth.signOut();
}
