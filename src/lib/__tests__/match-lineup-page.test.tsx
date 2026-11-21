// @vitest-environment jsdom
import { afterEach, expect, it, vi } from "vitest";
import { act, cleanup, render, screen, within, fireEvent } from "@testing-library/react";
import MatchPage from "@/app/(app)/matches/[id]/page";

vi.mock("@/components/LeagueContext", () => ({ useActiveLeague: () => ({ league: { id: "league", name: "League" } }) }));
vi.mock("@/components/AppShell", () => ({ PageHeader: ({ title, eyebrow }: { title: React.ReactNode; eyebrow?: string }) => <><p>{eyebrow}</p><h1>{title}</h1></> }));
const params = Promise.resolve({ id: "m" });
const players = ["GK","DEF","MID","MID","FWD","DEF"].map((position,i)=>({ id:`p${i}`, fullName:`Player ${i}`, position, teamId:"home", photoUrl:null, status:"active", availability:"available" }));
const teams = [{ id:"home",name:"Home",crestUrl:"/home.webp" },{ id:"away",name:"Away",crestUrl:"/away.webp" }];
afterEach(() => { cleanup(); vi.useRealTimers(); vi.unstubAllGlobals(); });

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
    return Response.json({serverNow:"2026-11-19T19:00:00Z",match:{id:"m",leagueId:"league",title:"Game",status:"draft",kickOff:"2026-11-19T18:00:00Z",teamAId:"home",teamBId:"away",version:1},
      rules:{format:"5v5",starters:5,subsCount:2,squadSize:10},canOrganize:true,teams,roster:players,
      lineups:saved,events:[],substitutions:[],approvals:[]});
  });
  vi.stubGlobal("fetch",fetch);
  const page = render(<MatchPage params={params}/>);
  const firstRow = await screen.findByText("Player 0");
  expect(screen.queryByText("Lineup Locked.")).toBeNull();
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

it("records a 2–0 result, approves it, and reopens the corrected score and history after refresh", async () => {
  let match = { id:"m", leagueId:"league", title:"League match", status:"draft", homeScore:null as number | null, awayScore:null as number | null,
    kickOff:"2026-11-19T18:00:00Z", teamAId:"home", teamBId:"away", version:1 };
  const writes: object[] = [];
  const approvals: object[] = [];
  const fetch = vi.fn(async (url: string, init: RequestInit) => {
    if (url.endsWith("/flow")) {
      const input = JSON.parse(String(init.body));
      writes.push(input);
      expect(input.version).toBe(match.version);
      if (input.action === "correct") approvals.push({ id:"correction", action:"corrected", reason:input.reason, version:match.version+1,
        createdAt:"2026-11-19T19:00:00Z", scoreChange:{ homeScore:input.homeScore, awayScore:input.awayScore,
          previousHomeScore:match.homeScore, previousAwayScore:match.awayScore } });
      match = { ...match, version:match.version+1, status: input.action === "submit" ? "pending" : "approved",
        homeScore:input.homeScore ?? match.homeScore, awayScore:input.awayScore ?? match.awayScore };
      return Response.json({ status:match.status, match:{ id:match.id, home_score:match.homeScore, away_score:match.awayScore, version:match.version } });
    }
    if (!url.endsWith("/m")) throw new Error(`Unexpected ${url}`);
    return Response.json({match, serverNow:"2026-11-19T19:00:00Z", rules:{format:"5v5",starters:5,subsCount:2,squadSize:10}, canOrganize:true, canApprove:true,
      canEditEvents:match.status === "draft", teams, roster:players, lineups:[], events:[], substitutions:[], approvals });
  });
  vi.stubGlobal("fetch",fetch);
  const page = render(<MatchPage params={params}/>);
  const home = await screen.findByLabelText(/^Home score/);
  const away = screen.getByLabelText(/^Away score/);
  const submit = screen.getByRole("button", { name:"Submit for review" }) as HTMLButtonElement;
  expect(submit.disabled).toBe(true);
  fireEvent.change(home,{ target:{ value:"2" } });
  expect(submit.disabled).toBe(true);
  fireEvent.change(away,{ target:{ value:"0" } });
  fireEvent.click(screen.getByRole("button", { name:/^Events/ }));
  expect(screen.queryByRole("option", { name:/clean sheet/i })).toBeNull();
  expect(screen.getByRole("option", { name:"Goal" })).toBeTruthy();
  fireEvent.click(submit);
  expect(await screen.findByText("2–0")).toBeTruthy();
  for (const area of [screen.getByRole("heading", {level:1}), screen.getByRole("region", {name:"Match result"})]) {
    expect(Array.from(area.querySelectorAll("img")).map((img) => img.getAttribute("src"))).toEqual(["/home.webp","/away.webp"]);
  }
  const approve = await screen.findByRole("button", { name:"Approve" });
  fireEvent.click(approve);
  fireEvent.click(await screen.findByRole("button", { name:"Correct score" }));
  fireEvent.change(screen.getByLabelText(/^Away score/), { target:{ value:"1" } });
  const correct = screen.getByRole("button", { name:"Save score correction" }) as HTMLButtonElement;
  expect(correct.disabled).toBe(true);
  fireEvent.change(screen.getByLabelText("Correction reason"), { target:{ value:"Confirmed by referee" } });
  fireEvent.click(correct);
  expect(await screen.findByText("2–1")).toBeTruthy();
  expect(writes).toEqual([{ action:"submit", version:1, homeScore:2, awayScore:0 },
    { action:"approve", version:2 }, { action:"correct", version:3, homeScore:2, awayScore:1, reason:"Confirmed by referee" }]);
  page.unmount();
  render(<MatchPage params={params}/>);
  expect(await screen.findByText("2–1")).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name:/^History/ }));
  expect(screen.getByText("2–0 corrected to 2–1")).toBeTruthy();
});

it("records saves and contributions in the event picker, preserving other saved totals", async () => {
  let version = 1;
  let statistics = [{playerId:"p0",saves:0,defensiveContributions:2,position:"GK"}, {playerId:"p1",saves:0,defensiveContributions:10,position:"DEF"}];
  const fetch = vi.fn(async (url: string, init: RequestInit) => {
    if (url.endsWith("/statistics")) {
      expect(init.method).toBe("PUT");
      const body = JSON.parse(String(init.body));
      expect(body).toEqual({version, stats: version === 1 ? [{playerId:"p1",saves:0,defensiveContributions:10}, {playerId:"p0",saves:6,defensiveContributions:2}]
        : [{playerId:"p0",saves:6,defensiveContributions:2}, {playerId:"p1",saves:0,defensiveContributions:12}]});
      statistics = body.stats.map((stat: {playerId: string}) => ({...stat,position:stat.playerId === "p0" ? "GK" : "DEF"}));
      return Response.json({matchId:"m",version:++version});
    }
    if (!url.endsWith("/m")) throw new Error(`Unexpected ${url}`);
    return Response.json({serverNow:"2026-11-19T19:00:00Z",
      match:{id:"m",leagueId:"league",title:"Game",status:"draft",kickOff:"2026-11-19T18:00:00Z",teamAId:"home",teamBId:"away",version},
      rules:{format:"5v5",starters:5,subsCount:2,squadSize:10},canOrganize:true,canEditEvents:true,teams,roster:players,statistics,
      lineups:players.slice(0,3).map((player,order) => ({id:`line-${order}`,teamId:"home",playerId:player.id,player,slot:order === 2 ? "sub" : "starter",order})),events:[],substitutions:[],approvals:[]});
  });
  vi.stubGlobal("fetch",fetch);
  render(<MatchPage params={params}/>);
  fireEvent.click(await screen.findByRole("button", {name:/^Events/}));
  const choose = (label: string, value: string) => fireEvent.change(screen.getByLabelText(label, {exact:true}), {target:{value}});
  choose("Player", "p0");
  expect(screen.queryByRole("textbox", {name:/Number of/})).toBeNull();
  choose("Event", "saves");
  expect(screen.queryByRole("option", {name:/DEF · Player 1/})).toBeNull();
  fireEvent.change(screen.getByRole("textbox", {name:"Number of saves"}), {target:{value:"6"}});
  const save = screen.getByRole("button", {name:"Save statistics"});
  fireEvent.click(save);
  fireEvent.click(save);
  await screen.findByText(/v2$/);
  expect((screen.getByRole("textbox", {name:"Number of saves"}) as HTMLInputElement).value).toBe("6");
  expect(screen.queryByRole("button", {name:"Save statistics"})).toBeNull();
  choose("Event", "defensiveContributions");
  expect(screen.queryByRole("option", {name:/MID · Player 2/})).toBeNull();
  choose("Player", "p1");
  expect((screen.getByRole("textbox", {name:"Number of defensive contributions"}) as HTMLInputElement).value).toBe("10");
  fireEvent.change(screen.getByRole("textbox", {name:"Number of defensive contributions"}), {target:{value:"12"}});
  fireEvent.click(screen.getByRole("button", {name:"Save statistics"}));
  await screen.findByText(/v3$/);
  expect(fetch.mock.calls.filter(([url]) => url.endsWith("/statistics"))).toHaveLength(2);
  expect(screen.getAllByText("Match statistics", {exact:true})).toHaveLength(1);
  expect(screen.getAllByRole("region", {name:"Match result"})).toHaveLength(1);
  expect(screen.queryByText("Match statistics saved")).toBeNull();
});

it("records a match event without entering a minute, while keeping the substitution minute", async () => {
  const fetch = vi.fn(async (url: string, init: RequestInit) => {
    if (url.endsWith("/events")) {
      expect(JSON.parse(String(init.body))).toEqual({teamId:"home",playerId:"p0",assistPlayerId:null,eventType:"goal",note:null});
      return Response.json({event:{id:"event"}});
    }
    if (!url.endsWith("/m")) throw new Error(`Unexpected ${url}`);
    return Response.json({serverNow:"2026-11-19T19:00:00Z",
      match:{id:"m",leagueId:"league",title:"Game",status:"draft",kickOff:"2026-11-19T18:00:00Z",teamAId:"home",teamBId:"away",version:1},
      rules:{format:"5v5",starters:5,subsCount:2,squadSize:10},canOrganize:true,canEditEvents:true,teams,roster:players,
      lineups:[{id:"line-0",teamId:"home",playerId:"p0",player:players[0],slot:"starter",order:0}],events:[],substitutions:[],approvals:[]});
  });
  vi.stubGlobal("fetch",fetch);
  render(<MatchPage params={params}/>);
  fireEvent.click(await screen.findByRole("button", {name:/^Events/}));
  expect(screen.getAllByRole("spinbutton")).toHaveLength(1);
  fireEvent.change(screen.getByLabelText("Player", {exact:true}), {target:{value:"p0"}});
  fireEvent.click(screen.getByRole("button", {name:"Add event"}));
  expect(await screen.findByText("Event recorded")).toBeTruthy();
  expect(fetch.mock.calls.filter(([url]) => url.endsWith("/events"))).toHaveLength(1);
});

it("corrects approved statistics from Events using the official participants and a reason", async () => {
  let version = 4;
  const fetch = vi.fn(async (url: string, init: RequestInit) => {
    if (url.endsWith("/statistics")) {
      expect(JSON.parse(String(init.body))).toEqual({version:4, stats:[], reason:"Confirmed with referee"});
      return Response.json({matchId:"m",version:++version});
    }
    if (!url.endsWith("/m")) throw new Error(`Unexpected ${url}`);
    return Response.json({serverNow:"2026-11-19T19:00:00Z",
      match:{id:"m",leagueId:"league",title:"Game",status:"approved",homeScore:1,awayScore:0,kickOff:"2026-11-19T18:00:00Z",teamAId:"home",teamBId:"away",version},
      rules:{format:"5v5",starters:5,subsCount:2,squadSize:10},canOrganize:true,canEditEvents:false,teams,roster:players,
      statistics:version === 4 ? [{playerId:"p0",saves:3,defensiveContributions:0,position:"GK"}] : [],
      lineups:[],scoringLineups:[{teamId:"home",playerId:"p0",player:players[0],slot:"starter"}],events:[],substitutions:[],approvals:[]});
  });
  vi.stubGlobal("fetch",fetch);
  render(<MatchPage params={params}/>);
  fireEvent.click(await screen.findByRole("button", {name:/^Events/}));
  expect(screen.queryByRole("option",{name:"Goal"})).toBeNull();
  fireEvent.change(screen.getByLabelText("Player",{exact:true}),{target:{value:"p0"}});
  const saves = screen.getByLabelText("Number of saves") as HTMLInputElement;
  expect(saves.value).toBe("3");
  fireEvent.change(saves,{target:{value:"0"}});
  const save = screen.getByRole("button",{name:"Save statistics correction"}) as HTMLButtonElement;
  expect(save.disabled).toBe(true);
  fireEvent.change(screen.getByLabelText("Statistics correction reason"),{target:{value:"Confirmed with referee"}});
  fireEvent.click(save);
  await screen.findByText(/v5$/);
  expect(saves.value).toBe("0");
  expect(fetch.mock.calls.filter(([url]) => url.endsWith("/statistics"))).toHaveLength(1);
});


it("disables approval before kickoff, keeps rejection available and enables approval at kickoff", async () => {
  vi.useFakeTimers({ toFake: ["setInterval", "clearInterval", "performance"] });
  const fetch = vi.fn(async (url: string, init: RequestInit) => {
    if (url.endsWith("/flow")) {
      expect(JSON.parse(String(init.body))).toEqual({ action: "approve", version: 2 });
      return Response.json({ status: "approved", match: { id: "m", version: 3 } });
    }
    return Response.json({ serverNow: "2026-11-19T17:59:59Z",
      match: { id: "m", leagueId: "league", title: "Game", status: "pending", kickOff: "2026-11-19T18:00:00Z", teamAId: "home", teamBId: "away", version: 2, homeScore: 2, awayScore: 0 },
      rules: { format: "5v5", starters: 5, subsCount: 2, squadSize: 10 }, canApprove: true,
      teams, roster: players, lineups: [], events: [], substitutions: [], approvals: [] });
  });
  vi.stubGlobal("fetch", fetch);
  render(<MatchPage params={params} />);
  const approve = await screen.findByRole<HTMLButtonElement>("button", { name: "Approve" });
  expect(approve.disabled).toBe(true);
  expect(screen.getByText(/once its scheduled kickoff time has been reached/)).toBeTruthy();
  expect(screen.getByRole<HTMLButtonElement>("button", { name: "Reject" }).disabled).toBe(false);
  fireEvent.click(approve);
  expect(fetch.mock.calls.filter(([url]) => url.endsWith("/flow"))).toHaveLength(0);
  act(() => vi.advanceTimersByTime(1000));
  expect(approve.disabled).toBe(false);
  fireEvent.click(approve);
  expect(await screen.findByText("Approved — points calculated")).toBeTruthy();
  expect(fetch.mock.calls.filter(([url]) => url.endsWith("/flow"))).toHaveLength(1);
});
