"use client";

import { Plus } from "lucide-react";
import { layoutFormation, type Formation, type LeagueFormat, type Position } from "@/lib/domain";
import type { SquadEntry } from "@/lib/squad";

export function Pitch({ players, formation, format, captainId, viceCaptainId, onSelect, onAdd, disabled }: {
  players: SquadEntry[];
  formation: Formation;
  format: LeagueFormat;
  captainId: string | null;
  viceCaptainId: string | null;
  onSelect: (id: string) => void;
  onAdd: (position: Position) => void;
  disabled?: boolean;
}) {
  const byId = new Map(players.map((p) => [p.id, p]));
  const slots = layoutFormation(players, formation);
  return (
    <div className="relative">
      {/* turf */}
      <div
        className="relative aspect-[3/4] min-h-[310px] w-full overflow-hidden rounded-lg border border-green-dim/35 sm:aspect-[4/5]"
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
            {formation.label} · {format}
          </span>
        </div>

        {slots.map(({ playerId, position, index, x, y, width }) => {
          const player = playerId ? byId.get(playerId) : null;
          if (player) return (
            <Token key={player.id} player={player} x={x} y={y} width={width}
              captain={captainId === player.id} vice={viceCaptainId === player.id}
              disabled={disabled} onClick={() => onSelect(player.id)} />
          );
          return (
            <button key={`${position}-${index}`} type="button" aria-label={`Add ${position} ${index + 1}`}
              disabled={disabled} onClick={() => onAdd(position)}
              className="absolute flex -translate-x-1/2 -translate-y-1/2 flex-col items-center text-green-glow hover:text-white disabled:opacity-50"
              style={{ left: `${x}%`, top: `${y}%`, width: `${width}%` }}>
              <span className="flex h-10 w-10 items-center justify-center rounded-full border border-dashed border-green-glow/80 bg-pitch-950/90 sm:h-12 sm:w-12">
                <Plus className="h-5 w-5" />
              </span>
              <span className="mt-1 rounded bg-black/60 px-1 text-[10px] font-bold">{position}</span>
            </button>
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
  width,
  disabled,
  onClick,
}: {
  player: SquadEntry;
  x: number;
  y: number;
  captain?: boolean;
  vice?: boolean;
  width: number;
  disabled?: boolean;
  onClick?: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      aria-label={`${player.name}, ${player.position}${captain ? ", captain" : vice ? ", vice-captain" : ""}`}
      title={player.name}
      className={`group absolute z-10 -translate-x-1/2 -translate-y-1/2 flex flex-col items-center text-center transition-[left,top,transform] motion-reduce:transition-none duration-[380ms] ease-[cubic-bezier(.2,.8,.2,1)] disabled:cursor-default`}
      style={{ left: `${x}%`, top: `${y}%`, width: `${width}%` }}
    >
      <span className="relative flex w-full flex-col items-center">
        <span
          className={`flex h-10 w-10 items-center justify-center overflow-hidden rounded-full border-2 bg-[#0b1710]/95 shadow-[0_6px_18px_-8px_rgba(0,0,0,0.9)] transition-all sm:h-12 sm:w-12 ${
            captain
              ? "border-card-y"
              : vice
                ? "border-green-glow"
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
            className={`num absolute left-1/2 -top-1 ml-2 flex h-[18px] min-w-[18px] items-center justify-center rounded-full px-1 text-[10px] font-bold leading-none ${
              captain ? "bg-card-y text-[#1a1400]" : "bg-green-glow text-[#04120a]"
            }`}
          >
            {captain ? "C" : "V"}
          </span>
        )}

        {player.availability && player.availability !== "available" && (
          <span className="absolute right-1/2 -top-1 mr-3 h-2.5 w-2.5 rounded-full border border-pitch-950 bg-card-r" />
        )}

        <span className="mt-1.5 block max-w-[min(100%,100px)] truncate rounded bg-black/60 px-1.5 py-0.5 text-[10.5px] font-semibold text-chalk backdrop-blur">
          {player.name}
        </span>
        <span className="num mt-0.5 block text-[9.5px] uppercase tracking-[0.1em] text-green-glow/80">
          {player.position}
        </span>
      </span>
    </button>
  );
}
