import { NextRequest } from "next/server";
import { z } from "zod";
import { getSupabase } from "@/db";
import {
  ApiError,
  handler,
  leagueRules,
  logActivity,
  notifyMembers,
  notifyUser,
  requireMember,
  requireUser,
  canManageMatch,
} from "@/lib/server";
import { validateLineup, type Position } from "@/lib/domain";
import { recalculateMatchPoints } from "@/lib/points";
import { loadMatch } from "@/lib/matches";

type Ctx = { params: Promise<{ id: string }> };

const schema = z.object({
  action: z.enum(["submit", "approve", "reject"]),
  reason: z.string().max(400).optional(),
  /** the match version the reviewer saw — guards stale updates */
  version: z.number().int().min(1).optional(),
});

/**
 * Approval state machine:
 *   draft / rejected --submit--> pending --approve--> approved
 *                                    └----reject----> rejected
 *
 * Only approved matches ever produce fantasy points.
 *
 * Both the League Leader and the assigned Match Organizer have full
 * authority to enter, submit, approve, and reject results for matches
 * they are authorized to manage.
 */
export const POST = handler(async (req: NextRequest, ctx: Ctx) => {
  const { id } = await ctx.params;
  const body = await req.json().catch(() => null);
  const parsed = schema.safeParse(body);
  if (!parsed.success) {
    throw new ApiError("Invalid review action", 422, parsed.error.flatten().fieldErrors);
  }
  const { action, reason, version } = parsed.data;

  const user = await requireUser();
  const match = await loadMatch(id);
  if (!match) throw new ApiError("Match not found", 404);
  const membership = await requireMember(match.league_id);
  const rules = leagueRules(membership.league);

  if (action === "submit") {
    const auth = await canManageMatch(id, user.id);
    if (!auth.authorized) throw new ApiError("Not authorized to submit this match", 403);
    if (match.status !== "draft" && match.status !== "rejected") {
      throw new ApiError("This match is not awaiting submission", 409);
    }

    const supabase = await getSupabase();
    const { data: lineups } = await supabase
      .from("match_lineups")
      .select("*")
      .eq("match_id", id);
    const { data: roster } = await supabase
      .from("players")
      .select("*")
      .eq("league_id", match.league_id);
    const posOf = new Map((roster ?? []).map((p: any) => [p.id, p.position as Position]));

    const errors: string[] = [];
    for (const teamId of [match.team_a_id, match.team_b_id]) {
      const starters = (lineups ?? []).filter(
        (l: any) => l.team_id === teamId && l.slot === "starter",
      );
      const subs = (lineups ?? []).filter((l: any) => l.team_id === teamId && l.slot === "sub");
      const result = validateLineup(
        rules,
        starters.map((s: any) => ({ position: posOf.get(s.player_id) ?? "DEF" })),
        subs.map((s: any) => ({ position: posOf.get(s.player_id) ?? "DEF" })),
      );
      if (!result.ok) errors.push(...result.errors);
    }
    if (errors.length) throw new ApiError("Lineups are incomplete", 422, errors);

    const { data: ruleRows } = await supabase
      .from("scoring_rules")
      .select("*")
      .eq("league_id", match.league_id);
    if (!ruleRows?.length || !ruleRows.every((r: any) => r.status === "approved")) {
      throw new ApiError(
        "Scoring rules are still in draft. Approve them before submitting a result.",
        409,
        ["Scoring rules must be approved by the League Leader first."],
      );
    }

    const { data: updated, error: updateError } = await supabase
      .from("real_matches")
      .update({
        status: "pending",
        submitted_by: user.id,
        submitted_at: new Date().toISOString(),
        rejection_reason: null,
        version: match.version + 1,
        updated_at: new Date().toISOString(),
      })
      .eq("id", id)
      .eq("version", match.version)
      .eq("status", match.status)
      .select()
      .maybeSingle();
    if (updateError || !updated)
      throw new ApiError("Match changed while it was being submitted. Reload and try again.", 409);

    await supabase.from("match_approvals").insert({
      match_id: id,
      action: "submitted",
      actor_id: user.id,
      version: match.version + 1,
      snapshot: { title: match.title },
    });

    await logActivity(match.league_id, user.id, "match.submitted", `${match.title} submitted for review`);
    await notifyMembers(match.league_id, {
      type: "match_submitted",
      title: "Match submitted for review",
      body: match.title,
      link: `/matches/${id}`,
      exceptProfileId: user.id,
      roles: ["leader", "organizer"],
    });

    return Response.json({ match: updated, status: "pending" });
  }

  /* ---- approve / reject : League Leader or assigned Match Organizer ---- */
  const auth = await canManageMatch(id, user.id);
  if (!auth.authorized) throw new ApiError("Not authorized to review this match", 403);
  if (match.status !== "pending") throw new ApiError("This match is not pending review", 409);
  if (version !== undefined && version !== match.version) {
    throw new ApiError(
      "This result changed since you opened it. Reload and review the latest version.",
      409,
    );
  }

  // Product rule: the League Leader may approve even when they submitted,
  // and the Match Organizer may approve even when they are also the organizer.
  // League Leader may approve even when also the Match Organizer; Organizer authority is limited to matches they organize.

  const supabase = await getSupabase();

  if (action === "reject") {
    if (!reason?.trim()) throw new ApiError("A rejection reason is required", 422);
    const { data: updated, error: updateError } = await supabase
      .from("real_matches")
      .update({
        status: "rejected",
        decided_by: user.id,
        decided_at: new Date().toISOString(),
        rejection_reason: reason,
        version: match.version + 1,
        updated_at: new Date().toISOString(),
      })
      .eq("id", id)
      .eq("version", match.version)
      .eq("status", "pending")
      .select()
      .maybeSingle();
    if (updateError || !updated)
      throw new ApiError("Match changed while it was being reviewed. Reload and try again.", 409);
    await supabase.from("match_approvals").insert({
      match_id: id,
      action: "rejected",
      actor_id: user.id,
      reason,
      version: updated.version,
      snapshot: { title: match.title },
    });
    await logActivity(match.league_id, user.id, "match.rejected", `${match.title} rejected`);
    await notifyUser(match.organizer_id, {
      leagueId: match.league_id,
      type: "match_rejected",
      title: "Match result rejected",
      body: reason ?? "",
      link: `/matches/${id}`,
    });
    return Response.json({ match: updated, status: "rejected" });
  }

  const { data: updated, error: updateError } = await supabase
    .from("real_matches")
    .update({
      status: "approved",
      decided_by: user.id,
      decided_at: new Date().toISOString(),
      rejection_reason: null,
      version: match.version + 1,
      updated_at: new Date().toISOString(),
    })
    .eq("id", id)
    .eq("version", match.version)
    .eq("status", "pending")
    .select()
    .maybeSingle();
  if (updateError || !updated)
    throw new ApiError("Match changed while it was being reviewed. Reload and try again.", 409);

  await supabase.from("match_approvals").insert({
    match_id: id,
    action: "approved",
    actor_id: user.id,
    version: updated.version,
    snapshot: { title: match.title },
  });

  let points: unknown = null;
  let pointsError: string | null = null;
  try {
    points = await recalculateMatchPoints(id, { actorId: user.id });
  } catch (err) {
    pointsError = err instanceof Error ? err.message : "Points could not be calculated";
  }

  await logActivity(match.league_id, user.id, "match.approved", `${match.title} approved`);
  await notifyMembers(match.league_id, {
    type: "match_approved",
    title: "Match approved — standings updated",
    body: `${match.title} is now an official result.`,
    link: `/matches/${id}`,
  });

  return Response.json({ match: updated, status: "approved", points, pointsError });
});
