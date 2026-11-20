// @vitest-environment jsdom
import { afterEach, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MatchStatistics } from "@/components/MatchStatistics";

afterEach(() => { cleanup(); vi.unstubAllGlobals(); });
const players = [{id:"gk",name:"Keeper",position:"GK"},{id:"def",name:"Defender",position:"DEF"},{id:"mid",name:"Midfielder",position:"MID"}];
it("records only participant selections in rank order and does not send points", async () => {
  const fetchMock = vi.fn(async (_url: string, _init: RequestInit) => Response.json({matchId:"match",version:2}));
  vi.stubGlobal("fetch", fetchMock);
  const onSaved = vi.fn(async () => {});
  render(<MatchStatistics matchId="match" version={1} started status="draft" correctable={false} canManage players={players}
    saved={[]} workflowBusy={false} onDirty={vi.fn()} onSaved={onSaved} />);
  fireEvent.click(screen.getByText("Match statistics"));
  fireEvent.change(screen.getByRole("textbox", {name:"Keeper saves"}), {target:{value:"6"}});
  const choose = (rank: RegExp, id: string) => fireEvent.change(screen.getByRole("combobox", {name:rank}), {target:{value:id}});
  choose(/^1st/, "gk");
  expect((screen.getByRole("button", {name:"Save statistics & bonuses"}) as HTMLButtonElement).disabled).toBe(true);
  choose(/^2nd/, "def"); choose(/^3rd/, "mid");
  fireEvent.click(screen.getByRole("button", {name:"Save statistics & bonuses"}));
  await waitFor(() => expect(onSaved).toHaveBeenCalledOnce());
  expect(fetchMock.mock.calls[0][0]).toBe("/api/matches/match/statistics");
  expect(JSON.parse(String(fetchMock.mock.calls[0][1].body))).toEqual({ version:1, bonus:["gk","def","mid"], stats:[{playerId:"gk",saves:6,defensiveContributions:0}] });
});
