import { randomUUID } from "crypto";
import { sql } from "drizzle-orm";
import {
  boolean,
  check,
  index,
  integer,
  jsonb,
  numeric,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
} from "drizzle-orm/pg-core";

const id = () =>
  text("id")
    .primaryKey()
    .$defaultFn(() => randomUUID());
const createdAt = () =>
  timestamp("created_at", { withTimezone: true }).defaultNow().notNull();
const updatedAt = () =>
  timestamp("updated_at", { withTimezone: true })
    .defaultNow()
    .notNull()
    .$onUpdate(() => new Date());



/* ------------------------------------------------------------------ */
/* Auth                                                                */
/* ------------------------------------------------------------------ */

export const profiles = pgTable(
  "profiles",
  {
    id: id(),
    email: text("email").notNull(),
    emailLower: text("email_lower").notNull(),
    passwordHash: text("password_hash").notNull(),
    username: text("username").notNull(),
    displayName: text("display_name").notNull(),
    avatarUrl: text("avatar_url"),
    bio: text("bio"),
    emailVerifiedAt: timestamp("email_verified_at", { withTimezone: true }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    uniqueIndex("profiles_email_uq").on(t.emailLower),
    uniqueIndex("profiles_username_uq").on(t.username),
    check("profiles_username_len", sql`length(username) between 3 and 24`),
  ],
);

export const sessions = pgTable(
  "sessions",
  {
    id: id(),
    tokenHash: text("token_hash").notNull(),
    profileId: text("profile_id")
      .notNull()
      .references(() => profiles.id, { onDelete: "cascade" }),
    userAgent: text("user_agent"),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    lastSeenAt: timestamp("last_seen_at", { withTimezone: true }).notNull(),
    createdAt: createdAt(),
  },
  (t) => [
    uniqueIndex("sessions_token_uq").on(t.tokenHash),
    index("sessions_profile_idx").on(t.profileId),
    index("sessions_expiry_idx").on(t.expiresAt),
  ],
);

export const authTokens = pgTable(
  "auth_tokens",
  {
    id: id(),
    profileId: text("profile_id")
      .notNull()
      .references(() => profiles.id, { onDelete: "cascade" }),
    kind: text("kind").notNull(), // 'verify_email' | 'reset_password'
    tokenHash: text("token_hash").notNull(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    usedAt: timestamp("used_at", { withTimezone: true }),
    createdAt: createdAt(),
  },
  (t) => [
    uniqueIndex("auth_tokens_token_uq").on(t.tokenHash),
    index("auth_tokens_profile_idx").on(t.profileId),
    check("auth_tokens_kind_ck", sql`kind in ('verify_email','reset_password')`),
  ],
);

/** Dev/offline mail box: when no SMTP provider is configured the rendered
 *  message is persisted here so verification + reset links stay usable. */
export const mailOutbox = pgTable(
  "mail_outbox",
  {
    id: id(),
    toEmail: text("to_email").notNull(),
    subject: text("subject").notNull(),
    body: text("body").notNull(),
    link: text("link"),
    readAt: timestamp("read_at", { withTimezone: true }),
    createdAt: createdAt(),
  },
  (t) => [index("mail_outbox_email_idx").on(t.toEmail)],
);

/* ------------------------------------------------------------------ */
/* Leagues                                                             */
/* ------------------------------------------------------------------ */

export const leagues = pgTable(
  "leagues",
  {
    id: id(),
    name: text("name").notNull(),
    description: text("description"),
    /** '5v5' | '7v7' — permanent league setting driving every lineup rule */
    format: text("format").notNull().default("5v5"),
    squadSize: integer("squad_size").notNull().default(15),
    /** starters derived from format: 5 for 5v5, 7 for 7v7 */
    starters: integer("starters").notNull().default(5),
    /** substitutes are additional and configured by league settings */
    subsCount: integer("subs_count").notNull().default(5),
    inviteCode: text("invite_code").notNull(),
    /** 'auto_captain' => vice takes the double when the captain does not play */
    vicePolicy: text("vice_policy").notNull().default("auto_captain"),
    createdBy: text("created_by")
      .notNull()
      .references(() => profiles.id, { onDelete: "restrict" }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    uniqueIndex("leagues_invite_uq").on(t.inviteCode),
    check("leagues_format_ck", sql`format in ('5v5','7v7')`),
    check("leagues_starters_ck", sql`starters in (5,7)`),
    check("leagues_squad_ck", sql`squad_size = 15`),
    check("leagues_subs_ck", sql`subs_count >= 1 and subs_count <= 10`),
  ],
);

export const leagueMembers = pgTable(
  "league_members",
  {
    id: id(),
    leagueId: text("league_id")
      .notNull()
      .references(() => leagues.id, { onDelete: "cascade" }),
    profileId: text("profile_id")
      .notNull()
      .references(() => profiles.id, { onDelete: "cascade" }),
    role: text("role").notNull().default("manager"), // leader | manager | organizer
    teamName: text("team_name"),
    joinedAt: createdAt(),
  },
  (t) => [
    uniqueIndex("league_members_uq").on(t.leagueId, t.profileId),
    index("league_members_profile_idx").on(t.profileId),
    check(
      "league_members_role_ck",
      sql`role in ('leader','manager','organizer')`,
    ),
  ],
);

export const invitations = pgTable(
  "invitations",
  {
    id: id(),
    leagueId: text("league_id")
      .notNull()
      .references(() => leagues.id, { onDelete: "cascade" }),
    code: text("code").notNull(),
    note: text("note"),
    createdBy: text("created_by")
      .notNull()
      .references(() => profiles.id, { onDelete: "cascade" }),
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
    acceptedBy: text("accepted_by").references(() => profiles.id, {
      onDelete: "set null",
    }),
    acceptedAt: timestamp("accepted_at", { withTimezone: true }),
    expiresAt: timestamp("expires_at", { withTimezone: true }),
    createdAt: createdAt(),
  },
  (t) => [
    uniqueIndex("invitations_code_uq").on(t.code),
    index("invitations_league_idx").on(t.leagueId),
  ],
);

/* ------------------------------------------------------------------ */
/* League-scoped player database (never global)                        */
/* ------------------------------------------------------------------ */

export const teams = pgTable(
  "teams",
  {
    id: id(),
    leagueId: text("league_id")
      .notNull()
      .references(() => leagues.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    shortName: text("short_name"),
    crestUrl: text("crest_url"),
    createdAt: createdAt(),
  },
  (t) => [uniqueIndex("teams_league_name_uq").on(t.leagueId, t.name)],
);

export const players = pgTable(
  "players",
  {
    id: id(),
    /** every player belongs to exactly one league — hard isolation */
    leagueId: text("league_id")
      .notNull()
      .references(() => leagues.id, { onDelete: "cascade" }),
    teamId: text("team_id").references(() => teams.id, {
      onDelete: "set null",
    }),
    fullName: text("full_name").notNull(),
    photoUrl: text("photo_url"),
    position: text("position").notNull(), // GK | DEF | MID | FWD
    shirtNumber: integer("shirt_number"),
    availability: text("availability").notNull().default("available"),
    status: text("status").notNull().default("active"), // active | archived
    description: text("description"),
    createdBy: text("created_by").references(() => profiles.id, {
      onDelete: "set null",
    }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    index("players_league_idx").on(t.leagueId),
    index("players_team_idx").on(t.teamId),
    check(
      "players_position_ck",
      sql`position in ('GK','DEF','MID','FWD')`,
    ),
    check(
      "players_availability_ck",
      sql`availability in ('available','doubt','injured','suspended')`,
    ),
    check("players_status_ck", sql`status in ('active','archived')`),
    check(
      "players_shirt_ck",
      sql`shirt_number is null or (shirt_number between 1 and 99)`,
    ),
    check("players_name_ck", sql`length(trim(full_name)) between 2 and 80`),
  ],
);

/* ------------------------------------------------------------------ */
/* Fantasy squads                                                      */
/* ------------------------------------------------------------------ */

export const fantasySquads = pgTable(
  "fantasy_squads",
  {
    id: id(),
    leagueId: text("league_id")
      .notNull()
      .references(() => leagues.id, { onDelete: "cascade" }),
    profileId: text("profile_id")
      .notNull()
      .references(() => profiles.id, { onDelete: "cascade" }),
    formation: text("formation").notNull(),
    captainId: text("captain_id"),
    viceCaptainId: text("vice_captain_id"),
    completedAt: timestamp("completed_at", { withTimezone: true }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    uniqueIndex("fantasy_squads_uq").on(t.leagueId, t.profileId),
    index("fantasy_squads_profile_idx").on(t.profileId),
  ],
);

export const fantasySquadPlayers = pgTable(
  "fantasy_squad_players",
  {
    id: id(),
    squadId: text("squad_id")
      .notNull()
      .references(() => fantasySquads.id, { onDelete: "cascade" }),
    playerId: text("player_id")
      .notNull()
      .references(() => players.id, { onDelete: "restrict" }),
    slot: text("slot").notNull(), // starter | sub | reserve
    /** back-to-front order on the pitch for starters; bench order for subs */
    order: integer("order").notNull().default(0),
    createdAt: createdAt(),
  },
  (t) => [
    uniqueIndex("fsp_squad_player_uq").on(t.squadId, t.playerId),
    index("fsp_player_idx").on(t.playerId),
    check("fsp_slot_ck", sql`slot in ('starter','sub','reserve')`),
  ],
);

/* ------------------------------------------------------------------ */
/* Fixtures                                                            */
/* ------------------------------------------------------------------ */

export const fantasyFixtures = pgTable(
  "fantasy_fixtures",
  {
    id: id(),
    leagueId: text("league_id")
      .notNull()
      .references(() => leagues.id, { onDelete: "cascade" }),
    gameweek: integer("gameweek").notNull().default(1),
    title: text("title").notNull(),
    scheduledAt: timestamp("scheduled_at", { withTimezone: true }),
    status: text("status").notNull().default("scheduled"),
    realMatchId: text("real_match_id"),
    notes: text("notes"),
    createdBy: text("created_by").references(() => profiles.id, {
      onDelete: "set null",
    }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    index("fixtures_league_idx").on(t.leagueId),
    check(
      "fixtures_status_ck",
      sql`status in ('scheduled','active','completed','cancelled')`,
    ),
  ],
);

/* ------------------------------------------------------------------ */
/* Real matches + approval workflow                                    */
/* ------------------------------------------------------------------ */

export const realMatches = pgTable(
  "real_matches",
  {
    id: id(),
    leagueId: text("league_id")
      .notNull()
      .references(() => leagues.id, { onDelete: "cascade" }),
    fixtureId: text("fixture_id").references(() => fantasyFixtures.id, {
      onDelete: "set null",
    }),
    teamAId: text("team_a_id")
      .notNull()
      .references(() => teams.id, { onDelete: "restrict" }),
    teamBId: text("team_b_id")
      .notNull()
      .references(() => teams.id, { onDelete: "restrict" }),
    title: text("title").notNull(),
    kickOff: timestamp("kick_off", { withTimezone: true }).notNull(),
    status: text("status").notNull().default("draft"),
    organizerId: text("organizer_id")
      .notNull()
      .references(() => profiles.id, { onDelete: "restrict" }),
    submittedBy: text("submitted_by").references(() => profiles.id, {
      onDelete: "set null",
    }),
    submittedAt: timestamp("submitted_at", { withTimezone: true }),
    decidedBy: text("decided_by").references(() => profiles.id, {
      onDelete: "set null",
    }),
    decidedAt: timestamp("decided_at", { withTimezone: true }),
    rejectionReason: text("rejection_reason"),
    /** increments on every resubmission — guards duplicate approvals */
    version: integer("version").notNull().default(1),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    index("matches_league_idx").on(t.leagueId),
    index("matches_status_idx").on(t.status),
    check(
      "matches_status_ck",
      sql`status in ('draft','pending','approved','rejected')`,
    ),
    check("matches_teams_ck", sql`team_a_id <> team_b_id`),
  ],
);

export const matchLineups = pgTable(
  "match_lineups",
  {
    id: id(),
    matchId: text("match_id")
      .notNull()
      .references(() => realMatches.id, { onDelete: "cascade" }),
    leagueId: text("league_id")
      .notNull()
      .references(() => leagues.id, { onDelete: "cascade" }),
    teamId: text("team_id")
      .notNull()
      .references(() => teams.id, { onDelete: "cascade" }),
    playerId: text("player_id")
      .notNull()
      .references(() => players.id, { onDelete: "restrict" }),
    slot: text("slot").notNull(), // starter | sub
    order: integer("order").notNull().default(0),
    createdAt: createdAt(),
  },
  (t) => [
    uniqueIndex("lineup_match_player_uq").on(t.matchId, t.playerId),
    index("lineup_match_team_idx").on(t.matchId, t.teamId),
    check("lineup_slot_ck", sql`slot in ('starter','sub')`),
  ],
);

export const matchEvents = pgTable(
  "match_events",
  {
    id: id(),
    matchId: text("match_id")
      .notNull()
      .references(() => realMatches.id, { onDelete: "cascade" }),
    leagueId: text("league_id")
      .notNull()
      .references(() => leagues.id, { onDelete: "cascade" }),
    teamId: text("team_id")
      .notNull()
      .references(() => teams.id, { onDelete: "cascade" }),
    playerId: text("player_id")
      .notNull()
      .references(() => players.id, { onDelete: "restrict" }),
    assistPlayerId: text("assist_player_id").references(() => players.id, {
      onDelete: "set null",
    }),
    eventType: text("event_type").notNull(),
    minute: integer("minute").notNull(),
    note: text("note"),
    createdBy: text("created_by").references(() => profiles.id, {
      onDelete: "set null",
    }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    index("events_match_idx").on(t.matchId),
    index("events_player_idx").on(t.playerId),
    check(
      "events_type_ck",
      sql`event_type in ('goal','own_goal','assist','yellow_card','red_card','penalty_saved','penalty_missed')`,
    ),
    check("events_minute_ck", sql`minute between 0 and 200`),
  ],
);

export const matchSubstitutions = pgTable(
  "match_substitutions",
  {
    id: id(),
    matchId: text("match_id")
      .notNull()
      .references(() => realMatches.id, { onDelete: "cascade" }),
    leagueId: text("league_id")
      .notNull()
      .references(() => leagues.id, { onDelete: "cascade" }),
    teamId: text("team_id")
      .notNull()
      .references(() => teams.id, { onDelete: "cascade" }),
    playerOnId: text("player_on_id")
      .notNull()
      .references(() => players.id, { onDelete: "restrict" }),
    playerOffId: text("player_off_id")
      .notNull()
      .references(() => players.id, { onDelete: "restrict" }),
    minute: integer("minute").notNull(),
    createdBy: text("created_by").references(() => profiles.id, {
      onDelete: "set null",
    }),
    createdAt: createdAt(),
  },
  (t) => [
    index("subs_match_idx").on(t.matchId),
    check("subs_minute_ck", sql`minute between 0 and 200`),
    check("subs_players_ck", sql`player_on_id <> player_off_id`),
  ],
);

export const matchApprovals = pgTable(
  "match_approvals",
  {
    id: id(),
    matchId: text("match_id")
      .notNull()
      .references(() => realMatches.id, { onDelete: "cascade" }),
    action: text("action").notNull(), // submitted | approved | rejected | reopened
    actorId: text("actor_id")
      .notNull()
      .references(() => profiles.id, { onDelete: "restrict" }),
    reason: text("reason"),
    version: integer("version").notNull().default(1),
    snapshot: jsonb("snapshot"),
    createdAt: createdAt(),
  },
  (t) => [
    index("approvals_match_idx").on(t.matchId),
    check(
      "approvals_action_ck",
      sql`action in ('submitted','approved','rejected','reopened')`,
    ),
  ],
);

/* ------------------------------------------------------------------ */
/* Scoring                                                             */
/* ------------------------------------------------------------------ */

export const scoringRules = pgTable(
  "scoring_rules",
  {
    id: id(),
    leagueId: text("league_id")
      .notNull()
      .references(() => leagues.id, { onDelete: "cascade" }),
    position: text("position").notNull(),
    eventType: text("event_type").notNull(),
    points: numeric("points", { precision: 6, scale: 2 }).notNull(),
    status: text("status").notNull().default("draft"), // draft | approved
    approvedBy: text("approved_by").references(() => profiles.id, {
      onDelete: "set null",
    }),
    approvedAt: timestamp("approved_at", { withTimezone: true }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    uniqueIndex("rules_league_pos_event_uq").on(
      t.leagueId,
      t.position,
      t.eventType,
    ),
    check(
      "rules_position_ck",
      sql`position in ('GK','DEF','MID','FWD')`,
    ),
    check("rules_status_ck", sql`status in ('draft','approved')`),
    check("rules_points_ck", sql`points >= -20 and points <= 50`),
  ],
);

export const playerMatchPoints = pgTable(
  "player_match_points",
  {
    id: id(),
    leagueId: text("league_id")
      .notNull()
      .references(() => leagues.id, { onDelete: "cascade" }),
    matchId: text("match_id")
      .notNull()
      .references(() => realMatches.id, { onDelete: "cascade" }),
    playerId: text("player_id")
      .notNull()
      .references(() => players.id, { onDelete: "cascade" }),
    matchVersion: integer("match_version").notNull().default(1),
    points: numeric("points", { precision: 7, scale: 2 }).notNull(),
    breakdown: jsonb("breakdown").notNull(),
    computedAt: timestamp("computed_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (t) => [
    uniqueIndex("pmp_match_player_uq").on(t.matchId, t.playerId),
    index("pmp_league_player_idx").on(t.leagueId, t.playerId),
  ],
);

export const managerPoints = pgTable(
  "manager_points",
  {
    id: id(),
    leagueId: text("league_id")
      .notNull()
      .references(() => leagues.id, { onDelete: "cascade" }),
    matchId: text("match_id")
      .notNull()
      .references(() => realMatches.id, { onDelete: "cascade" }),
    profileId: text("profile_id")
      .notNull()
      .references(() => profiles.id, { onDelete: "cascade" }),
    matchVersion: integer("match_version").notNull().default(1),
    points: numeric("points", { precision: 7, scale: 2 }).notNull(),
    breakdown: jsonb("breakdown").notNull(),
    computedAt: timestamp("computed_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (t) => [
    uniqueIndex("mp_match_manager_uq").on(t.matchId, t.profileId),
    index("mp_league_manager_idx").on(t.leagueId, t.profileId),
  ],
);

export const leagueStandings = pgTable(
  "league_standings",
  {
    id: id(),
    leagueId: text("league_id")
      .notNull()
      .references(() => leagues.id, { onDelete: "cascade" }),
    profileId: text("profile_id")
      .notNull()
      .references(() => profiles.id, { onDelete: "cascade" }),
    rank: integer("rank").notNull().default(0),
    prevRank: integer("prev_rank"),
    totalPoints: numeric("total_points", { precision: 8, scale: 2 })
      .notNull()
      .default("0"),
    matchesPlayed: integer("matches_played").notNull().default(0),
    form: jsonb("form").notNull().default(sql`'[]'::jsonb`),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (t) => [
    uniqueIndex("standings_league_manager_uq").on(t.leagueId, t.profileId),
    index("standings_league_rank_idx").on(t.leagueId, t.rank),
  ],
);

export const fantasyPointsHistory = pgTable(
  "fantasy_points_history",
  {
    id: id(),
    leagueId: text("league_id")
      .notNull()
      .references(() => leagues.id, { onDelete: "cascade" }),
    profileId: text("profile_id")
      .notNull()
      .references(() => profiles.id, { onDelete: "cascade" }),
    matchId: text("match_id")
      .notNull()
      .references(() => realMatches.id, { onDelete: "cascade" }),
    gameweek: integer("gameweek").notNull().default(1),
    points: numeric("points", { precision: 7, scale: 2 }).notNull(),
    createdAt: createdAt(),
  },
  (t) => [
    uniqueIndex("fph_manager_match_uq").on(t.profileId, t.matchId),
    index("fph_league_idx").on(t.leagueId),
  ],
);

/* ------------------------------------------------------------------ */
/* Notifications, audit, idempotency                                   */
/* ------------------------------------------------------------------ */

export const notifications = pgTable(
  "notifications",
  {
    id: id(),
    profileId: text("profile_id")
      .notNull()
      .references(() => profiles.id, { onDelete: "cascade" }),
    leagueId: text("league_id").references(() => leagues.id, {
      onDelete: "cascade",
    }),
    type: text("type").notNull(),
    title: text("title").notNull(),
    body: text("body").notNull(),
    link: text("link"),
    readAt: timestamp("read_at", { withTimezone: true }),
    createdAt: createdAt(),
  },
  (t) => [
    index("notifications_profile_idx").on(t.profileId),
    index("notifications_unread_idx").on(t.profileId, t.readAt),
  ],
);

export const leagueActivity = pgTable(
  "league_activity",
  {
    id: id(),
    leagueId: text("league_id")
      .notNull()
      .references(() => leagues.id, { onDelete: "cascade" }),
    actorId: text("profile_id").references(() => profiles.id, {
      onDelete: "set null",
    }),
    action: text("action").notNull(),
    summary: text("summary").notNull(),
    meta: jsonb("meta"),
    createdAt: createdAt(),
  },
  (t) => [index("activity_league_idx").on(t.leagueId)],
);

export const auditLogs = pgTable(
  "audit_logs",
  {
    id: id(),
    leagueId: text("league_id").references(() => leagues.id, {
      onDelete: "cascade",
    }),
    actorId: text("actor_id").references(() => profiles.id, {
      onDelete: "set null",
    }),
    action: text("action").notNull(),
    entity: text("entity"),
    entityId: text("entity_id"),
    meta: jsonb("meta"),
    createdAt: createdAt(),
  },
  (t) => [index("audit_league_idx").on(t.leagueId)],
);

export const mutationOps = pgTable(
  "mutation_ops",
  {
    /** stable client-generated operation id — the idempotency key */
    id: text("id").primaryKey(),
    profileId: text("profile_id")
      .notNull()
      .references(() => profiles.id, { onDelete: "cascade" }),
    route: text("route").notNull(),
    requestHash: text("request_hash").notNull(),
    status: text("status").notNull().default("pending"), // pending | applied | failed
    result: jsonb("result"),
    createdAt: createdAt(),
    appliedAt: timestamp("applied_at", { withTimezone: true }),
  },
  (t) => [
    index("mutation_ops_profile_idx").on(t.profileId),
    check(
      "mutation_ops_status_ck",
      sql`status in ('pending','applied','failed')`,
    ),
  ],
);
