import type { Metadata } from "next";
import Link from "next/link";
import type { ReactNode } from "react";
import { Wordmark } from "@/components/Mark";

export const metadata: Metadata = { title: "Fantasy Friends" };

export default function MarketingLayout({ children }: { children: ReactNode }) {
  return (
    <div className="relative min-h-dvh bg-pitch-950">
      <header className="relative z-30 flex h-16 items-center justify-between px-5 md:px-10">
        <Link href="/">
          <Wordmark />
        </Link>
        <nav className="flex items-center gap-1.5 md:gap-3">
          <Link href="/login" className="px-3 py-2 text-[14px] text-sage transition-colors hover:text-chalk">
            Sign in
          </Link>
          <Link
            href="/signup"
            className="inline-flex h-9 items-center rounded-md bg-green px-4 font-display text-[14px] font-bold uppercase tracking-[0.06em] text-[#04120a] transition-colors hover:bg-green-glow"
          >
            Get started
          </Link>
        </nav>
      </header>
      {children}
    </div>
  );
}
