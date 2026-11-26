"use client";

import { useEffect, useState } from "react";
import type { Motm } from "@/lib/motm";

/**
 * Broadcast "Split" Man-of-the-Match card. Reusable: render it anywhere with a
 * Motm record (dashboard shows the latest; a history screen can map over past
 * ones). All layout is proportional to the card width via container queries,
 * so it scales from a phone column to a desktop panel.
 */
export function MotmCard({ motm, href, onOpen }: { motm: Motm; href?: string; onOpen?: () => void }) {
  const [entered, setEntered] = useState(false);
  useEffect(() => {
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
      setEntered(true);
      return;
    }
    const frame = requestAnimationFrame(() => requestAnimationFrame(() => setEntered(true)));
    return () => cancelAnimationFrame(frame);
  }, []);

  const alt = `Man of the match: ${motm.playerName}`;
  const inner = (
    <div
      className="group relative aspect-[4/5.2] w-full overflow-hidden rounded-md bg-[#0a0f0d] text-left shadow-lg shadow-black/40 outline-offset-2 focus-visible:outline-2 focus-visible:outline-[#34e07f]"
      style={{ containerType: "inline-size" }}
    >
      {/* Photo: right side, diagonal left edge, cover + top-aligned so the face stays visible */}
      <div
        className="absolute inset-y-0 left-[34%] right-0 transition-transform duration-[550ms] ease-out"
        style={{
          clipPath: "polygon(24% 0, 100% 0, 100% 100%, 0 100%)",
          transform: entered ? "translateX(0)" : "translateX(-8%)",
          transitionDelay: "0ms",
        }}
      >
        {motm.photoUrl ? (
          // eslint-disable-next-line @next/next/no-img-element -- dynamic storage URL, no next/image loader config
          <img src={motm.photoUrl} alt={alt} className="h-full w-full object-cover object-top" />
        ) : (
          <div className="flex h-full w-full items-end justify-center bg-[#060a08]" role="img" aria-label={alt}>
            {/* player silhouette placeholder until a photo is uploaded */}
            <svg viewBox="0 0 100 100" className="h-[72%] w-auto text-[#16211b]" fill="currentColor" aria-hidden>
              <circle cx="50" cy="30" r="17" />
              <path d="M14 100c2-26 16-40 36-40s34 14 36 40z" />
            </svg>
          </div>
        )}
      </div>

      {/* Left column */}
      <div className="absolute inset-0 flex flex-col p-[5%]">
        <h3
          className="font-display font-extrabold uppercase leading-[0.88] text-[#e8efe9] transition-all duration-[550ms] ease-out"
          style={{
            fontSize: "15cqw",
            opacity: entered ? 1 : 0,
            transform: entered ? "translateX(0)" : "translateX(-12%)",
            transitionDelay: "0ms",
          }}
        >
          Man
          <br />
          of the
          <br />
          <span className="text-[#34e07f]">Match</span>
        </h3>

        <div
          className="mt-auto transition-all duration-[550ms] ease-out"
          style={{
            opacity: entered ? 1 : 0,
            transform: entered ? "translateX(0)" : "translateX(-12%)",
            transitionDelay: "150ms",
          }}
        >
          <div className="font-display font-extrabold leading-none text-[#f5c542]" style={{ fontSize: "21cqw" }}>
            {motm.points}
          </div>
          <div className="font-sans uppercase tracking-[0.22em] text-[#8a978f]" style={{ fontSize: "3.4cqw" }}>
            Points
          </div>
        </div>

        <dl
          className="mt-[7%] space-y-[4%] transition-all duration-[550ms] ease-out"
          style={{
            opacity: entered ? 1 : 0,
            transform: entered ? "translateX(0)" : "translateX(-12%)",
            transitionDelay: "300ms",
          }}
        >
          {([
            ["Goals", motm.goals],
            ["Assists", motm.assists],
          ] as const).map(([label, value]) => (
            <div key={label} className="flex items-baseline justify-between gap-2">
              <dt className="font-sans uppercase tracking-[0.18em] text-[#8a978f]" style={{ fontSize: "3.2cqw" }}>
                {label}
              </dt>
              <dd className="font-display font-bold leading-none text-[#e8efe9]" style={{ fontSize: "6cqw" }}>
                {value}
              </dd>
            </div>
          ))}
        </dl>
      </div>

      {/* Green slab with diagonal top edge */}
      <div
        className="absolute inset-x-0 bottom-0 bg-[#34e07f] px-[5%] pb-[4%] pt-[7%] transition-transform duration-[550ms] ease-out"
        style={{
          clipPath: "polygon(0 18%, 100% 0, 100% 100%, 0 100%)",
          transform: entered ? "translateY(0)" : "translateY(102%)",
          transitionDelay: "450ms",
        }}
      >
        <div
          className="truncate font-display font-extrabold uppercase leading-none text-[#04180c]"
          style={{ fontSize: "10cqw" }}
          title={motm.playerName}
        >
          {motm.playerName}
        </div>
        <div className="truncate font-sans text-[#04180c]/80" style={{ fontSize: "3.4cqw" }}>
          {motm.club ?? "—"}
        </div>
      </div>
    </div>
  );

  if (href) {
    return (
      <a href={href} aria-label={`${alt}. Open the match breakdown.`} className="block">
        {inner}
      </a>
    );
  }
  return (
    <button type="button" onClick={onOpen} aria-label={`${alt}. Open the match breakdown.`} className="block w-full">
      {inner}
    </button>
  );
}
