import { safeAuthPath } from "@/lib/auth-redirect";
import { readGoogleStartToken } from "@/lib/supabase/google-start-token";
import { GOOGLE_START_ERROR } from "@/lib/google-sign-in";
import { ResumeSession } from "@/components/ResumeSession";
import LoginForm from "./LoginForm";

const messages = new Map([
  ["google_start_failed", GOOGLE_START_ERROR],
  ["session_unavailable", "We couldn’t load your saved session. You can sign in again below."],
  ["google_cancelled", "Google sign-in was cancelled. You can try again or continue with email."],
  ["google_failed", "We couldn’t complete Google sign-in. Try again in this browser, or continue with email."],
  ["google_unavailable", "Google sign-in is unavailable right now. Please continue with email or try again later."],
  ["email_missing_code", "The confirmation link is missing a code. Request a new link and open it in the same browser."],
  ["email_invalid_link", "The email link is invalid or expired. Request a new one and open it in the same browser."],
]);

export default async function LoginPage({ searchParams }: { searchParams: Promise<{ next?: string | string[]; auth_error?: string | string[] }> }) {
  const { next, auth_error } = await searchParams;
  const destination = safeAuthPath(typeof next === "string" ? next : null);
  const resumeTo = /^\/login\/?(?:[?#]|$)/.test(destination) ? "/dashboard" : destination;
  return <>
    {!auth_error && <ResumeSession destination={resumeTo} />}
    <LoginForm next={resumeTo} googleStartToken={await readGoogleStartToken()}
      authError={typeof auth_error === "string" ? messages.get(auth_error) : undefined} />
  </>;
}
