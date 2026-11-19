import { redirect } from "next/navigation";
import type { ReactNode } from "react";
import { getSessionSnapshot } from "@/lib/session";
import { AppShell } from "@/components/AppShell";
import { AppProvider } from "@/components/LeagueContext";

export const dynamic = "force-dynamic";

export default async function ProtectedLayout({ children }: { children: ReactNode }) {
  const session = await getSessionSnapshot();
  if (!session.user) redirect("/login");

  return (
    <AppProvider initialSession={session}>
      <AppShell>{children}</AppShell>
    </AppProvider>
  );
}
