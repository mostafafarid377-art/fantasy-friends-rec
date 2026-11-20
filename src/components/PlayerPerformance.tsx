"use client";

import { useRef, useState, type ReactNode } from "react";
import { api, useApi } from "@/lib/client/api";
import { useLeagueContentUpdates } from "@/lib/client/league-updates";
import { formatPlayerPoints, type LatestPlayerGame, type LatestPlayerGames, type PlayerGame, type PlayerHistory, type PlayerPerformance } from "@/lib/player-performance";
import type { SquadEntry } from "@/lib/squad";
import { Avatar, Button, ErrorNote, Modal } from "./ui";

export function useLatestPlayerGames(leagueId: string, players: SquadEntry[]) {
  const ids = players.filter((p) => p.slot !== "reserve").map((p) => p.id).sort();
  const query = new URLSearchParams(ids.map((id) => ["player", id]));
  const result = useApi<LatestPlayerGames>(ids.length ? `/api/leagues/${encodeURIComponent(leagueId)}/player-performance?${query}` : null);
  useLeagueContentUpdates(leagueId, result.reload, false);
  return result;
}

export function PlayerPointsLabel({ game }: { game: LatestPlayerGame | undefined }) {
  return <span className={`num block leading-tight text-[11px] font-bold ${game?.points == null ? "text-sage" : "text-green-glow"}`}>
    {formatPlayerPoints(game?.points)}
  </span>;
}

const DATE = new Intl.DateTimeFormat(undefined, { year: "numeric", month: "short", day: "numeric" });
const PARTICIPATION: Record<PlayerGame["participation"], string> = {
  played: "Played", did_not_play: "Did not play", unknown: "Participation not recorded",
};

export function PlayerPerformanceDialog({ leagueId, entry, latest, onClose, actions }: {
  leagueId: string; entry: SquadEntry; latest?: LatestPlayerGame; onClose: () => void; actions?: ReactNode;
}) {
  const route = `/api/leagues/${encodeURIComponent(leagueId)}/players/${encodeURIComponent(entry.id)}/performance`;
  const history = useApi<PlayerPerformance>(route);
  const [pages, setPages] = useState<PlayerHistory[]>([]);
  const [moreError, setMoreError] = useState<string | null>(null);
  const [loadingMore, setLoadingMore] = useState(false);
  const inFlight = useRef(false);
  const games = [...(history.data?.games ?? []), ...pages.flatMap((page) => page.games)];
  const next = pages.length ? pages[pages.length - 1].next : history.data?.next;
  const player = history.data?.player;
  const last = history.data ? history.data.games[0] : latest;
  const name = player?.name ?? entry.name;

  async function loadMore() {
    if (!next || inFlight.current) return;
    inFlight.current = true;
    setMoreError(null);
    setLoadingMore(true);
    try {
      const query = new URLSearchParams({ before: next.kickOff, match: next.matchId });
      const page = await api<PlayerHistory>(`${route}?${query}`);
      setPages((prev) => [...prev, page]);
    } catch (err) {
      setMoreError(err instanceof Error ? err.message : "Could not load older games");
    } finally { inFlight.current = false; setLoadingMore(false); }
  }

  return <Modal open title={name} onClose={onClose} width="max-w-xl" manageFocus>
    <div className="mb-4 grid grid-cols-[auto_minmax(0,1fr)] items-center gap-3 rounded-lg border border-line bg-pitch-900 p-3">
      <Avatar name={name} url={player ? player.photoUrl : entry.photoUrl} size={48} decorative />
      <div className="min-w-0 break-words">
        <div className="text-sm text-chalk">{player?.position ?? entry.position}{player?.team ? ` · ${player.team}` : ""}</div>
        <div className="mt-1 flex flex-wrap items-baseline gap-x-2 text-xs text-sage">Latest game <PlayerPointsLabel game={last} /></div>
      </div>
    </div>
    {actions && <div className="mb-5 border-b border-line pb-4">{actions}</div>}
    <section aria-label="Finalized match history">
      <h3 className="mb-2 text-lg text-chalk">Finalized match history</h3>
      {history.loading && <p role="status" className="py-3 text-sm text-sage">Loading player history…</p>}
      {history.error && <ErrorNote message={history.error} onRetry={() => { setPages([]); setMoreError(null); void history.reload(); }} />}
      {history.data && !games.length && <p className="py-3 text-sm text-sage">No finalized games yet.</p>}
      {games.length > 0 && <ol className="space-y-2">
        {games.map((game) => <li key={game.matchId}><GameDetails game={game} /></li>)}
      </ol>}
      {moreError && <p role="alert" className="mt-3 text-sm text-card-r">{moreError}</p>}
      {next && <Button className="mt-3 w-full sm:w-auto" variant="outline" loading={loadingMore} onClick={loadMore}>{moreError ? "Retry older games" : "Load older games"}</Button>}
    </section>
  </Modal>;
}

function GameDetails({ game }: { game: PlayerGame }) {
  return <details className="group overflow-hidden rounded-lg border border-line bg-pitch-900">
    <summary className="grid min-h-12 cursor-pointer list-none grid-cols-[minmax(0,1fr)_auto] items-start gap-x-3 px-3 py-2.5 marker:hidden hover:bg-pitch-800 [&::-webkit-details-marker]:hidden">
      <span className="min-w-0 break-words">
        <span className="block text-sm font-semibold text-chalk">{game.title}{game.gameweek != null ? ` · GW ${game.gameweek}` : ""}</span>
        <span className="block text-xs text-sage"><time dateTime={game.kickOff}>{DATE.format(new Date(game.kickOff))}</time>{game.opponent ? ` · vs ${game.opponent}` : ""}</span>
        <span className="block text-xs text-sage">{PARTICIPATION[game.participation]}</span>
      </span>
      <span className="flex min-w-0 flex-wrap items-center justify-end gap-1.5 pt-0.5">
        <span className="num text-sm font-bold text-green-glow">{formatPlayerPoints(game.points)}</span>
        <span aria-hidden="true" className="text-sage group-open:rotate-180">⌄</span>
      </span>
    </summary>
    <div className="border-t border-line px-3 py-2.5">
      <p className="mb-1 text-xs font-semibold text-chalk">Points breakdown</p>
      {game.breakdown.length ? <ul className="divide-y divide-line">
        {game.breakdown.map((line, i) => <li key={`${line.category}-${i}`} className="grid grid-cols-[minmax(0,1fr)_auto] items-baseline gap-2 py-1 text-sm text-sage">
          <span className="break-words">{line.label} <span className="text-xs">({line.count} × {line.pointsPer})</span></span>
          <span className="num font-bold text-chalk">{formatPlayerPoints(line.points)}</span>
        </li>)}
      </ul> : <p className="text-xs text-sage">{game.points == null ? "No individual score was recorded." : "No event breakdown was recorded."}</p>}
    </div>
  </details>;
}
