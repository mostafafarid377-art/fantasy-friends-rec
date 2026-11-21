import { safeAuthPath } from "@/lib/auth-redirect";
import { readGoogleStartToken } from "@/lib/supabase/google-start-token";
import SignupForm from "./SignupForm";

export default async function SignupPage({ searchParams }: { searchParams: Promise<{ next?: string | string[] }> }) {
  const { next } = await searchParams;
  return <SignupForm next={safeAuthPath(typeof next === "string" ? next : null)} googleStartToken={await readGoogleStartToken()} />;
}
