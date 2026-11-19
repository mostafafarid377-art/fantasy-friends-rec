"use client";

import { useMemo } from "react";
import {
  findFormation,
  layoutFormation,
  type LeagueFormat,
  type SquadPlayer,
} from "@/lib/domain";

export type PitchPlayer = SquadPlayer & {
  photoUrl?: string | null;
  shirtNumber?: number | null;
  availability?: string;
};

type Props = {
  players: PitchPlayer[];
  formation: string;
  format: LeagueFormat;
  captainId?: string | null;
  viceCaptainId?: string | null;
  selectedId?: string | null;
  benchId?: string | null;
  onSelect?: (id: string) => void;
  disabled?: boolean;
};

/**
 * FPL-style vertical pitch. Tokens keep their DOM identity and only their
 * coordinates change, so a formation recalculation physically re-forms the
 * team instead of re-rendering it.
 */
export function Pitch({
  players,
  formation,
  format,
  captainId,
  viceCaptainId,
  selectedId,
  benchId,
  onSelect,
  disabled,
}: Props) {
  const starters = useMemo(
    () => players.filter((p) => p.slot === "starter"),
    [players],
  );
  const shape = findFormation(formation, format);

  const { slots, keeper } = useMemo(() => {
    const outfield = starters.filter((p) => p.position !== "GK");
    const gk = starters.find((p) => p.position === "GK") ?? null;
    const lines = shape?.lines ?? [outfield.length];
    const laid = layoutFormation(outfield, {
      label: shape?.label ?? formation,
      lines,
    });
    return { slots: laid.slots, keeper: gk };
  }, [starters, shape, formation]);

  const byId = new Map(players.map((p) => [p.id, p]));

  return (
    <div className="relative">
      {/* turf */}
      <div
        className="relative aspect-[3/4] w-full overflow-hidden rounded-lg border border-green-dim/35 sm:aspect-[4/5]"
        style={{
          background:
            "repeating-linear-gradient(180deg,#0f2a1c 0 8.33%,#0c2318 8.33% 16.66%)",
          boxShadow: "inset 0 0 90px rgba(0,0,0,0.65)",
        }}
      >
        {/* markings */}
        <svg className="pointer-events-none absolute inset-0 h-full w-full" viewBox="0 0 100 125" preserveAspectRatio="none">
          <rect x="2" y="2" width="96" height="121" fill="none" stroke="rgba(232,240,236,0.22)" strokeWidth="0.5" />
          <line x1="2" y1="62.5" x2="98" y2="62.5" stroke="rgba(232,240,236,0.22)" strokeWidth="0.5" />
          <circle cx="50" cy="62.5" r="13" fill="none" stroke="rgba(232,240,236,0.22)" strokeWidth="0.5" />
          <rect x="26" y="2" width="48" height="16" fill="none" stroke="rgba(232,240,236,0.22)" strokeWidth="0.5" />
          <rect x="36" y="2" width="28" height="7" fill="none" stroke="rgba(232,240,236,0.22)" strokeWidth="0.5" />
          <rect x="26" y="107" width="48" height="16" fill="none" stroke="rgba(232,240,236,0.22)" strokeWidth="0.5" />
          <rect x="36" y="116" width="28" height="7" fill="none" stroke="rgba(232,240,236,0.22)" strokeWidth="0.5" />
        </svg>

        <div className="absolute left-1/2 top-2 -translate-x-1/2">
          <span className="rounded bg-black/45 px-2 py-1 text-[9.5px] font-semibold uppercase tracking-[0.18em] text-green-glow backdrop-blur">
            {shape?.label ?? formation} · {format}
          </span>
        </div>

        {/* goalkeeper */}
        {keeper && (
          <Token
            key={keeper.id}
            player={keeper}
            x={50}
            y={92}
            captain={captainId === keeper.id}
            vice={viceCaptainId === keeper.id}
            active={selectedId === keeper.id}
            target={benchId != null}
            disabled={disabled}
            onClick={() => onSelect?.(keeper.id)}
          />
        )}

        {slots.map((slot) => {
          const player = byId.get(slot.playerId);
          if (!player) return null;
          return (
            <Token
              key={slot.playerId}
              player={player}
              x={slot.x}
              y={slot.y}
              captain={captainId === player.id}
              vice={viceCaptainId === player.id}
              active={selectedId === player.id}
              target={benchId != null}
              disabled={disabled}
              onClick={() => onSelect?.(player.id)}
            />
          );
        })}
      </div>
    </div>
  );
}

function Token({
  player,
  x,
  y,
  captain,
  vice,
  active,
  target,
  disabled,
  onClick,
}: {
  player: PitchPlayer;
  x: number;
  y: number;
  captain?: boolean;
  vice?: boolean;
  active?: boolean;
  target?: boolean;
  disabled?: boolean;
  onClick?: () => void;
}) {
  const ring = active
    ? "ring-2 ring-green ring-offset-2 ring-offset-[#0f2a1c]"
    : target
      ? "ring-2 ring-dashed ring-card-y"
      : "";

  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      aria-label={`${player.name}, ${player.position}`}
      className={`group absolute z-10 -translate-x-1/2 -translate-y-1/2 text-center transition-[left,top,transform] duration-[380ms] ease-[cubic-bezier(.2,.8,.2,1)] disabled:cursor-default`}
      style={{ left: `${x}%`, top: `${y}%` }}
    >
      <span className="relative block">
        <span
          className={`flex h-11 w-11 items-center justify-center overflow-hidden rounded-full border-2 bg-[#0b1710]/95 shadow-[0_6px_18px_-8px_rgba(0,0,0,0.9)] transition-all sm:h-12 sm:w-12 ${ring} ${
            captain
              ? "border-card-y"
              : vice
                ? "border-green-glow"
                : active
                  ? "border-green"
                  : "border-green-dim/70 group-hover:border-green"
          }`}
        >
          {player.photoUrl ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img loading="lazy" decoding="async" src={player.photoUrl} alt="" className="h-full w-full object-cover" />
          ) : (
            <span className="num text-[15px] font-semibold text-green-glow">
              {player.shirtNumber ?? player.position}
            </span>
          )}
        </span>

        {(captain || vice) && (
          <span
            className={`num absolute -right-1 -top-1 flex h-[18px] min-w-[18px] items-center justify-center rounded-full px-1 text-[10px] font-bold leading-none ${
              captain ? "bg-card-y text-[#1a1400]" : "bg-green-glow text-[#04120a]"
            }`}
          >
            {captain ? "C" : "V"}
          </span>
        )}

        {player.availability && player.availability !== "available" && (
          <span className="absolute -left-1 -top-1 h-2.5 w-2.5 rounded-full border border-pitch-950 bg-card-r" />
        )}

        <span className="mt-1.5 block max-w-[74px] truncate rounded bg-black/60 px-1.5 py-0.5 text-[10.5px] font-semibold text-chalk backdrop-blur">
          {player.name}
        </span>
        <span className="num mt-0.5 block text-[9.5px] uppercase tracking-[0.1em] text-green-glow/80">
          {player.position}
        </span>
      </span>
    </button>
  );
}
