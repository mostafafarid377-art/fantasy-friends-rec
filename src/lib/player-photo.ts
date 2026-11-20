export const PLAYER_PHOTO_BUCKET = "player-images";
export const PHOTO_MAX_BYTES = 1024 * 1024;
export const PHOTO_EDGE = 384;
const PREFIX = `${PLAYER_PHOTO_BUCKET}/`;
const FILE = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}\.jpg$/;

export function managedPhotoKey(value: string | null, league: string, player: string): string | null {
  if (!value?.startsWith(PREFIX)) return null;
  const key = value.slice(PREFIX.length);
  const [l, p, filename, extra] = key.split("/");
  return l === league && p === player && !extra && key === `${l}/${p}/${filename}` && FILE.test(filename) ? key : null;
}

export function playerPhotoUrl(value: string | null, league: string, player: string): string | null {
  if (!value) return null;
  if (!value.startsWith(PREFIX)) return /^https?:\/\//i.test(value) ? value : null;
  const key = managedPhotoKey(value, league, player);
  return key ? `/api/leagues/${encodeURIComponent(league)}/players/${encodeURIComponent(player)}/photo?v=${key.split("/")[2]}` : null;
}
