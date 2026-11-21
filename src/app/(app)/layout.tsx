import Link from "next/link";
import { redirect } from "next/navigation";
import type { ReactNode } from "react";
import { getSessionSnapshot } from "@/lib/session";
import { AppShell } from "@/components/AppShell";
import { AppProvider } from "@/components/LeagueContext";

export const dynamic = "force-dynamic";

export default async function ProtectedLayout({ children }: { children: ReactNode }) {
  let session: Awaited<ReturnType<typeof getSessionSnapshot>>;
  try {
    session = await getSessionSnapshot();
  } catch {
    // A session/data failure must never render protected content or trap a
    // returning user on a raw error page. Don't discard their cookies.
    return <main className="mx-auto max-w-lg px-5 py-16">
      <h1 className="text-3xl text-chalk">Couldn’t open the app</h1>
      <p className="mt-3 text-sage">We couldn’t load your session right now. Try reopening the app or sign in again.</p>
      <div className="mt-6 flex flex-wrap gap-4">
        <Link className="text-green underline" href="/">Back to homepage</Link>
        <Link className="text-green underline" href="/login?auth_error=session_unavailable">Sign in again</Link>
      </div>
    </main>;
  }
  if (!session.user) redirect("/login");

  return (
    <AppProvider initialSession={session}>
      <AppShell>{children}</AppShell>
    </AppProvider>
  );
}
