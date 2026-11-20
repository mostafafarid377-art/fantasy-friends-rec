"use client";

import { PlayerPointsLabel } from "./PlayerPerformance";
import { formatPlayerPoints, type LatestPlayerGame, type LatestPlayerGames } from "@/lib/player-performance";
import { Avatar } from "./ui";
import { Plus, Shirt } from "lucide-react";
import { layoutFormation, type Formation, type LeagueFormat, type Position } from "@/lib/domain";
import type { SquadEntry } from "@/lib/squad";

export function Pitch({ players, formation, format, captainId, viceCaptainId, onSelect, onAdd, disabled, latest, compact = false }: {
  players: SquadEntry[];
  formation: Formation;
  format: LeagueFormat;
  captainId: string | null;
  viceCaptainId: string | null;
  onSelect?: (id: string) => void;
  onAdd?: (position: Position) => void;
  disabled?: boolean;
  compact?: boolean;
  latest?: LatestPlayerGames;
}) {
  const byId = new Map(players.map((p) => [p.id, p]));
  const slots = layoutFormation(players, formation);
  return (
    <div className="relative" role="region" aria-label={`${format} football pitch, formation ${formation.label}`}>
      {/* turf */}
      <div
        className={`relative w-full overflow-hidden rounded-lg border border-green-dim/35 ${compact ? "min-h-[286px] aspect-[6/5]" : "aspect-[3/4] min-h-[350px] sm:aspect-[4/5]"}`}
        style={{
          background:
            "repeating-linear-gradient(180deg,#0f2a1c 0 8.33%,#0c2318 8.33% 16.66%)",
          boxShadow: "inset 0 0 90px rgba(0,0,0,0.65)",
        }}
      >
        {/* markings */}
        <svg aria-hidden="true" className="pointer-events-none absolute inset-0 h-full w-full" viewBox="0 0 100 125" preserveAspectRatio="none">
          <rect x="2" y="2" width="96" height="121" fill="none" stroke="rgba(232,240,236,0.22)" strokeWidth="0.5" />
          <line x1="2" y1="62.5" x2="98" y2="62.5" stroke="rgba(232,240,236,0.22)" strokeWidth="0.5" />
          <circle cx="50" cy="62.5" r="13" fill="none" stroke="rgba(232,240,236,0.22)" strokeWidth="0.5" />
          <rect x="26" y="2" width="48" height="16" fill="none" stroke="rgba(232,240,236,0.22)" strokeWidth="0.5" />
          <rect x="36" y="2" width="28" height="7" fill="none" stroke="rgba(232,240,236,0.22)" strokeWidth="0.5" />
          <rect x="26" y="107" width="48" height="16" fill="none" stroke="rgba(232,240,236,0.22)" strokeWidth="0.5" />
          <rect x="36" y="116" width="28" height="7" fill="none" stroke="rgba(232,240,236,0.22)" strokeWidth="0.5" />
        </svg>

        <div className="absolute left-1/2 top-2 -translate-x-1/2">
          <span className="whitespace-nowrap rounded bg-black/45 px-2 py-1 text-[9.5px] font-semibold uppercase tracking-[0.18em] text-green-glow backdrop-blur">
            {formation.label} · {format}
          </span>
        </div>

        {slots.map(({ playerId, position, index, x, y, width }) => {
          const player = playerId ? byId.get(playerId) : null;
          if (player) return (
            <Token key={player.id} player={player} x={x} y={y} width={width}
              captain={captainId === player.id} vice={viceCaptainId === player.id}
              disabled={disabled} compact={compact} showPoints={Boolean(latest)} game={latest?.[player.id]} onClick={onSelect ? () => onSelect(player.id) : undefined} />
          );
          const style = { left: `${x}%`, top: `${y}%`, width: `${width}%` };
          const slotClass = "absolute flex -translate-x-1/2 -translate-y-1/2 flex-col items-center text-green-glow";
          if (!onAdd) return (
            <div key={`${position}-${index}`} role="img" aria-label={`Empty ${position} slot ${index + 1}`} className={slotClass} style={style}>
              <span className="grid size-7 place-items-center rounded-full border border-dashed border-green-glow/60 bg-pitch-950/75"><Shirt className="size-4 opacity-75" /></span>
              <span className="mt-0.5 rounded bg-black/60 px-1 text-[10px] font-bold">{position}</span>
            </div>
          );
          return (
            <button key={`${position}-${index}`} type="button" aria-label={`Add ${position} ${index + 1}`}
              disabled={disabled} onClick={() => onAdd(position)}
              className={`${slotClass} hover:text-white disabled:opacity-50`} style={style}>
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
  compact,
  showPoints,
  game,
}: {
  player: SquadEntry;
  x: number;
  y: number;
  captain?: boolean;
  vice?: boolean;
  width: number;
  disabled?: boolean;
  onClick?: () => void;
  compact: boolean;
  showPoints: boolean;
  game?: LatestPlayerGame;
}) {
  const TokenElement = onClick ? "button" : "div";
  const label = `${player.name}, ${player.position}${captain ? ", captain" : vice ? ", vice-captain" : ""}`;
  return (
    <TokenElement
      {...(onClick ? { type: "button" as const, onClick, disabled } : { role: "img" })}
      aria-label={label}
      aria-description={showPoints ? `Latest game: ${game?.points == null ? "no recorded points" : formatPlayerPoints(game.points)}` : undefined}
      title={label}
      className="group absolute z-10 rounded focus-visible:outline focus-visible:outline-green -translate-x-1/2 -translate-y-1/2 flex flex-col items-center text-center transition-[left,top,transform] motion-reduce:transition-none duration-[380ms] ease-[cubic-bezier(.2,.8,.2,1)] disabled:cursor-default"
      style={{ left: `${x}%`, top: `${y}%`, width: `${width}%` }}
    >
      <span className="relative flex w-full flex-col items-center" aria-hidden="true">
        <span className={`flex rounded-full ${captain ? "ring-1 ring-card-y" : vice ? "ring-1 ring-green-glow" : ""}`}>
          <Avatar name={player.name} url={player.photoUrl} size={compact ? 26 : 34} decorative />
        </span>

        {(captain || vice) && (
          <span
            className={`num absolute left-1/2 -top-1 ml-2 flex h-[18px] min-w-[18px] items-center justify-center rounded-full px-1 text-[10px] font-bold leading-none ${
              captain ? "bg-card-y text-[#1a1400]" : "bg-green-glow text-[#04120a]"
            }`}
          >
            {captain ? "C" : "VC"}
          </span>
        )}

        {player.availability && player.availability !== "available" && (
          <span className="absolute right-1/2 -top-1 mr-3 h-2.5 w-2.5 rounded-full border border-pitch-950 bg-card-r" />
        )}

        <span className={`${compact ? "mt-0.5 text-[10px]" : "mt-0.5 text-[10.5px]"} block max-w-[min(100%,100px)] truncate rounded bg-black/60 px-1 py-0.5 font-semibold leading-tight text-chalk backdrop-blur`}>
          {player.name}
        </span>
        {showPoints && <PlayerPointsLabel game={game} />}
        <span className="num block leading-tight text-[9px] uppercase tracking-[0.1em] text-green-glow/80">
          {player.position}
        </span>
      </span>
    </TokenElement>
  );
}
