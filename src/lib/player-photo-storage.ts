import type { SupabaseClient } from "@/db";
import { PLAYER_PHOTO_BUCKET } from "@/lib/player-photo";
import { MOTM_PHOTO_BUCKET } from "@/lib/motm-photo";

/** Storage and Postgres are separate services. Cleanup happens only after the
 * new link/removal is confirmed, and a Storage policy protects linked objects. */
export async function removeUnlinkedPlayerPhoto(sb: SupabaseClient, key: string | null) {
  if (!key) return;
  try {
    const { error } = await sb.storage.from(PLAYER_PHOTO_BUCKET).remove([key]);
    if (error) console.warn("[player photo] unlinked object cleanup failed", error.message);
  } catch (error) {
    console.warn("[player photo] unlinked object cleanup failed", error);
  }
}

/** Same lifecycle as player photos, in the MOTM bucket. */
export async function removeUnlinkedMotmPhoto(sb: SupabaseClient, key: string | null) {
  if (!key) return;
  try {
    const { error } = await sb.storage.from(MOTM_PHOTO_BUCKET).remove([key]);
    if (error) console.warn("[motm photo] unlinked object cleanup failed", error.message);
  } catch (error) {
    console.warn("[motm photo] unlinked object cleanup failed", error);
  }
}
