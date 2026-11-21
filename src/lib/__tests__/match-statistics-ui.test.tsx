// @vitest-environment jsdom
import { afterEach, expect, it } from "vitest";
import { cleanup, render, screen, within } from "@testing-library/react";
import { MatchResult } from "@/components/MatchResult";
import { MatchStatistics } from "@/components/MatchStatistics";

afterEach(cleanup);
const players = [{id:"gk",name:"Keeper",position:"GK"},{id:"def",name:"Defender",position:"DEF"},{id:"mid",name:"Midfielder",position:"MID"}];
it("renders reported tied awards and skipped ranks without offering selections", () => {
  render(<MatchStatistics finalized players={players}
    saved={[]} bonusAwards={[{playerId:"gk",rank:1,points:3},{playerId:"def",rank:1,points:3},{playerId:"mid",rank:3,points:1}]} />);
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
    <MatchStatistics finalized={false} players={players} saved={[]} />
    <MatchResult match={{ status, homeScore: null, awayScore: null }} home="Home" away="Away"
      canManage busy={false} onSave={async () => false} />
  </>);
  expect(screen.queryByRole("region", { name: "Match Bonus Points" })).toBeNull();
  expect(screen.queryByText(/(?:bonus points|bonuses) are calculated|tied players share/i)).toBeNull();
});
