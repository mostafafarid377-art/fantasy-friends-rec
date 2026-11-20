import { beforeEach, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import { PUT } from "@/app/api/matches/[id]/statistics/route";
const db = vi.hoisted(() => ({from:vi.fn(),getUser:vi.fn(),rpc:vi.fn()}));
vi.mock("@/db", () => ({getSupabase:async () => ({...db,auth:{getUser:db.getUser}})}));
let role: string;
beforeEach(() => {
  vi.resetAllMocks(); role="organizer";
  db.getUser.mockResolvedValue({data:{user:{id:"user"}},error:null});
  db.from.mockImplementation((table:string) => ({
    select(){return this;}, eq(){return this;}, maybeSingle(){return {data: table === "real_matches" ? {id:"match",league_id:"league",organizer_id:"user"} : {role,leagues:{id:"league"}},error:null};},
  }));
});
const put = (body: unknown) => PUT(new NextRequest("http://local.test/api/matches/match/statistics",{method:"PUT",body:JSON.stringify(body)}),{params:Promise.resolve({id:"match"})});
it("rejects unauthorized callers and manual bonus payloads; confirms only the new database revision", async () => {
  const input={version:4,stats:[{playerId:"one",saves:3,defensiveContributions:0}]};
  role="manager";
  expect((await put(input)).status).toBe(403);
  role="organizer";
  expect((await put({...input,bonus:["one","one","three"]})).status).toBe(422);
  expect(db.rpc).not.toHaveBeenCalled();
  db.rpc.mockResolvedValueOnce({data:{matchId:"match",version:4},error:null});
  expect((await put(input)).status).toBe(409);
  db.rpc.mockResolvedValueOnce({data:{matchId:"match",version:5},error:null});
  expect((await put(input)).status).toBe(200);
  expect(db.rpc).toHaveBeenLastCalledWith("save_match_statistics",{p_match:"match",p_version:4,p_stats:input.stats,p_reason:null});
});
