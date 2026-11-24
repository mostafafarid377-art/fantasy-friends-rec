-- 0035_rate_limiter_trust_boundary.sql
--
-- Corrects the execution grants of the 0034 rate limiter.
--
-- Problem: 0034 granted EXECUTE on public.ff_rate_limit_hit(text,text) to
-- anon and authenticated. RPC arguments are client-controlled, so any
-- visitor could call the function directly with someone else's identity
-- (an email, a user id, an IP) and burn that victim's budget — a
-- denial-of-service against logins and a way to spam the internal table.
--
-- Fix: the limiter is a trusted server-side component. Only the
-- service_role may execute it, following the same boundary as the scoring
-- and deadline functions (calculate_match_points, recalculate_standings,
-- ff_promote_due_match_lineups). The application server reaches it through
-- the service-role client (src/db/service.ts); the service key is a
-- server-only environment variable and never ships to the browser.
--
-- Forward-only and order-safe: this file never edits 0034. A database that
-- already applied 0034 simply gets its grants corrected; a fresh database
-- applies 0034 and then 0035, landing on the same final posture. If 0034
-- was never applied (skipped), this file is a no-op rather than an error.

do $$
begin
  if to_regprocedure('public.ff_rate_limit_hit(text,text)') is not null then
    revoke execute on function public.ff_rate_limit_hit(text, text) from public, anon, authenticated;
    grant execute on function public.ff_rate_limit_hit(text, text) to service_role;
  end if;
end $$;
