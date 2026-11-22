import { NextRequest } from "next/server";
import { createHash, timingSafeEqual } from "node:crypto";
import { getServiceSupabase } from "@/db/service";
import { ApiError, handler } from "@/lib/server";

export const dynamic = "force-dynamic";

/**
 * The lineup deadline.
 *
 * A fixture's official lineup is locked in when its deadline passes. This
 * route is what makes that happen without anybody opening the app: a
 * scheduler calls it, it locks in every fixture that is due, and it reports
 * what it did.
 *
 * The caller proves itself with a secret that only the scheduler holds. The
 * secret is read from the environment at request time, it is never a
 * `NEXT_PUBLIC_` variable, and it never leaves the server. A request without
 * it is refused before anything is read or written.
 *
 * The promotion itself is decided by the database and is idempotent, so
 * calling this route twice promotes nothing the second time and two callers
 * at once still produce exactly one official lineup per fixture.
 *
 * Both GET and POST run it, because schedulers differ: GitHub Actions, cron
 * and most platform schedulers can be told to use either. The secret is what
 * keeps a stray GET from running it.
 */
function schedulerSecret() {
  // CRON_SECRET is the name Vercel Cron sends, LINEUP_DEADLINE_SECRET is
  // the name every other scheduler uses.
  return process.env.LINEUP_DEADLINE_SECRET || process.env.CRON_SECRET || "";
}

/** Compares two secrets without leaking their length or their contents. */
function sameSecret(given: string, expected: string) {
  const a = createHash("sha256").update(given).digest();
  const b = createHash("sha256").update(expected).digest();
  return timingSafeEqual(a, b);
}

const run = handler(async (req: NextRequest) => {
  const expected = schedulerSecret();
  if (!expected) throw new ApiError("The lineup deadline scheduler is not configured", 503);
  const header = req.headers.get("authorization") ?? "";
  const token = header.startsWith("Bearer ") ? header.slice("Bearer ".length) : "";
  if (!token || !sameSecret(token, expected)) throw new ApiError("Not authorized", 401);

  let sb: Awaited<ReturnType<typeof getServiceSupabase>>;
  try {
    sb = await getServiceSupabase();
  } catch {
    throw new ApiError("The lineup deadline scheduler is not configured", 503);
  }

  const { data, error } = await sb.rpc("ff_promote_due_match_lineups", { p_source: "scheduler" });
  if (error) throw new ApiError("Could not lock the lineups in", 503);
  // The status is read after the run, so the answer says how fresh the
  // deadline is and whether the database itself runs the job.
  const { data: status } = await sb.rpc("ff_lineup_deadline_status");
  return Response.json({ ...(data as Record<string, unknown>), status: status ?? null },
    { headers: { "Cache-Control": "no-store" } });
});

export const GET = run;
export const POST = run;
