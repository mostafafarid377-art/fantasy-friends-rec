#!/usr/bin/env bash
#
# deploy-fresh-db.sh — Deploy Fantasy Friends migrations against a FRESH database.
#
# Usage: DATABASE_URL="postgres://user:pass@host:5432/dbname" ./scripts/deploy-fresh-db.sh
#
# This script:
#   1. Applies migrations 0001 through 0017 in order
#   2. Verifies all tables, RLS, functions, and grants are in place
#   3. Does NOT connect to or modify the remote Supabase project Hagz-fantasy
#   4. Does NOT run the legacy destructive migration (0000_destructive_removal.sql)
#
# Required environment variables:
#   DATABASE_URL — PostgreSQL connection string for the target (fresh) database
#   CONFIRM_DEPLOY — must be set to "yes" to proceed (prevents accidental runs)
#
# Safety: Denylisted project refs are refused. Deployment is never automatic.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
MIGRATIONS_DIR="$PROJECT_DIR/supabase/migrations"

# Denylisted Supabase project refs — never deploy to these
DENYLISTED_REFS=(
  "zkrfgdiujpagaddsxbcb"   # Hagz-fantasy production project ref
)

# Denylisted host patterns
DENYLISTED_HOSTS=(
  "hagz-fantasy"
  "supabase.co"
)

if [ -z "${DATABASE_URL:-}" ]; then
  echo "ERROR: DATABASE_URL is not set." >&2
  echo "Usage: DATABASE_URL=\"postgres://user:pass@host:5432/dbname\" CONFIRM_DEPLOY=yes $0" >&2
  exit 1
fi

if [ "${CONFIRM_DEPLOY:-}" != "yes" ]; then
  echo "ERROR: CONFIRM_DEPLOY=yes is required to run this script." >&2
  echo "This prevents accidental execution. Review the script, then re-run with CONFIRM_DEPLOY=yes." >&2
  exit 1
fi

# Extract host from DATABASE_URL (format: postgres://user:pass@host:port/db)
DB_HOST=$(echo "$DATABASE_URL" | sed -n 's/.*@\([^:/]*\).*/\1/p')

# Check denylisted hosts
for host_pattern in "${DENYLISTED_HOSTS[@]}"; do
  if echo "$DB_HOST" | grep -qi "$host_pattern"; then
    echo "ERROR: Refusing to deploy to denylisted host pattern: $host_pattern" >&2
    echo "Database host: $DB_HOST" >&2
    exit 1
  fi
done

# Check denylisted project refs (Supabase cloud hosts contain the project ref)
for ref in "${DENYLISTED_REFS[@]}"; do
  if echo "$DATABASE_URL" | grep -q "$ref"; then
    echo "ERROR: Refusing to deploy to denylisted Supabase project ref: $ref" >&2
    echo "This is the Hagz-fantasy production project." >&2
    exit 1
  fi
done

# Verify psql is available
if ! command -v psql &> /dev/null; then
  echo "ERROR: psql is not installed. Install postgresql-client to use this script." >&2
  exit 1
fi

echo "============================================================"
echo "Fantasy Friends — Fresh Database Deployment"
echo "============================================================"
echo "Target host: $DB_HOST"
echo "Confirm: CONFIRM_DEPLOY=yes"
echo ""

# Ordered list of migrations (forward-only, never modify already-applied)
MIGRATIONS=(
  "0001_schema.sql"
  "0002_rls.sql"
  "0003_functions.sql"
  "0004_native_auth_profiles.sql"
  "0005_confirmed_writes.sql"
  "0006_write_side_effects.sql"
  "0007_squad_system.sql"
  "0008_player_photos.sql"
  "0009_bench_lineups_scoring.sql"
  "0010_player_performance.sql"
  "0011_recorded_match_results.sql"
  "0012_captain_visibility_and_league_deletion.sql"
  "0013_match_duration.sql"
  "0014_match_deadlines.sql"
  "0015_match_statistics_and_bonuses.sql"
  "0016_team_logos.sql"
  "0017_google_profile_names.sql"
)

for migration in "${MIGRATIONS[@]}"; do
  MIGRATION_PATH="$MIGRATIONS_DIR/$migration"
  if [ ! -f "$MIGRATION_PATH" ]; then
    echo "ERROR: Migration not found: $MIGRATION_PATH" >&2
    exit 1
  fi

  echo "Applying $migration..."
  PGPASSWORD="${PGPASSWORD:-}" psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f "$MIGRATION_PATH" || {
    echo "ERROR: Failed to apply $migration" >&2
    exit 1
  }
  echo "  ✓ $migration applied"
  echo ""
done

echo "============================================================"
echo "Verifying deployment..."
echo "============================================================"

# Verify all expected tables exist
EXPECTED_TABLES=(
  "profiles" "leagues" "league_members" "league_standings" "league_activity"
  "teams" "players" "fantasy_squads" "fantasy_squad_players" "real_matches"
  "match_lineups" "match_events" "match_substitutions" "match_approvals" "match_scoring_receipts" "match_player_statistics"
  "scoring_rules" "player_match_points" "manager_points" "fantasy_points_history"
  "notifications" "audit_logs" "mutation_ops" "invitations" "fantasy_fixtures"
)

ALL_TABLES_OK=true
for table in "${EXPECTED_TABLES[@]}"; do
  COUNT=$(PGPASSWORD="${PGPASSWORD:-}" psql "$DATABASE_URL" -t -A -c \
    "SELECT to_regclass('public.$table');" 2>/dev/null | tr -d '[:space:]')
  if [ "$COUNT" != "$table" ]; then
    echo "  ✗ Missing table: $table" >&2
    ALL_TABLES_OK=false
  else
    echo "  ✓ Table exists: $table"
  fi
done

if [ "$ALL_TABLES_OK" = false ]; then
  echo "" >&2
  echo "ERROR: Some tables are missing. Deployment verification failed." >&2
  exit 1
fi

# Verify RLS is enabled on all tables
echo ""
echo "Verifying RLS policies..."
RLS_OK=true
for table in "${EXPECTED_TABLES[@]}"; do
  RLS_ENABLED=$(PGPASSWORD="${PGPASSWORD:-}" psql "$DATABASE_URL" -t -A -c \
    "SELECT rowsecurity FROM pg_tables WHERE schemaname='public' AND tablename='$table';" 2>/dev/null | tr -d '[:space:]')
  if [ "$RLS_ENABLED" != "t" ]; then
    echo "  ✗ RLS not enabled on: $table" >&2
    RLS_OK=false
  fi
done

if [ "$RLS_OK" = false ]; then
  echo "" >&2
  echo "ERROR: RLS not enabled on all tables." >&2
  exit 1
fi
echo "  ✓ RLS enabled on all tables"

# Verify GRANT execute on RPC functions
echo ""
echo "Verifying RPC function grants..."
for fn in "calculate_match_points" "recalculate_standings" "create_league" "join_league"; do
  GRANT_EXISTS=$(PGPASSWORD="${PGPASSWORD:-}" psql "$DATABASE_URL" -t -A -c \
    "SELECT count(*) FROM pg_proc
     JOIN pg_namespace ON pg_proc.pronamespace = pg_namespace.oid
     WHERE nspname='public' AND proname='$fn' AND proacl @> '{authenticated=X/ff_test}'::aclitem[];" 2>/dev/null | tr -d '[:space:]')
  if [ "$GRANT_EXISTS" != "1" ]; then
    echo "  ✗ Missing GRANT execute on $fn for authenticated" >&2
    exit 1
  fi
  echo "  ✓ GRANT execute on $fn"
done

# Verify allow_self_approval column does NOT exist
echo ""
echo "Verifying schema consistency..."
ALLOW_SELF=$(PGPASSWORD="${PGPASSWORD:-}" psql "$DATABASE_URL" -t -A -c \
  "SELECT count(*) FROM information_schema.columns
   WHERE table_schema='public' AND table_name='leagues' AND column_name='allow_self_approval';" 2>/dev/null | tr -d '[:space:]')
if [ "$ALLOW_SELF" != "0" ]; then
  echo "  ✗ allow_self_approval column still exists in leagues table" >&2
  exit 1
fi
echo "  ✓ allow_self_approval column removed from leagues"

echo ""
echo "============================================================"
echo "Fresh database deployment COMPLETE"
echo "============================================================"
echo ""
echo "All migrations applied in order: 0001 through 0017"
echo "All tables created, RLS enabled, RPC grants in place."
echo ""
echo "Next steps:"
echo "  1. Set DATABASE_URL in your app environment (not .env.local)"
echo "  2. Run: npm.cmd test (integration tests require DATABASE_URL)"
echo "  3. Verify: npm.cmd run typecheck && npm.cmd run audit:sql"
echo ""
echo "IMPORTANT: Never run supabase/legacy/0000_destructive_removal.sql"
echo "============================================================"
