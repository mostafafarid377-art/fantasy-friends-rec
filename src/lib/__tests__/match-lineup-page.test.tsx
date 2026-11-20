// @vitest-environment jsdom
import { afterEach, expect, it, vi } from "vitest";
import { cleanup, render, screen, within, fireEvent } from "@testing-library/react";
import MatchPage from "@/app/(app)/matches/[id]/page";

vi.mock("@/components/LeagueContext", () => ({ useActiveLeague: () => ({ league: { id: "league", name: "League" } }) }));
vi.mock("@/components/AppShell", () => ({ PageHeader: ({ title }: { title: string }) => <h1>{title}</h1> }));
const params = Promise.resolve({ id: "m" });
const players = ["GK","DEF","MID","MID","FWD","DEF"].map((position,i)=>({ id:`p${i}`, fullName:`Player ${i}`, position, teamId:"home", photoUrl:null, status:"active", availability:"available" }));
const teams = [{ id:"home",name:"Home" },{ id:"away",name:"Away" }];
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

it("submits ordered entries, does not show success on DB failure, and uses persisted rows on reopen", async () => {
  let fail = true;
  let saved: { id: string; teamId: string; playerId: string; slot: string; order: number }[] = [];
  const fetch = vi.fn(async (url: string, init: RequestInit) => {
    if (url.endsWith("/lineup")) {
      const body = JSON.parse(String(init.body));
      expect(body).toEqual({ teamId:"home", starters: players.slice(0,5).map((p,order)=>({playerId:p.id,order})), subs:[{playerId:"p5",order:0}] });
      if (fail) return Response.json({error:"Could not save lineup: permission denied"},{status:403});
      saved = [...body.starters.map((e: object)=>({...e,slot:"starter"})), ...body.subs.map((e: object)=>({...e,slot:"sub"}))]
        .map((e,i)=>({ ...e,id:`line-${i}`,teamId:"home" }));
      return Response.json({lineups:saved});
    }
    if (!url.endsWith("/m")) throw new Error(`Unexpected ${url}`);
    return Response.json({match:{id:"m",leagueId:"league",title:"Game",status:"draft",kickOff:"2026-11-19T18:00:00Z",teamAId:"home",teamBId:"away",version:1},
      rules:{format:"5v5",starters:5,subsCount:2,squadSize:10},canOrganize:true,teams,roster:players,
      lineups:saved,events:[],substitutions:[],approvals:[]});
  });
  vi.stubGlobal("fetch",fetch);
  const page = render(<MatchPage params={params}/>);
  const firstRow = await screen.findByText("Player 0");
  expect(firstRow.closest("li")).not.toBeNull();
  const save = () => screen.getAllByRole("button", { name:"Save line-up" })[0] as HTMLButtonElement;
  expect(save().disabled).toBe(true);
  for (const [index,p] of players.entries()) fireEvent.click(within(screen.getByText(p.fullName).closest("li")!).getByRole("button",{name:index<5?"XI":"Sub"}));
  expect(save().disabled).toBe(false);
  fireEvent.click(save());
  expect(await screen.findByText("Line-up not saved")).toBeTruthy();
  expect(screen.queryByText("Line-up saved")).toBeNull();
  expect(saved).toHaveLength(0);
  fail = false;
  fireEvent.click(save());
  expect(await screen.findByText("Line-up saved")).toBeTruthy();
  expect(fetch.mock.calls.filter(([url])=>url.endsWith("/m"))).toHaveLength(2);
  page.unmount(); render(<MatchPage params={params}/>);
  const last = await screen.findByText("Player 5");
  expect(within(last.closest("li")!).getByRole("button",{name:"Sub"}).getAttribute("aria-pressed")).toBe("true");
  expect(within(screen.getByText("Player 0").closest("li")!).getByRole("button",{name:"XI"}).getAttribute("aria-pressed")).toBe("true");
});
