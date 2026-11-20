import { safeAuthPath } from "@/lib/auth-redirect";
import { googleAppOrigin } from "@/lib/supabase/google-oauth";
import SignupForm from "./SignupForm";

export default async function SignupPage({ searchParams }: { searchParams: Promise<{ next?: string | string[] }> }) {
  const { next } = await searchParams;
  return <SignupForm next={safeAuthPath(typeof next === "string" ? next : null)} googleEnabled={Boolean(googleAppOrigin())} />;
}
