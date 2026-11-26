-- Man of the Match: one curated record per approved match, chosen by the
-- League Leader or Match Organizer after the game. The card renders entirely
-- from existing data (points/goals/assists from the scoring record, club from
-- the player's team); this table stores only the choice and an optional photo.

CREATE TABLE IF NOT EXISTS "match_motm" (
	"id" text PRIMARY KEY NOT NULL,
	"league_id" text NOT NULL,
	"match_id" text NOT NULL,
	"player_id" text NOT NULL,
	"photo_url" text,
	"chosen_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "match_motm" ADD CONSTRAINT "match_motm_league_id_leagues_id_fk" FOREIGN KEY ("league_id") REFERENCES "public"."leagues"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "match_motm" ADD CONSTRAINT "match_motm_match_id_real_matches_id_fk" FOREIGN KEY ("match_id") REFERENCES "public"."real_matches"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "match_motm" ADD CONSTRAINT "match_motm_player_id_players_id_fk" FOREIGN KEY ("player_id") REFERENCES "public"."players"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "match_motm" ADD CONSTRAINT "match_motm_chosen_by_profiles_id_fk" FOREIGN KEY ("chosen_by") REFERENCES "public"."profiles"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint

-- Exactly one MOTM per match.
CREATE UNIQUE INDEX IF NOT EXISTS "match_motm_match_uq" ON "match_motm" USING btree ("match_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "match_motm_league_idx" ON "match_motm" USING btree ("league_id","created_at");--> statement-breakpoint

ALTER TABLE "match_motm" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint

-- Every league member can read the MOTM; only the leader/organizer write it,
-- and only through the guarded API (no direct client writes).
DROP POLICY IF EXISTS match_motm_select ON "public"."match_motm";--> statement-breakpoint
CREATE POLICY match_motm_select ON "public"."match_motm"
	FOR SELECT TO authenticated
	USING (public.is_member(league_id));--> statement-breakpoint

REVOKE ALL ON TABLE "public"."match_motm" FROM public, anon, authenticated;--> statement-breakpoint
GRANT SELECT ON TABLE "public"."match_motm" TO authenticated;--> statement-breakpoint

-- Private bucket for MOTM photos, same lifecycle as player images.
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('motm-images', 'motm-images', false, 2097152, array['image/jpeg'])
on conflict (id) do nothing;
--> statement-breakpoint
do $$ begin
  if exists (select 1 from storage.buckets where id = 'motm-images' and public) then
    raise exception 'The motm-images bucket must be private';
  end if;
end $$;
--> statement-breakpoint

-- Object keys: <league_id>/<match_id>/<random uuid>.jpg. A member only sees the
-- photo linked on the MOTM row; the leader/organizer can replace it.
drop policy if exists ff_motm_photo_read on storage.objects;--> statement-breakpoint
create policy ff_motm_photo_read on storage.objects for select to authenticated
using (bucket_id = 'motm-images' and exists (
  select 1 from public.match_motm mm
  where mm.league_id = split_part(name, '/', 1) and mm.match_id = split_part(name, '/', 2)
    and public.is_member(mm.league_id) and mm.photo_url = 'motm-images/' || name
));
--> statement-breakpoint
drop policy if exists ff_motm_photo_insert on storage.objects;--> statement-breakpoint
create policy ff_motm_photo_insert on storage.objects for insert to authenticated
with check (bucket_id = 'motm-images'
  and name ~ '^[^/]+/[^/]+/[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}\.jpg$'
  and exists (
    select 1 from public.real_matches m where m.league_id = split_part(name, '/', 1)
      and m.id = split_part(name, '/', 2)
      and (public.is_leader(m.league_id) or public.is_match_organizer(m.id))
  ));
--> statement-breakpoint
drop policy if exists ff_motm_photo_delete on storage.objects;--> statement-breakpoint
create policy ff_motm_photo_delete on storage.objects for delete to authenticated
using (bucket_id = 'motm-images' and exists (
  select 1 from public.match_motm mm join public.real_matches m on m.id = mm.match_id
  where mm.league_id = split_part(name, '/', 1) and mm.match_id = split_part(name, '/', 2)
    and (public.is_leader(mm.league_id) or public.is_match_organizer(mm.match_id))
    and mm.photo_url is distinct from 'motm-images/' || name
));
--> statement-breakpoint
