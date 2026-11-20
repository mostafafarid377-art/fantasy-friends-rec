import Link from "next/link";
import type { ReactNode } from "react";
import { Wordmark } from "@/components/Mark";

export default function AuthLayout({ children }: { children: ReactNode }) {
  return (
    <div className="relative grid min-h-dvh grid-cols-1 lg:grid-cols-[1.05fr_1fr]">
      {/* art panel */}
      <div className="relative hidden overflow-hidden lg:block">
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img src="/images/floodlit-pitch.jpg" alt="" className="absolute inset-0 h-full w-full object-cover opacity-60" />
        <div className="absolute inset-0 bg-[linear-gradient(160deg,rgba(7,11,9,0.55),rgba(7,11,9,0.95))]" />
        <div className="floodlight absolute inset-0" />
        <div className="relative flex h-full flex-col justify-between p-10">
          <Link href="/">
            <Wordmark />
          </Link>
          <div>
            <h2 className="max-w-md text-[clamp(2.4rem,4vw,3.6rem)] leading-[0.9] text-chalk">
              Your league.
              <br />
              <span className="text-green">Your rules.</span>
              <br />
              Your table.
            </h2>
            <p className="mt-5 max-w-sm text-[14.5px] leading-relaxed text-sage">
              League-sized squads, five or seven a side, real matches recorded and approved before
              a single point is awarded.
            </p>
          </div>
          <div className="num flex gap-6 text-[12px] uppercase tracking-[0.16em] text-sage-dim">
            <span>5v5</span>
            <span>7v7</span>
            <span>RLS secured</span>
          </div>
        </div>
      </div>

      {/* form panel */}
      <div className="relative flex flex-col justify-center px-5 py-10 sm:px-10 lg:px-14">
        <div className="mb-8 lg:hidden">
          <Link href="/">
            <Wordmark />
          </Link>
        </div>
        <div className="mx-auto w-full max-w-md">{children}</div>
      </div>
    </div>
  );
}
