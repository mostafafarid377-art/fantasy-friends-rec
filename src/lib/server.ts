import { createHash } from "crypto";
import { NextRequest, NextResponse } from "next/server";
import { getSupabase, SupabaseClient } from "@/db";
import { loadMatch } from "@/lib/matches";

export class ApiError extends Error {
  status: number;
  details?: unknown;
  constructor(message: string, status = 400, details?: unknown) {
    super(message);
    this.status = status;
    this.details = details;
  }
}

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
      return await fn(req, ctx as Parameters<F>[1]);
    } catch (err) {
      if (err instanceof ApiError) return fail(err.message, err.status, err.details);
      const message = err instanceof Error ? err.message : "Unexpected error";
      console.error("[api]", message);
      return fail(message, 500);
    }
  };
}

/** Run a callback with an awaited Supabase client. Avoids Promise chaining issues. */
export async function withSupabase<T>(fn: (sb: SupabaseClient) => Promise<T>): Promise<T> {
  const sb = await getSupabase();
  return fn(sb);
}

export async function requireUser() {
  const supabase = await getSupabase();
  const { data: { user }, error } = await supabase.auth.getUser();
  if (error || !user) throw new ApiError("Not authenticated", 401);

  const { data: profile } = await supabase
    .from("profiles")
    .select("id,email,username,display_name,avatar_url,bio,email_verified_at,created_at")
    .eq("id", user.id)
    .maybeSingle();

  const metadata = user.user_metadata ?? {};
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
    emailVerified: Boolean(user.email_confirmed_at),
    createdAt: user.created_at,
  };
}

export type Membership = {
  leagueId: string;
  profileId: string;
  role: "leader" | "manager" | "organizer";
  league: any;
};

export async function requireMember(leagueId: string): Promise<Membership> {
  const user = await requireUser();
  const supabase = await getSupabase();

  const { data: members } = await supabase
    .from("league_members")
    .select("*, leagues(*)")
    .eq("league_id", leagueId)
    .eq("profile_id", user.id)
    .maybeSingle();

  if (!members) throw new ApiError("You are not a member of this league", 403);

  return {
    leagueId,
    profileId: user.id,
    role: members.role as "leader" | "manager" | "organizer",
    league: members.leagues,
  };
}

export function leagueRules(league: any) {
  return {
    format: league.format,
    squadSize: league.squadSize,
    starters: league.starters,
    subsCount: league.subsCount,
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
/* Side effects: notifications, activity, audit                        */
/* ------------------------------------------------------------------ */

export async function notifyMembers(
  leagueId: string,
  input: {
    type: string;
    title: string;
    body: string;
    link?: string;
    exceptProfileId?: string;
    roles?: string[];
  },
) {
  const supabase = await getSupabase();

  let query = supabase
    .from("league_members")
    .select("profile_id")
    .eq("league_id", leagueId);

  if (input.roles?.length) {
    query = query.in("role", input.roles);
  }

  const { data: rows } = await query;
  const targets = rows
    ?.map((r: any) => r.profile_id)
    .filter((id: string) => id !== input.exceptProfileId) ?? [];
  if (!targets.length) return;

  await supabase.from("notifications").insert(
    targets.map((profileId: string) => ({
      profile_id: profileId,
      league_id: leagueId,
      type: input.type,
      title: input.title,
      body: input.body,
      link: input.link ?? `/leagues/${leagueId}`,
    })),
  );
}

export async function notifyUser(
  profileId: string,
  input: { type: string; title: string; body: string; link?: string; leagueId?: string },
) {
  const supabase = await getSupabase();
  await supabase.from("notifications").insert({
    profile_id: profileId,
    league_id: input.leagueId ?? null,
    type: input.type,
    title: input.title,
    body: input.body,
    link: input.link ?? "/notifications",
  });
}

export async function logActivity(
  leagueId: string,
  actorId: string | null,
  action: string,
  summary: string,
  meta?: Record<string, unknown>,
) {
  const supabase = await getSupabase();
  await supabase.from("league_activity").insert({
    league_id: leagueId,
    profile_id: actorId ?? undefined,
    action,
    summary,
    meta: meta ?? {},
  });
}

export async function logAudit(
  leagueId: string | null,
  actorId: string | null,
  action: string,
  entity: string,
  entityId: string,
  meta?: Record<string, unknown>,
) {
  const supabase = await getSupabase();
  await supabase.from("audit_logs").insert({
    league_id: leagueId ?? undefined,
    actor_id: actorId ?? undefined,
    action,
    entity,
    entity_id: entityId,
    meta: meta ?? {},
  });
}

/* ------------------------------------------------------------------ */
/* Idempotent mutation coordinator                                     */
/* ------------------------------------------------------------------ */

export type MutationOutcome<T> =
  | { state: "applied"; data: T }
  | { state: "duplicate"; data: T };

export async function withIdempotency<T>(
  opts: { route: string; profileId: string; operationId?: string | null; payload: unknown },
  fn: () => Promise<T>,
): Promise<MutationOutcome<T> | { state: "unknown" }> {
  const operationId = opts.operationId?.trim();
  if (!operationId) {
    return { state: "applied", data: await fn() };
  }
  if (operationId.length > 80) throw new ApiError("Invalid operation id", 400);

  const requestHash = createHash("sha256")
    .update(JSON.stringify(opts.payload ?? null))
    .digest("hex");

  const supabase = await getSupabase();

  const { data: existing } = await supabase
    .from("mutation_ops")
    .select("*")
    .eq("id", operationId)
    .maybeSingle();

  const row = existing;
  if (row) {
    if (row.profile_id !== opts.profileId)
      throw new ApiError("Operation id belongs to another user", 409);
    if (row.request_hash !== requestHash)
      throw new ApiError("Operation id reused with a different payload", 409);
    if (row.status === "applied") {
      return { state: "duplicate", data: row.result as T };
    }
    // pending: an earlier attempt never reported back — do not re-run.
    return { state: "unknown" };
  }

  await supabase.from("mutation_ops").insert({
    id: operationId,
    profile_id: opts.profileId,
    route: opts.route,
    request_hash: requestHash,
    status: "pending",
  });

  try {
    const data = await fn();
    await supabase
      .from("mutation_ops")
      .update({ status: "applied", applied_at: new Date().toISOString(), result: JSON.stringify(data ?? null) })
      .eq("id", operationId);
    return { state: "applied", data };
  } catch (err) {
    await supabase
      .from("mutation_ops")
      .update({
        status: "failed",
        result: JSON.stringify({ error: err instanceof Error ? err.message : "failed" }),
      })
      .eq("id", operationId);
    throw err;
  }
}

/** Reads the operation id from the request headers. */
export function operationId(req: NextRequest) {
  return req.headers.get("x-operation-id");
}

/* ------------------------------------------------------------------ */
/* Squad helpers                                                       */
/* ------------------------------------------------------------------ */

export async function loadSquad(leagueId: string, profileId: string) {
  const supabase = await getSupabase();
  const { data } = await supabase
    .from("fantasy_squads")
    .select("*")
    .eq("league_id", leagueId)
    .eq("profile_id", profileId)
    .maybeSingle();
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
  const { data } = await supabase
    .from("league_members")
    .select("profile_id, role, team_name, profiles(username, display_name, avatar_url)")
    .eq("league_id", leagueId);
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