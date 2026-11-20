// @vitest-environment jsdom
import { afterEach, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { MatchResult } from "@/components/MatchResult";
import { MatchStatistics } from "@/components/MatchStatistics";

afterEach(() => { cleanup(); vi.unstubAllGlobals(); });
const players = [{id:"gk",name:"Keeper",position:"GK"},{id:"def",name:"Defender",position:"DEF"},{id:"mid",name:"Midfielder",position:"MID"}];
it("records statistics without any manual bonus controls or payload", async () => {
  const fetchMock = vi.fn(async (_url: string, _init: RequestInit) => Response.json({matchId:"match",version:2}));
  vi.stubGlobal("fetch", fetchMock);
  const onSaved = vi.fn(async () => {});
  render(<MatchStatistics matchId="match" version={1} started status="draft" correctable={false} canManage players={players}
    saved={[]} workflowBusy={false} onDirty={vi.fn()} onSaved={onSaved} />);
  fireEvent.click(screen.getByText("Match statistics"));
  fireEvent.change(screen.getByRole("textbox", {name:"Keeper saves"}), {target:{value:"6"}});
  expect(screen.queryByRole("combobox")).toBeNull();
  expect(screen.queryByRole("region", { name: "Match Bonus Points" })).toBeNull();
  fireEvent.click(screen.getByRole("button", {name:"Save statistics"}));
  await waitFor(() => expect(onSaved).toHaveBeenCalledOnce());
  expect(fetchMock.mock.calls[0][0]).toBe("/api/matches/match/statistics");
  expect(JSON.parse(String(fetchMock.mock.calls[0][1].body))).toEqual({ version:1, stats:[{playerId:"gk",saves:6,defensiveContributions:0}] });
});

it("renders reported tied awards and skipped ranks without offering selections", () => {
  render(<MatchStatistics matchId="match" version={3} started status="approved" correctable canManage players={players}
    saved={[]} bonusAwards={[{playerId:"gk",rank:1,points:3},{playerId:"def",rank:1,points:3},{playerId:"mid",rank:3,points:1}]}
    workflowBusy={false} onDirty={vi.fn()} onSaved={async () => {}} />);
  const section = within(screen.getByRole("region",{name:"Match Bonus Points"}));
  expect(section.getAllByText(/Rank 1/)).toHaveLength(2);
  expect(section.queryByText(/Rank 2/)).toBeNull();
  expect(section.getByText(/Rank 3 · Midfielder/)).toBeTruthy();
  expect(section.getAllByRole("listitem").map((item) => item.textContent)).toEqual([
    "Rank 1 · Keeper+3 pts", "Rank 1 · Defender+3 pts", "Rank 3 · Midfielder+1 pts",
  ]);
  expect(section.queryByRole("combobox")).toBeNull();
});

it.each(["draft", "pending", "rejected"])("does not show any bonus notice while the match is %s", (status) => {
  render(<>
    <MatchStatistics matchId="match" version={1} started status={status} correctable={false} canManage players={players}
      saved={[]} workflowBusy={false} onDirty={vi.fn()} onSaved={async () => {}} />
    <MatchResult match={{ status, homeScore: null, awayScore: null }} home="Home" away="Away"
      canManage busy={false} onSave={async () => false} />
  </>);
  expect(screen.queryByRole("region", { name: "Match Bonus Points" })).toBeNull();
  expect(screen.queryByText(/(?:bonus points|bonuses) are calculated|tied players share/i)).toBeNull();
});
