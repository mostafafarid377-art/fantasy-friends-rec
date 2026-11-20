import sharp from "sharp";
import { beforeEach, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import { GET, POST, DELETE } from "@/app/api/leagues/[id]/players/[playerId]/photo/route";
import { PATCH } from "@/app/api/leagues/[id]/players/[playerId]/route";
import { PLAYER_PHOTO_BUCKET, playerPhotoUrl } from "@/lib/player-photo";

const db = vi.hoisted(() => ({ from: vi.fn(), user: vi.fn(), upload: vi.fn(), download: vi.fn(), remove: vi.fn(), bucket: vi.fn() }));
vi.mock("@/db", () => ({ getSupabase: async () => ({
  from: db.from, auth: { getUser: db.user }, storage: { from: db.bucket },
}) }));
const ctx = { params: Promise.resolve({ id: "league-a", playerId: "p1" }) };
const url = "http://local.test/api/leagues/league-a/players/p1/photo";
const oldKey = "league-a/p1/00000000-0000-4000-a000-000000000001.jpg";
const oldPath = `${PLAYER_PHOTO_BUCKET}/${oldKey}`;
const initial = { id: "p1", league_id: "league-a", full_name: "Keeper", created_by: "leader", photo_url: oldPath };
let row: typeof initial | null, role: string, rejectUpdate: boolean;
const filters = vi.fn(), writes = vi.fn();
const image = await sharp({ create: { width: 800, height: 600, channels: 3, background: "green" } }).withMetadata({ orientation: 6 }).jpeg().toBuffer();
const request = (method = "POST", bytes = image) => {
  const body = new FormData();
  body.append("photo", new Blob([new Uint8Array(bytes)], { type: "image/jpeg" }), "camera.jpg");
  return new NextRequest(url, { method, body });
};

beforeEach(() => {
  vi.resetAllMocks();
  row = { ...initial }; role = "leader"; rejectUpdate = false;
  db.user.mockResolvedValue({ data: { user: { id: "leader" } }, error: null });
  db.bucket.mockReturnValue({ upload: db.upload, download: db.download, remove: db.remove });
  db.upload.mockImplementation(async (path: string) => ({ data: { path }, error: null }));
  db.download.mockResolvedValue({ data: new Blob([new Uint8Array(image)], { type: "image/jpeg" }), error: null });
  db.remove.mockResolvedValue({ data: [], error: null });
  db.from.mockImplementation((table: string) => {
    let patch: Record<string, unknown> | undefined;
    return {
      select() { return this; }, eq(...a: unknown[]) { filters(table, ...a); return this; }, is(...a: unknown[]) { filters(table, ...a); return this; },
      update(changes: Record<string, unknown>) { patch = changes; writes(changes); return this; },
      maybeSingle() {
        if (table === "league_members") return { data: { role, leagues: { id: "league-a" } }, error: null };
        if (patch && rejectUpdate) return { data: null, error: null };
        if (patch && row) row = { ...row, ...patch };
        return { data: row, error: null };
      },
    };
  });
});

it("re-encodes and uploads a private, scoped thumbnail before saving a versioned player link", async () => {
  const res = await POST(request(), ctx);
  expect(res.status).toBe(200);
  const [key, jpeg, options] = db.upload.mock.calls[0];
  expect(key).toMatch(/^league-a\/p1\/[a-f0-9-]+\.jpg$/);
  expect(options).toMatchObject({ upsert: false, contentType: "image/jpeg" });
  const meta = await sharp(jpeg).metadata();
  expect(meta).toMatchObject({ width: 384, height: 384, format: "jpeg" });
  expect(meta.exif).toBeUndefined();
  expect((await res.json()).player.photoUrl).toBe(playerPhotoUrl(`${PLAYER_PHOTO_BUCKET}/${key}`, "league-a", "p1"));
  expect(filters).toHaveBeenCalledWith("players", "photo_url", oldPath);
  expect(db.remove).toHaveBeenCalledWith([oldKey]);
  expect(db.upload.mock.invocationCallOrder[0]).toBeLessThan(writes.mock.invocationCallOrder[0]);
  expect(writes.mock.invocationCallOrder[0]).toBeLessThan(db.remove.mock.invocationCallOrder[0]);
});

it("blocks wrong roles, creators, league scopes and invalid image bytes before upload", async () => {
  role = "organizer";
  expect((await POST(request(), ctx)).status).toBe(403);
  role = "leader"; row = { ...initial, created_by: "someone-else" };
  expect((await POST(request(), ctx)).status).toBe(403);
  row = { ...initial, league_id: "other" };
  expect((await POST(request(), ctx)).status).toBe(404);
  row = initial;
  expect((await POST(request("POST", Buffer.from("not an image")), ctx)).status).toBe(422);
  expect(db.upload).not.toHaveBeenCalled();
  expect(writes).not.toHaveBeenCalled();
});

it("leaves the old photo intact when upload or linkage cannot be confirmed", async () => {
  db.upload.mockResolvedValueOnce({ data: null, error: new Error("offline") });
  expect((await POST(request(), ctx)).status).toBe(502);
  expect(writes).not.toHaveBeenCalled();
  rejectUpdate = true;
  expect((await POST(request(), ctx)).status).toBe(409);
  expect(row?.photo_url).toBe(oldPath);
  expect(db.remove).not.toHaveBeenCalled();
});

it("serves only the current photo and detaches it before cleanup", async () => {
  const photoUrl = playerPhotoUrl(oldPath, "league-a", "p1");
  const photo = () => GET(new NextRequest(`http://local.test${photoUrl}`), ctx);
  expect((await GET(new NextRequest(`${url}?v=other`), ctx)).status).toBe(404);
  expect(db.download).not.toHaveBeenCalled();
  const read = await photo();
  expect(read.status).toBe(200);
  expect(read.headers.get("cache-control")).toBe("private, no-store");
  expect(db.download).toHaveBeenCalledWith(oldKey);
  const removed = await DELETE(new NextRequest(url, { method: "DELETE" }), ctx);
  expect((await removed.json()).player.photoUrl).toBeNull();
  expect(writes.mock.invocationCallOrder[0]).toBeLessThan(db.remove.mock.invocationCallOrder[0]);
  expect((await photo()).status).toBe(404);
});

it("preserves a managed photo on the regular player edit route and rejects internal paths there", async () => {
  const body = (payload: object) => new NextRequest(url.slice(0, -6), { method: "PATCH", body: JSON.stringify(payload) });
  const saved = await PATCH(body({ fullName: "New name" }), ctx);
  expect(await saved.json()).toMatchObject({ player: { fullName: "New name", photoUrl: playerPhotoUrl(oldPath, "league-a", "p1") } });
  expect(writes.mock.calls[0][0]).not.toHaveProperty("photo_url");
  expect((await PATCH(body({ photoUrl: oldPath }), ctx)).status).toBe(422);
  expect((await PATCH(body({ photoUrl: "https://example.com/image.jpg" }), ctx)).status).toBe(200);
  expect(db.remove).toHaveBeenCalledWith([oldKey]);
});
