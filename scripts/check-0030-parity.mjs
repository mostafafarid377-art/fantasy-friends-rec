/**
 * Checks that migration 0030 still carries the bodies it was built from.
 *
 * Two functions in 0030 are copies of long, stable bodies that already live
 * in earlier migrations: the next-match lineup read and the next-match
 * lineup save. Copying them by hand invites drift, so they are derived here
 * from their original migrations with the smallest possible edit and
 * compared with what the migration actually contains.
 *
 * The lineage of every body matters, so it is spelled out here:
 *
 *   ff_next_match_lineup     0020 wrote it, 0022 and 0024 replaced it, and
 *                            0024 is the body that was live before 0030.
 *   ff_save_next_match_lineup 0022 wrote it, 0028 replaced it, and 0028 is
 *                            the body that was live before 0030.
 *
 * The edits are the two the feature needs: the read stops hiding a
 * scheduled fixture when the manager has no official lineup to inherit, and
 * the write stops refusing a lineup prepared from the manager's own squad.
 *
 * This script never writes. It only reports drift, so a hand edit in the
 * migration can never be overwritten by running it.
 *
 * Run: node scripts/check-0030-parity.mjs
 */
import fs from "node:fs";
import path from "node:path";

const root = path.resolve(process.cwd());
const read = (file) => fs.readFileSync(path.join(root, file), "utf8");
const migration = read("./supabase/migrations/0030_next_match_lineup_availability.sql");
const inPlay = read("./supabase/migrations/0024_in_play_lineup.sql");
const lifecycle = read("./supabase/migrations/0028_lineup_lifecycle.sql");

/** Extracts a `create [or replace] function <name>(...) ... $$;` block. */
function extractFunction(source, name) {
  const start = Math.max(
    source.indexOf(`create or replace function public.${name}(`),
    source.indexOf(`create function public.${name}(`),
  );
  if (start < 0) throw new Error(`function ${name} not found`);
  const end = source.indexOf("$$;", start);
  if (end < 0) throw new Error(`function ${name} has no closing $$;`);
  return source.slice(start, end + "$$;".length);
}

// The read: the early return that hid a scheduled fixture.
const readOld = `  if previous is null then
    return jsonb_build_object('previous',null,'match',null,'saved',null,'inPlay',in_play,'serverNow',t);
  end if;
`;

// The write: the refusal that made a lineup impossible without history.
const saveOld = `  if public.ff_previous_fantasy_lineup(p_league,actor,checked_at) is null then raise exception 'No previous saved starting lineup' using errcode='PT409'; end if;
`;

/** Applies the documented patch to a copied body and returns it. */
const derived = {
  ff_next_match_lineup: () => {
    const body = extractFunction(inPlay, "ff_next_match_lineup");
    if (!body.includes(readOld)) throw new Error("the early return of ff_next_match_lineup not found");
    return body.replace(readOld, "");
  },
  ff_save_next_match_lineup: () => {
    const body = extractFunction(lifecycle, "ff_save_next_match_lineup");
    if (!body.includes(saveOld)) throw new Error("the refusal of ff_save_next_match_lineup not found");
    return body.replace(saveOld, "");
  },
};

let drifted = 0;
for (const [name, build] of Object.entries(derived)) {
  const expected = build();
  const actual = extractFunction(migration, name);
  if (actual !== expected) {
    drifted += 1;
    console.error(`drift: ${name} in migration 0030 differs from the body it was built from`);
  } else {
    console.log(`ok: ${name}`);
  }
}

// The bodies 0030 was built from still have to hold the two rules it
// removed. If they do not, the lineage moved and the check above is
// checking the wrong thing.
if (!extractFunction(inPlay, "ff_next_match_lineup").includes(readOld)) {
  drifted += 1;
  console.error("drift: migration 0024 no longer holds the early return that migration 0030 removes");
}
if (!extractFunction(lifecycle, "ff_save_next_match_lineup").includes(saveOld)) {
  drifted += 1;
  console.error("drift: migration 0028 no longer holds the refusal that migration 0030 removes");
}

// The feature 0030 exists for: a scheduled fixture is reported, and a lineup
// can be prepared, without an official lineup to inherit.
if (/if previous is null then\s+return jsonb_build_object\('previous',null,'match',null/.test(migration)) {
  drifted += 1;
  console.error("drift: migration 0030 hides a scheduled fixture when there is no official lineup");
}
if (migration.includes(saveOld)) {
  drifted += 1;
  console.error("drift: migration 0030 still refuses a lineup prepared without an official lineup");
}

if (drifted > 0) {
  console.error("migration 0030 has drifted from the migrations it was built from");
  process.exit(1);
}
console.log("Migration 0030 matches the bodies it was built from.");
