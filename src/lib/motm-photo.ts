export const MOTM_PHOTO_BUCKET = "motm-images";
export const MOTM_PHOTO_MAX_BYTES = 1536 * 1024;
// The card crops portrait; keep enough pixels for a full-width broadcast image.
export const MOTM_PHOTO_EDGE = 1200;
const PREFIX = `${MOTM_PHOTO_BUCKET}/`;
const FILE = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}\.jpg$/;

export function managedMotmPhotoKey(value: string | null, league: string, match: string): string | null {
  if (!value?.startsWith(PREFIX)) return null;
  const key = value.slice(PREFIX.length);
  const [l, m, filename, extra] = key.split("/");
  return l === league && m === match && !extra && key === `${l}/${m}/${filename}` && FILE.test(filename) ? key : null;
}

export function motmPhotoUrl(value: string | null, league: string, match: string): string | null {
  if (!value) return null;
  if (!value.startsWith(PREFIX)) return /^https?:\/\//i.test(value) ? value : null;
  const key = managedMotmPhotoKey(value, league, match);
  return key ? `/api/leagues/${encodeURIComponent(league)}/matches/${encodeURIComponent(match)}/motm/photo?v=${key.split("/")[2].replace(/\.jpg$/, "")}` : null;
}
