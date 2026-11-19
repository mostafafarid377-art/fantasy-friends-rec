CREATE TABLE "audit_logs" (
	"id" text PRIMARY KEY NOT NULL,
	"league_id" text,
	"actor_id" text,
	"action" text NOT NULL,
	"entity" text,
	"entity_id" text,
	"meta" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "auth_tokens" (
	"id" text PRIMARY KEY NOT NULL,
	"profile_id" text NOT NULL,
	"kind" text NOT NULL,
	"token_hash" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"used_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "auth_tokens_kind_ck" CHECK (kind in ('verify_email','reset_password'))
);
--> statement-breakpoint
CREATE TABLE "fantasy_fixtures" (
	"id" text PRIMARY KEY NOT NULL,
	"league_id" text NOT NULL,
	"gameweek" integer DEFAULT 1 NOT NULL,
	"title" text NOT NULL,
	"scheduled_at" timestamp with time zone,
	"status" text DEFAULT 'scheduled' NOT NULL,
	"real_match_id" text,
	"notes" text,
	"created_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "fixtures_status_ck" CHECK (status in ('scheduled','active','completed','cancelled'))
);
--> statement-breakpoint
CREATE TABLE "fantasy_points_history" (
	"id" text PRIMARY KEY NOT NULL,
	"league_id" text NOT NULL,
	"profile_id" text NOT NULL,
	"match_id" text NOT NULL,
	"gameweek" integer DEFAULT 1 NOT NULL,
	"points" numeric(7, 2) NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "fantasy_squad_players" (
	"id" text PRIMARY KEY NOT NULL,
	"squad_id" text NOT NULL,
	"player_id" text NOT NULL,
	"slot" text NOT NULL,
	"order" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "fsp_slot_ck" CHECK (slot in ('starter','sub','reserve'))
);
--> statement-breakpoint
CREATE TABLE "fantasy_squads" (
	"id" text PRIMARY KEY NOT NULL,
	"league_id" text NOT NULL,
	"profile_id" text NOT NULL,
	"formation" text NOT NULL,
	"captain_id" text,
	"vice_captain_id" text,
	"completed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "invitations" (
	"id" text PRIMARY KEY NOT NULL,
	"league_id" text NOT NULL,
	"code" text NOT NULL,
	"note" text,
	"created_by" text NOT NULL,
	"revoked_at" timestamp with time zone,
	"accepted_by" text,
	"accepted_at" timestamp with time zone,
	"expires_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "league_activity" (
	"id" text PRIMARY KEY NOT NULL,
	"league_id" text NOT NULL,
	"profile_id" text,
	"action" text NOT NULL,
	"summary" text NOT NULL,
	"meta" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "league_members" (
	"id" text PRIMARY KEY NOT NULL,
	"league_id" text NOT NULL,
	"profile_id" text NOT NULL,
	"role" text DEFAULT 'manager' NOT NULL,
	"team_name" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "league_members_role_ck" CHECK (role in ('leader','manager','organizer'))
);
--> statement-breakpoint
CREATE TABLE "league_standings" (
	"id" text PRIMARY KEY NOT NULL,
	"league_id" text NOT NULL,
	"profile_id" text NOT NULL,
	"rank" integer DEFAULT 0 NOT NULL,
	"prev_rank" integer,
	"total_points" numeric(8, 2) DEFAULT '0' NOT NULL,
	"matches_played" integer DEFAULT 0 NOT NULL,
	"form" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "leagues" (
	"id" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"description" text,
	"format" text DEFAULT '5v5' NOT NULL,
	"squad_size" integer DEFAULT 15 NOT NULL,
	"starters" integer DEFAULT 5 NOT NULL,
	"subs_count" integer DEFAULT 5 NOT NULL,
	"invite_code" text NOT NULL,
	"vice_policy" text DEFAULT 'auto_captain' NOT NULL,
	"created_by" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "leagues_format_ck" CHECK (format in ('5v5','7v7')),
	CONSTRAINT "leagues_starters_ck" CHECK (starters in (5,7)),
	CONSTRAINT "leagues_squad_ck" CHECK (squad_size = 15),
	CONSTRAINT "leagues_subs_ck" CHECK (subs_count >= 1 and subs_count <= 10)
);
--> statement-breakpoint
CREATE TABLE "mail_outbox" (
	"id" text PRIMARY KEY NOT NULL,
	"to_email" text NOT NULL,
	"subject" text NOT NULL,
	"body" text NOT NULL,
	"link" text,
	"read_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "manager_points" (
	"id" text PRIMARY KEY NOT NULL,
	"league_id" text NOT NULL,
	"match_id" text NOT NULL,
	"profile_id" text NOT NULL,
	"match_version" integer DEFAULT 1 NOT NULL,
	"points" numeric(7, 2) NOT NULL,
	"breakdown" jsonb NOT NULL,
	"computed_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "match_approvals" (
	"id" text PRIMARY KEY NOT NULL,
	"match_id" text NOT NULL,
	"action" text NOT NULL,
	"actor_id" text NOT NULL,
	"reason" text,
	"version" integer DEFAULT 1 NOT NULL,
	"snapshot" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "approvals_action_ck" CHECK (action in ('submitted','approved','rejected','reopened'))
);
--> statement-breakpoint
CREATE TABLE "match_events" (
	"id" text PRIMARY KEY NOT NULL,
	"match_id" text NOT NULL,
	"league_id" text NOT NULL,
	"team_id" text NOT NULL,
	"player_id" text NOT NULL,
	"assist_player_id" text,
	"event_type" text NOT NULL,
	"minute" integer NOT NULL,
	"note" text,
	"created_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "events_type_ck" CHECK (event_type in ('goal','own_goal','assist','yellow_card','red_card','penalty_saved','penalty_missed')),
	CONSTRAINT "events_minute_ck" CHECK (minute between 0 and 200)
);
--> statement-breakpoint
CREATE TABLE "match_lineups" (
	"id" text PRIMARY KEY NOT NULL,
	"match_id" text NOT NULL,
	"league_id" text NOT NULL,
	"team_id" text NOT NULL,
	"player_id" text NOT NULL,
	"slot" text NOT NULL,
	"order" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "lineup_slot_ck" CHECK (slot in ('starter','sub'))
);
--> statement-breakpoint
CREATE TABLE "match_substitutions" (
	"id" text PRIMARY KEY NOT NULL,
	"match_id" text NOT NULL,
	"league_id" text NOT NULL,
	"team_id" text NOT NULL,
	"player_on_id" text NOT NULL,
	"player_off_id" text NOT NULL,
	"minute" integer NOT NULL,
	"created_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "subs_minute_ck" CHECK (minute between 0 and 200),
	CONSTRAINT "subs_players_ck" CHECK (player_on_id <> player_off_id)
);
--> statement-breakpoint
CREATE TABLE "mutation_ops" (
	"id" text PRIMARY KEY NOT NULL,
	"profile_id" text NOT NULL,
	"route" text NOT NULL,
	"request_hash" text NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"result" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"applied_at" timestamp with time zone,
	CONSTRAINT "mutation_ops_status_ck" CHECK (status in ('pending','applied','failed'))
);
--> statement-breakpoint
CREATE TABLE "notifications" (
	"id" text PRIMARY KEY NOT NULL,
	"profile_id" text NOT NULL,
	"league_id" text,
	"type" text NOT NULL,
	"title" text NOT NULL,
	"body" text NOT NULL,
	"link" text,
	"read_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "player_match_points" (
	"id" text PRIMARY KEY NOT NULL,
	"league_id" text NOT NULL,
	"match_id" text NOT NULL,
	"player_id" text NOT NULL,
	"match_version" integer DEFAULT 1 NOT NULL,
	"points" numeric(7, 2) NOT NULL,
	"breakdown" jsonb NOT NULL,
	"computed_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "players" (
	"id" text PRIMARY KEY NOT NULL,
	"league_id" text NOT NULL,
	"team_id" text,
	"full_name" text NOT NULL,
	"photo_url" text,
	"position" text NOT NULL,
	"shirt_number" integer,
	"availability" text DEFAULT 'available' NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"description" text,
	"created_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "players_position_ck" CHECK (position in ('GK','DEF','MID','FWD')),
	CONSTRAINT "players_availability_ck" CHECK (availability in ('available','doubt','injured','suspended')),
	CONSTRAINT "players_status_ck" CHECK (status in ('active','archived')),
	CONSTRAINT "players_shirt_ck" CHECK (shirt_number is null or (shirt_number between 1 and 99)),
	CONSTRAINT "players_name_ck" CHECK (length(trim(full_name)) between 2 and 80)
);
--> statement-breakpoint
CREATE TABLE "profiles" (
	"id" text PRIMARY KEY NOT NULL,
	"email" text NOT NULL,
	"email_lower" text NOT NULL,
	"password_hash" text NOT NULL,
	"username" text NOT NULL,
	"display_name" text NOT NULL,
	"avatar_url" text,
	"bio" text,
	"email_verified_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "profiles_username_len" CHECK (length(username) between 3 and 24)
);
--> statement-breakpoint
CREATE TABLE "real_matches" (
	"id" text PRIMARY KEY NOT NULL,
	"league_id" text NOT NULL,
	"fixture_id" text,
	"team_a_id" text NOT NULL,
	"team_b_id" text NOT NULL,
	"title" text NOT NULL,
	"kick_off" timestamp with time zone NOT NULL,
	"status" text DEFAULT 'draft' NOT NULL,
	"organizer_id" text NOT NULL,
	"submitted_by" text,
	"submitted_at" timestamp with time zone,
	"decided_by" text,
	"decided_at" timestamp with time zone,
	"rejection_reason" text,
	"version" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "matches_status_ck" CHECK (status in ('draft','pending','approved','rejected')),
	CONSTRAINT "matches_teams_ck" CHECK (team_a_id <> team_b_id)
);
--> statement-breakpoint
CREATE TABLE "scoring_rules" (
	"id" text PRIMARY KEY NOT NULL,
	"league_id" text NOT NULL,
	"position" text NOT NULL,
	"event_type" text NOT NULL,
	"points" numeric(6, 2) NOT NULL,
	"status" text DEFAULT 'draft' NOT NULL,
	"approved_by" text,
	"approved_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "rules_position_ck" CHECK (position in ('GK','DEF','MID','FWD')),
	CONSTRAINT "rules_status_ck" CHECK (status in ('draft','approved')),
	CONSTRAINT "rules_points_ck" CHECK (points >= -20 and points <= 50)
);
--> statement-breakpoint
CREATE TABLE "sessions" (
	"id" text PRIMARY KEY NOT NULL,
	"token_hash" text NOT NULL,
	"profile_id" text NOT NULL,
	"user_agent" text,
	"expires_at" timestamp with time zone NOT NULL,
	"last_seen_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "teams" (
	"id" text PRIMARY KEY NOT NULL,
	"league_id" text NOT NULL,
	"name" text NOT NULL,
	"short_name" text,
	"crest_url" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "audit_logs" ADD CONSTRAINT "audit_logs_league_id_leagues_id_fk" FOREIGN KEY ("league_id") REFERENCES "public"."leagues"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "audit_logs" ADD CONSTRAINT "audit_logs_actor_id_profiles_id_fk" FOREIGN KEY ("actor_id") REFERENCES "public"."profiles"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "auth_tokens" ADD CONSTRAINT "auth_tokens_profile_id_profiles_id_fk" FOREIGN KEY ("profile_id") REFERENCES "public"."profiles"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "fantasy_fixtures" ADD CONSTRAINT "fantasy_fixtures_league_id_leagues_id_fk" FOREIGN KEY ("league_id") REFERENCES "public"."leagues"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "fantasy_fixtures" ADD CONSTRAINT "fantasy_fixtures_created_by_profiles_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."profiles"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "fantasy_points_history" ADD CONSTRAINT "fantasy_points_history_league_id_leagues_id_fk" FOREIGN KEY ("league_id") REFERENCES "public"."leagues"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "fantasy_points_history" ADD CONSTRAINT "fantasy_points_history_profile_id_profiles_id_fk" FOREIGN KEY ("profile_id") REFERENCES "public"."profiles"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "fantasy_points_history" ADD CONSTRAINT "fantasy_points_history_match_id_real_matches_id_fk" FOREIGN KEY ("match_id") REFERENCES "public"."real_matches"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "fantasy_squad_players" ADD CONSTRAINT "fantasy_squad_players_squad_id_fantasy_squads_id_fk" FOREIGN KEY ("squad_id") REFERENCES "public"."fantasy_squads"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "fantasy_squad_players" ADD CONSTRAINT "fantasy_squad_players_player_id_players_id_fk" FOREIGN KEY ("player_id") REFERENCES "public"."players"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "fantasy_squads" ADD CONSTRAINT "fantasy_squads_league_id_leagues_id_fk" FOREIGN KEY ("league_id") REFERENCES "public"."leagues"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "fantasy_squads" ADD CONSTRAINT "fantasy_squads_profile_id_profiles_id_fk" FOREIGN KEY ("profile_id") REFERENCES "public"."profiles"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "invitations" ADD CONSTRAINT "invitations_league_id_leagues_id_fk" FOREIGN KEY ("league_id") REFERENCES "public"."leagues"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "invitations" ADD CONSTRAINT "invitations_created_by_profiles_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."profiles"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "invitations" ADD CONSTRAINT "invitations_accepted_by_profiles_id_fk" FOREIGN KEY ("accepted_by") REFERENCES "public"."profiles"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "league_activity" ADD CONSTRAINT "league_activity_league_id_leagues_id_fk" FOREIGN KEY ("league_id") REFERENCES "public"."leagues"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "league_activity" ADD CONSTRAINT "league_activity_profile_id_profiles_id_fk" FOREIGN KEY ("profile_id") REFERENCES "public"."profiles"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "league_members" ADD CONSTRAINT "league_members_league_id_leagues_id_fk" FOREIGN KEY ("league_id") REFERENCES "public"."leagues"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "league_members" ADD CONSTRAINT "league_members_profile_id_profiles_id_fk" FOREIGN KEY ("profile_id") REFERENCES "public"."profiles"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "league_standings" ADD CONSTRAINT "league_standings_league_id_leagues_id_fk" FOREIGN KEY ("league_id") REFERENCES "public"."leagues"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "league_standings" ADD CONSTRAINT "league_standings_profile_id_profiles_id_fk" FOREIGN KEY ("profile_id") REFERENCES "public"."profiles"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "leagues" ADD CONSTRAINT "leagues_created_by_profiles_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."profiles"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "manager_points" ADD CONSTRAINT "manager_points_league_id_leagues_id_fk" FOREIGN KEY ("league_id") REFERENCES "public"."leagues"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "manager_points" ADD CONSTRAINT "manager_points_match_id_real_matches_id_fk" FOREIGN KEY ("match_id") REFERENCES "public"."real_matches"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "manager_points" ADD CONSTRAINT "manager_points_profile_id_profiles_id_fk" FOREIGN KEY ("profile_id") REFERENCES "public"."profiles"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "match_approvals" ADD CONSTRAINT "match_approvals_match_id_real_matches_id_fk" FOREIGN KEY ("match_id") REFERENCES "public"."real_matches"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "match_approvals" ADD CONSTRAINT "match_approvals_actor_id_profiles_id_fk" FOREIGN KEY ("actor_id") REFERENCES "public"."profiles"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "match_events" ADD CONSTRAINT "match_events_match_id_real_matches_id_fk" FOREIGN KEY ("match_id") REFERENCES "public"."real_matches"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "match_events" ADD CONSTRAINT "match_events_league_id_leagues_id_fk" FOREIGN KEY ("league_id") REFERENCES "public"."leagues"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "match_events" ADD CONSTRAINT "match_events_team_id_teams_id_fk" FOREIGN KEY ("team_id") REFERENCES "public"."teams"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "match_events" ADD CONSTRAINT "match_events_player_id_players_id_fk" FOREIGN KEY ("player_id") REFERENCES "public"."players"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "match_events" ADD CONSTRAINT "match_events_assist_player_id_players_id_fk" FOREIGN KEY ("assist_player_id") REFERENCES "public"."players"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "match_events" ADD CONSTRAINT "match_events_created_by_profiles_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."profiles"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "match_lineups" ADD CONSTRAINT "match_lineups_match_id_real_matches_id_fk" FOREIGN KEY ("match_id") REFERENCES "public"."real_matches"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "match_lineups" ADD CONSTRAINT "match_lineups_league_id_leagues_id_fk" FOREIGN KEY ("league_id") REFERENCES "public"."leagues"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "match_lineups" ADD CONSTRAINT "match_lineups_team_id_teams_id_fk" FOREIGN KEY ("team_id") REFERENCES "public"."teams"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "match_lineups" ADD CONSTRAINT "match_lineups_player_id_players_id_fk" FOREIGN KEY ("player_id") REFERENCES "public"."players"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "match_substitutions" ADD CONSTRAINT "match_substitutions_match_id_real_matches_id_fk" FOREIGN KEY ("match_id") REFERENCES "public"."real_matches"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "match_substitutions" ADD CONSTRAINT "match_substitutions_league_id_leagues_id_fk" FOREIGN KEY ("league_id") REFERENCES "public"."leagues"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "match_substitutions" ADD CONSTRAINT "match_substitutions_team_id_teams_id_fk" FOREIGN KEY ("team_id") REFERENCES "public"."teams"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "match_substitutions" ADD CONSTRAINT "match_substitutions_player_on_id_players_id_fk" FOREIGN KEY ("player_on_id") REFERENCES "public"."players"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "match_substitutions" ADD CONSTRAINT "match_substitutions_player_off_id_players_id_fk" FOREIGN KEY ("player_off_id") REFERENCES "public"."players"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "match_substitutions" ADD CONSTRAINT "match_substitutions_created_by_profiles_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."profiles"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mutation_ops" ADD CONSTRAINT "mutation_ops_profile_id_profiles_id_fk" FOREIGN KEY ("profile_id") REFERENCES "public"."profiles"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notifications" ADD CONSTRAINT "notifications_profile_id_profiles_id_fk" FOREIGN KEY ("profile_id") REFERENCES "public"."profiles"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notifications" ADD CONSTRAINT "notifications_league_id_leagues_id_fk" FOREIGN KEY ("league_id") REFERENCES "public"."leagues"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "player_match_points" ADD CONSTRAINT "player_match_points_league_id_leagues_id_fk" FOREIGN KEY ("league_id") REFERENCES "public"."leagues"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "player_match_points" ADD CONSTRAINT "player_match_points_match_id_real_matches_id_fk" FOREIGN KEY ("match_id") REFERENCES "public"."real_matches"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "player_match_points" ADD CONSTRAINT "player_match_points_player_id_players_id_fk" FOREIGN KEY ("player_id") REFERENCES "public"."players"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "players" ADD CONSTRAINT "players_league_id_leagues_id_fk" FOREIGN KEY ("league_id") REFERENCES "public"."leagues"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "players" ADD CONSTRAINT "players_team_id_teams_id_fk" FOREIGN KEY ("team_id") REFERENCES "public"."teams"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "players" ADD CONSTRAINT "players_created_by_profiles_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."profiles"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "real_matches" ADD CONSTRAINT "real_matches_league_id_leagues_id_fk" FOREIGN KEY ("league_id") REFERENCES "public"."leagues"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "real_matches" ADD CONSTRAINT "real_matches_fixture_id_fantasy_fixtures_id_fk" FOREIGN KEY ("fixture_id") REFERENCES "public"."fantasy_fixtures"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "real_matches" ADD CONSTRAINT "real_matches_team_a_id_teams_id_fk" FOREIGN KEY ("team_a_id") REFERENCES "public"."teams"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "real_matches" ADD CONSTRAINT "real_matches_team_b_id_teams_id_fk" FOREIGN KEY ("team_b_id") REFERENCES "public"."teams"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "real_matches" ADD CONSTRAINT "real_matches_organizer_id_profiles_id_fk" FOREIGN KEY ("organizer_id") REFERENCES "public"."profiles"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "real_matches" ADD CONSTRAINT "real_matches_submitted_by_profiles_id_fk" FOREIGN KEY ("submitted_by") REFERENCES "public"."profiles"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "real_matches" ADD CONSTRAINT "real_matches_decided_by_profiles_id_fk" FOREIGN KEY ("decided_by") REFERENCES "public"."profiles"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "scoring_rules" ADD CONSTRAINT "scoring_rules_league_id_leagues_id_fk" FOREIGN KEY ("league_id") REFERENCES "public"."leagues"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "scoring_rules" ADD CONSTRAINT "scoring_rules_approved_by_profiles_id_fk" FOREIGN KEY ("approved_by") REFERENCES "public"."profiles"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sessions" ADD CONSTRAINT "sessions_profile_id_profiles_id_fk" FOREIGN KEY ("profile_id") REFERENCES "public"."profiles"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "teams" ADD CONSTRAINT "teams_league_id_leagues_id_fk" FOREIGN KEY ("league_id") REFERENCES "public"."leagues"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "audit_league_idx" ON "audit_logs" USING btree ("league_id");--> statement-breakpoint
CREATE UNIQUE INDEX "auth_tokens_token_uq" ON "auth_tokens" USING btree ("token_hash");--> statement-breakpoint
CREATE INDEX "auth_tokens_profile_idx" ON "auth_tokens" USING btree ("profile_id");--> statement-breakpoint
CREATE INDEX "fixtures_league_idx" ON "fantasy_fixtures" USING btree ("league_id");--> statement-breakpoint
CREATE UNIQUE INDEX "fph_manager_match_uq" ON "fantasy_points_history" USING btree ("profile_id","match_id");--> statement-breakpoint
CREATE INDEX "fph_league_idx" ON "fantasy_points_history" USING btree ("league_id");--> statement-breakpoint
CREATE UNIQUE INDEX "fsp_squad_player_uq" ON "fantasy_squad_players" USING btree ("squad_id","player_id");--> statement-breakpoint
CREATE INDEX "fsp_player_idx" ON "fantasy_squad_players" USING btree ("player_id");--> statement-breakpoint
CREATE UNIQUE INDEX "fantasy_squads_uq" ON "fantasy_squads" USING btree ("league_id","profile_id");--> statement-breakpoint
CREATE INDEX "fantasy_squads_profile_idx" ON "fantasy_squads" USING btree ("profile_id");--> statement-breakpoint
CREATE UNIQUE INDEX "invitations_code_uq" ON "invitations" USING btree ("code");--> statement-breakpoint
CREATE INDEX "invitations_league_idx" ON "invitations" USING btree ("league_id");--> statement-breakpoint
CREATE INDEX "activity_league_idx" ON "league_activity" USING btree ("league_id");--> statement-breakpoint
CREATE UNIQUE INDEX "league_members_uq" ON "league_members" USING btree ("league_id","profile_id");--> statement-breakpoint
CREATE INDEX "league_members_profile_idx" ON "league_members" USING btree ("profile_id");--> statement-breakpoint
CREATE UNIQUE INDEX "standings_league_manager_uq" ON "league_standings" USING btree ("league_id","profile_id");--> statement-breakpoint
CREATE INDEX "standings_league_rank_idx" ON "league_standings" USING btree ("league_id","rank");--> statement-breakpoint
CREATE UNIQUE INDEX "leagues_invite_uq" ON "leagues" USING btree ("invite_code");--> statement-breakpoint
CREATE INDEX "mail_outbox_email_idx" ON "mail_outbox" USING btree ("to_email");--> statement-breakpoint
CREATE UNIQUE INDEX "mp_match_manager_uq" ON "manager_points" USING btree ("match_id","profile_id");--> statement-breakpoint
CREATE INDEX "mp_league_manager_idx" ON "manager_points" USING btree ("league_id","profile_id");--> statement-breakpoint
CREATE INDEX "approvals_match_idx" ON "match_approvals" USING btree ("match_id");--> statement-breakpoint
CREATE INDEX "events_match_idx" ON "match_events" USING btree ("match_id");--> statement-breakpoint
CREATE INDEX "events_player_idx" ON "match_events" USING btree ("player_id");--> statement-breakpoint
CREATE UNIQUE INDEX "lineup_match_player_uq" ON "match_lineups" USING btree ("match_id","player_id");--> statement-breakpoint
CREATE INDEX "lineup_match_team_idx" ON "match_lineups" USING btree ("match_id","team_id");--> statement-breakpoint
CREATE INDEX "subs_match_idx" ON "match_substitutions" USING btree ("match_id");--> statement-breakpoint
CREATE INDEX "mutation_ops_profile_idx" ON "mutation_ops" USING btree ("profile_id");--> statement-breakpoint
CREATE INDEX "notifications_profile_idx" ON "notifications" USING btree ("profile_id");--> statement-breakpoint
CREATE INDEX "notifications_unread_idx" ON "notifications" USING btree ("profile_id","read_at");--> statement-breakpoint
CREATE UNIQUE INDEX "pmp_match_player_uq" ON "player_match_points" USING btree ("match_id","player_id");--> statement-breakpoint
CREATE INDEX "pmp_league_player_idx" ON "player_match_points" USING btree ("league_id","player_id");--> statement-breakpoint
CREATE INDEX "players_league_idx" ON "players" USING btree ("league_id");--> statement-breakpoint
CREATE INDEX "players_team_idx" ON "players" USING btree ("team_id");--> statement-breakpoint
CREATE UNIQUE INDEX "profiles_email_uq" ON "profiles" USING btree ("email_lower");--> statement-breakpoint
CREATE UNIQUE INDEX "profiles_username_uq" ON "profiles" USING btree ("username");--> statement-breakpoint
CREATE INDEX "matches_league_idx" ON "real_matches" USING btree ("league_id");--> statement-breakpoint
CREATE INDEX "matches_status_idx" ON "real_matches" USING btree ("status");--> statement-breakpoint
CREATE UNIQUE INDEX "rules_league_pos_event_uq" ON "scoring_rules" USING btree ("league_id","position","event_type");--> statement-breakpoint
CREATE UNIQUE INDEX "sessions_token_uq" ON "sessions" USING btree ("token_hash");--> statement-breakpoint
CREATE INDEX "sessions_profile_idx" ON "sessions" USING btree ("profile_id");--> statement-breakpoint
CREATE INDEX "sessions_expiry_idx" ON "sessions" USING btree ("expires_at");--> statement-breakpoint
CREATE UNIQUE INDEX "teams_league_name_uq" ON "teams" USING btree ("league_id","name");