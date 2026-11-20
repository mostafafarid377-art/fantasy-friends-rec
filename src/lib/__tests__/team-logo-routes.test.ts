import { beforeEach, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import sharp from "sharp";
import { DELETE, GET, POST } from "@/app/api/leagues/[id]/teams/[teamId]/logo/route";
import { TEAM_LOGO_LIMIT } from "@/lib/team-logo";

const db = vi.hoisted(() => ({ from:vi.fn(), user:vi.fn(), storage:vi.fn(), upload:vi.fn(), remove:vi.fn(), download:vi.fn() }));
vi.mock("@/db", () => ({ getSupabase: async () => ({ from:db.from, auth:{getUser:db.user}, storage:{from:db.storage} }) }));
const ctx = {params:Promise.resolve({id:"league",teamId:"reds"})};
const route = "http://local.test/api/leagues/league/teams/reds/logo";
let role: string, team: {id:string;league_id:string;name:string;crest_url:string | null};
beforeEach(() => {
  vi.resetAllMocks(); role = "leader";
  team = {id:"reds",league_id:"league",name:"Reds",crest_url:null};
  db.user.mockResolvedValue({data:{user:{id:"leader"}},error:null});
  db.from.mockImplementation((table) => ({
    select() {return this;}, eq() {return this;}, is() {return this;},
    update(input: {crest_url:string | null}) { team = {...team,...input}; return this; },
    maybeSingle() {return {data:table === "teams" ? team : {role,leagues:{id:"league"}},error:null};},
  }));
  db.storage.mockReturnValue({upload:db.upload,remove:db.remove,download:db.download});
  db.upload.mockImplementation(async (path:string) => ({data:{path},error:null}));
  db.remove.mockResolvedValue({error:null});
});
const post = (type:string,data:Buffer | Uint8Array) => POST(new NextRequest(route, {method:"POST",headers:{"content-type":type},body:new Uint8Array(data)}),ctx);
it("re-encodes a valid upload, persists a versioned logo, replaces it, and removes it", async () => {
  const png = await sharp({create:{width:400,height:100,channels:4,background:"#00ff0088"}}).png().toBuffer();
  const added = await post("image/png",png);
  expect(added.status).toBe(200);
  const old = team.crest_url!;
  const key = old.replace(/^team-logos\//, "");
  const dto = (await added.json()).team;
  expect(dto.crestUrl).toContain("/teams/reds/logo?v=");
  const uploaded = db.upload.mock.calls[0][1] as Buffer;
  expect(await sharp(uploaded).metadata()).toMatchObject({format:"webp",width:256,height:64,hasAlpha:true});
  db.download.mockResolvedValue({data:new Blob([new Uint8Array(uploaded)],{type:"image/webp"}),error:null});
  const served = await GET(new NextRequest(`http://local.test${dto.crestUrl}`),ctx);
  expect(served.status).toBe(200);
  expect(served.headers.get("Cache-Control")).toBe("private, no-store");
  const replaced = await post("image/png",png);
  expect(replaced.status).toBe(200);
  expect(team.crest_url).not.toBe(old);
  expect(db.remove).toHaveBeenCalledWith([key]);
  expect((await GET(new NextRequest(`http://local.test${dto.crestUrl}`),ctx)).status).toBe(404);
  const removed = await DELETE(new NextRequest(route,{method:"DELETE"}),ctx);
  expect((await removed.json()).team.crestUrl).toBeNull();
  expect(team.crest_url).toBeNull();
});
it("rejects wrong media, bogus bytes, oversized bodies and non-leader writes", async () => {
  expect((await post("image/svg+xml",Buffer.from("<svg/>"))).status).toBe(422);
  expect((await post("image/png",Buffer.from("not an image"))).status).toBe(422);
  expect((await post("image/png",new Uint8Array(TEAM_LOGO_LIMIT+1))).status).toBe(413);
  role = "manager";
  expect((await post("image/png",Buffer.from("no"))).status).toBe(403);
  expect((await DELETE(new NextRequest(route,{method:"DELETE"}),ctx)).status).toBe(403);
  expect(db.upload).not.toHaveBeenCalled();
});
