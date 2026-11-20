export const TEAM_LOGO_BUCKET = "team-logos";
export const TEAM_LOGO_EDGE = 256;
export const TEAM_LOGO_LIMIT = 1024 * 1024;

export function teamLogoKey(path: string | null | undefined, leagueId: string, teamId: string) {
  const parts = path?.split("/");
  if (!parts || parts.length !== 4 || parts[0] !== TEAM_LOGO_BUCKET || parts[1] !== leagueId || parts[2] !== teamId ||
      !/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}\.webp$/.test(parts[3])) return null;
  return parts.slice(1).join("/");
}

export function teamLogoUrl(path: string | null | undefined, leagueId: string, teamId: string) {
  const key = teamLogoKey(path, leagueId, teamId);
  if (key) return `/api/leagues/${encodeURIComponent(leagueId)}/teams/${encodeURIComponent(teamId)}/logo?v=${key.split("/")[2]}`;
  return path && /^https?:\/\//i.test(path) ? path : null;
}
