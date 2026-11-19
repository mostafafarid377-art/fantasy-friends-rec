import { redirect } from "next/navigation";
import type { ReactNode } from "react";
import { getSessionProfile } from "@/lib/auth";
import { AppShell } from "@/components/AppShell";
import { AppProvider } from "@/components/LeagueContext";

export const dynamic = "force-dynamic";

export default async function ProtectedLayout({ children }: { children: ReactNode }) {
  const user = await getSessionProfile();
  if (!user) redirect("/login");

  return (
    <AppProvider>
      <AppShell>{children}</AppShell>
    </AppProvider>
  );
}
