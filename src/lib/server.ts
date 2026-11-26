import { createHash, randomUUID } from "crypto";
import { NextRequest, NextResponse } from "next/server";
import { getSupabase, SupabaseClient } from "@/db";
import { loadMatch } from "@/lib/matches";
import { resolveIdentity, type Identity } from "@/lib/identity";

import { ApiError, checkDb } from "@/lib/db-result";
export { ApiError, checkDb, confirmedRow } from "@/lib/db-result";

export function ok(data: unknown, init?: ResponseInit) {
  return NextResponse.json(data, init);
}

export function fail(message: string, status = 400, details?: unknown) {
  return NextResponse.json({ error: message, details }, { status });
}

/** Wraps a route handler with uniform error handling. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function handler<F extends (req: NextRequest, ctx: any) => Promise<Response>>(
  fn: F,
) {
  return async (req: NextRequest, ctx?: unknown): Promise<Response> => {
    try {
      const recoveryActor = req?.headers.get("x-ff-recovery-actor");
      if (recoveryActor && (await requireIdentity()).id !== recoveryActor) {
        throw new ApiError("This pending request belongs to another session", 403);
      }
      return await fn(req, ctx as Parameters<F>[1]);
    } catch (err) {
      if (err instanceof ApiError) return fail(err.message, err.status, err.details);
      // Unexpected failures are logged in full on the server, but the client
      // only learns that the request failed: an internal error message can
      // carry SQL fragments, file paths or library internals.
      console.error("[api]", err instanceof Error ? err.message : "Unexpected error");
      return fail("Unexpected error", 500);
    }
  };
}

/** Run a callback with an awaited Supabase client. Avoids Promise chaining issues. */
export async function withSupabase<T>(fn: (sb: SupabaseClient) => Promise<T>): Promise<T> {
  const sb = await getSupabase();
  return fn(sb);
}

/**
 * Establishes the caller from the signed access token.
 *
 * The token is verified locally against the project's signing key, so hot
 * request paths do not pay for an Auth server round trip. Only the verified
 * subject is used for access control.
 */
export async function requireIdentity(supabase?: SupabaseClient): Promise<Identity> {
  supabase ??= await getSupabase();
  const identity = await resolveIdentity(supabase);
  if (!identity) throw new ApiError("Not authenticated", 401);

  return identity;
}

export async function requireUser() {
  const supabase = await getSupabase();
  const user = await requireIdentity(supabase);
  const { data: profile } = await supabase
    .from("profiles")
    .select("id,email,username,display_name,avatar_url,bio,email_verified_at,created_at")
    .eq("id", user.id)
    .maybeSingle();

  const metadata = user.metadata;
  const username =
    profile?.username ??
    (typeof metadata.username === "string" ? metadata.username : user.email?.split("@")[0] ?? "manager");
  const displayName =
    profile?.display_name ??
    (typeof metadata.display_name === "string" ? metadata.display_name : username);

  return {
    id: user.id,
    email: user.email ?? profile?.email ?? "",
    username,
    displayName,
    avatarUrl: profile?.avatar_url ?? null,
    bio: profile?.bio ?? null,
    // The profile column mirrors auth.users.email_confirmed_at through a
    // database trigger, so this matches the Auth server state exactly.
    emailVerified: Boolean(profile?.email_verified_at),
    createdAt: profile?.created_at ?? "",
  };
}

export type Membership = {
  leagueId: string;
  profileId: string;
  emailVerified: boolean;
  role: "leader" | "manager" | "organizer";
  league: any;
};

export async function requireMember(leagueId: string, supabase?: SupabaseClient): Promise<Membership> {
  supabase ??= await getSupabase();
  const user = await requireIdentity(supabase);

  const { data: members, error } = await supabase
    .from("league_members")
    .select("role, leagues(*), profiles(email_verified_at)")
    .eq("league_id", leagueId)
    .eq("profile_id", user.id)
    .maybeSingle();

  checkDb(error, "Could not verify league membership");
  if (!members?.leagues) throw new ApiError("You are not a member of this league", 403);

  return {
    leagueId,
    profileId: user.id,
    // Read from the caller's own profile row in the same query, so verifying
    // a membership never needs an extra Auth round trip.
    emailVerified: Boolean(profileVerifiedAt(members.profiles)),
    role: members.role as "leader" | "manager" | "organizer",
    league: members.leagues,
  };
}

/** PostgREST returns an embedded row as an object or as an array of one. */
function profileVerifiedAt(embedded: unknown): string | null {
  const row = Array.isArray(embedded) ? embedded[0] : embedded;
  if (!row || typeof row !== "object") return null;
  const value = (row as { email_verified_at?: unknown }).email_verified_at;
  return typeof value === "string" ? value : null;
}

export function leagueRules(league: any) {
  return {
    format: league.format,
    // A squad is exactly starters plus substitutes; the reserve tier is gone.
    // The stored squad_size is a legacy column (it included reserve headroom),
    // so the rules derive the size instead of trusting the stored value.
    squadSize: league.starters + league.subs_count,
    starters: league.starters,
    subsCount: league.subs_count,
  };
}

export function assertRole(m: Membership, ...roles: string[]) {
  if (!roles.includes(m.role)) {
    throw new ApiError("You do not have permission to perform this action", 403);
  }
}

export function isLeader(m: Membership) {
  return m.role === "leader";
}

/**
 * Determines whether the authenticated profile is authorized to manage a match.
 *
 * Both the League Leader (any match in their league) and the assigned Match
 * Organizer (matches they organize) have full authority over match results,
 * including entering, editing, submitting, approving, and rejecting results.
 */
export async function canManageMatch(matchId: string, profileId: string) {
  const match = await loadMatch(matchId);
  if (!match) throw new ApiError("Match not found", 404);
  const membership = await requireMember(match.league_id);
  const isLeaderRole = membership.role === "leader";
  const isOrganizerRole = membership.role === "organizer";
  const isMatchOrganizer = match.organizer_id === profileId;

  // League Leader has full authority over all matches in their league.
  const authorizedAsLeader = isLeaderRole;

  // Match Organizer has authority over matches they organize (and have leader or organizer role).
  const authorizedAsOrganizer = isMatchOrganizer && (isLeaderRole || isOrganizerRole);

  const authorized = authorizedAsLeader || authorizedAsOrganizer;
  if (!authorized) {
    throw new ApiError("You are not authorized to manage this match", 403);
  }

  return { match, membership, isLeader: isLeaderRole, isOrganizer: isMatchOrganizer, authorized };
}

/* ------------------------------------------------------------------ */
/* Idempotent mutation coordinator                                     */
/* ------------------------------------------------------------------ */

/** Scope a retry key to the authenticated actor, route, league and normalized payload. */
export function creationId(req: NextRequest, profileId: string, route: string, payload: unknown) {
  const key = req.headers.get("x-operation-id")?.trim();
  if (!key) return randomUUID();
  if (key.length > 80) throw new ApiError("Invalid operation id", 400);
  return createHash("sha256").update(JSON.stringify([profileId, route, key, payload])).digest("hex");
}

/* ------------------------------------------------------------------ */
/* Squad helpers                                                       */
/* ------------------------------------------------------------------ */

export async function loadSquad(leagueId: string, profileId: string) {
  const supabase = await getSupabase();
  const { data, error } = await supabase
    .from("fantasy_squads")
    .select("*")
    .eq("league_id", leagueId)
    .eq("profile_id", profileId)
    .maybeSingle();
  checkDb(error, "Could not load your squad");
  return data ?? null;
}

export async function loadSquadPlayers(squadId: string) {
  const supabase = await getSupabase();
  const { data } = await supabase
    .from("fantasy_squad_players")
    .select("id, player_id, slot, \"order\"")
    .eq("squad_id", squadId)
    .order("order", { ascending: true });
  return data ?? [];
}

export async function memberProfiles(leagueId: string) {
  const supabase = await getSupabase();
  const { data, error } = await supabase
    .from("league_members")
    .select("profile_id, role, team_name, profiles(username, display_name, avatar_url)")
    .eq("league_id", leagueId);
  checkDb(error, "Could not load league members");
  return (data ?? []).map((r: any) => ({
    profileId: r.profile_id,
    role: r.role,
    teamName: r.team_name,
    username: r.profiles?.username,
    displayName: r.profiles?.display_name,
    avatarUrl: r.profiles?.avatar_url,
  }));
}

export async function standingsFor(leagueId: string) {
  const supabase = await getSupabase();
  const { data } = await supabase
    .from("league_standings")
    .select("*")
    .eq("league_id", leagueId)
    .order("rank", { ascending: true });
  return (data ?? []) as any[];
}