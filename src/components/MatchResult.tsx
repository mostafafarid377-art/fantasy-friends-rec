"use client";

import { useState } from "react";
import { RealTeamName } from "./TeamLogo";
import { ClipboardCheck } from "lucide-react";
import { Button, Field, Panel, Slate, TextInput } from "./ui";

export type MatchScore = { homeScore: number; awayScore: number };
type Props = {
  match: { status: string; homeScore: number | null; awayScore: number | null };
  home: string;
  away: string;
  homeLogo?: string | null;
  awayLogo?: string | null;
  canManage: boolean;
  busy: boolean;
  unsavedStatistics?: boolean;
  onSave: (action: "submit" | "correct", score: MatchScore, reason?: string) => Promise<boolean>;
};

export function MatchResult({ match, home, away, homeLogo, awayLogo, canManage, busy, unsavedStatistics, onSave }: Props) {
  const [homeScore, setHomeScore] = useState(match.homeScore?.toString() ?? "");
  const [awayScore, setAwayScore] = useState(match.awayScore?.toString() ?? "");
  const [correcting, setCorrecting] = useState(false);
  const [reason, setReason] = useState("");
  const canEnter = canManage && (match.status === "draft" || match.status === "rejected");
  const recorded = match.homeScore != null && match.awayScore != null;
  const canCorrect = canManage && match.status === "approved" && recorded;
  const valid = /^\d{1,3}$/.test(homeScore) && /^\d{1,3}$/.test(awayScore);
  const changed = Number(homeScore) !== match.homeScore || Number(awayScore) !== match.awayScore;
  const form = canEnter || (canCorrect && correcting);

  return <section aria-label="Match result"><Panel className="mb-5 space-y-3 p-4">
    <Slate>Match result</Slate>
    {recorded && <p className="flex flex-wrap items-baseline gap-x-2 break-words text-sm text-chalk">
      <RealTeamName name={home} logo={homeLogo} /><strong className="num text-lg text-green">{match.homeScore}–{match.awayScore}</strong><RealTeamName name={away} logo={awayLogo} />
    </p>}
    {!recorded && !form && <p className="text-sm text-sage">No final score recorded.</p>}
    {canCorrect && !correcting && <Button variant="outline" size="sm" disabled={busy} onClick={() => setCorrecting(true)}>Correct score</Button>}
    {form && <form className="space-y-3" onSubmit={async (event) => {
      event.preventDefault();
      if (busy || unsavedStatistics || !valid || (correcting && (!changed || !reason.trim()))) return;
      const applied = await onSave(correcting ? "correct" : "submit", { homeScore: Number(homeScore), awayScore: Number(awayScore) }, correcting ? reason.trim() : undefined);
      if (applied) { setCorrecting(false); setReason(""); }
    }}>
      <div className="grid max-w-xl grid-cols-2 gap-3">
        <Field label={`Home score · ${home}`}><TextInput name="homeScore" required inputMode="numeric" pattern="[0-9]{1,3}" maxLength={3} value={homeScore} disabled={busy} onChange={(e) => setHomeScore(e.target.value)} /></Field>
        <Field label={`Away score · ${away}`}><TextInput name="awayScore" required inputMode="numeric" pattern="[0-9]{1,3}" maxLength={3} value={awayScore} disabled={busy} onChange={(e) => setAwayScore(e.target.value)} /></Field>
      </div>
      <p className="text-xs text-sage">{correcting ? "This updates clean sheets and any configured win or draw points, then recalculates automatic bonuses. Recorded goals, assists and other events stay unchanged." : "Enter the final on-field score. Clean-sheet points are calculated automatically on approval."}</p>
      {correcting && <Field label="Correction reason"><TextInput required maxLength={400} value={reason} disabled={busy} onChange={(e) => setReason(e.target.value)} /></Field>}
      {unsavedStatistics && <p className="text-sm text-card-y">Save or discard your statistics changes first.</p>}
      <div className="flex flex-wrap gap-2">
        <Button type="submit" loading={busy} disabled={unsavedStatistics || !valid || (correcting && (!changed || !reason.trim()))}>
          <ClipboardCheck className="h-4 w-4" /> {correcting ? "Save score correction" : "Submit for review"}
        </Button>
        {correcting && <Button variant="ghost" disabled={busy} onClick={() => {
          setCorrecting(false); setReason(""); setHomeScore(String(match.homeScore)); setAwayScore(String(match.awayScore));
        }}>Cancel correction</Button>}
      </div>
    </form>}
  </Panel></section>;
}
