import type { Position } from "@/lib/domain";

export const PLAYER_FIELDS = "id,league_id,team_id,full_name,photo_url,position,shirt_number,availability,status,description";
export const TEAM_FIELDS = "id,league_id,name,short_name,crest_url";

type PlayerRow = {
  id: string; league_id: string; team_id: string | null; full_name: string;
  photo_url: string | null; position: string; shirt_number: number | null;
  availability: string; status: string; description: string | null;
};

export function playerDto(p: PlayerRow) {
  return {
    id: p.id, leagueId: p.league_id, teamId: p.team_id, fullName: p.full_name,
    photoUrl: p.photo_url, position: p.position as Position, shirtNumber: p.shirt_number,
    availability: p.availability, status: p.status, description: p.description,
  };
}

export function teamDto(t: { id: string; league_id: string; name: string; short_name: string | null; crest_url: string | null }) {
  return { id: t.id, leagueId: t.league_id, name: t.name, shortName: t.short_name, crestUrl: t.crest_url };
}
