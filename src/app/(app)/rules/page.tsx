"use client";

import { useEffect, useState } from "react";
import { BadgeCheck, CircleAlert, Save, SlidersHorizontal } from "lucide-react";
import { PageHeader } from "@/components/AppShell";
import { Badge, Button, ErrorNote, Panel, Skeleton, Slate, TextInput, Toast } from "@/components/ui";
import { useActiveLeague, useLeague } from "@/components/LeagueContext";
import { api, useApi } from "@/lib/client/api";
import { POSITIONS, SCORING_CATEGORIES, type Position } from "@/lib/domain";

type Rule = {
  id: string;
  position: Position;
  eventType: string;
  points: string;
  status: "draft" | "approved";
};

type Data = { rules: Rule[]; approved: boolean; isLeader: boolean };

const CATEGORY_LABELS: Record<string, string> = {
  goal: "Goal",
  own_goal: "Own goal",
  assist: "Assist",
  yellow_card: "Yellow card",
  red_card: "Red card",
  penalty_saved: "Penalty saved",
  penalty_missed: "Penalty missed",
  appearance: "Appearance",
  clean_sheet: "Clean sheet",
  win: "Win",
  draw: "Draw",
};

export default function ScoringRulesPage() {
  const { league, loading: leagueLoading } = useActiveLeague();
  const { isLeader } = useLeague();
  const { data, loading, error, reload, setData } = useApi<Data>(
    league ? `/api/leagues/${league.id}/rules` : null,
    [league?.id],
  );

  const [draft, setDraft] = useState<Record<string, string>>({});
  const [saving, setSaving] = useState(false);
  const [toast, setToast] = useState<{ message: string; tone: "ok" | "error" } | null>(null);

  useEffect(() => {
    if (!data) return;
    const map: Record<string, string> = {};
    data.rules.forEach((r) => {
      map[`${r.position}:${r.eventType}`] = r.points;
    });
    setDraft(map);
  }, [data]);

  const key = (p: string, c: string) => `${p}:${c}`;

  const dirty =
    data?.rules.some((r) => draft[key(r.position, r.eventType)] !== r.points) ?? false;

  const save = async () => {
    if (!league || !data) return;
    setSaving(true);
    try {
      const payload = data.rules.map((r) => ({
        position: r.position,
        eventType: r.eventType,
        points: Number(draft[key(r.position, r.eventType)] ?? r.points),
      }));
      const res = await api<{ rules: Rule[]; approved: boolean }>(
        `/api/leagues/${league.id}/rules`,
        { method: "PUT", body: { action: "update", rules: payload } },
      );
      setData({ ...data, rules: res.rules, approved: res.approved });
      setToast({ message: "Draft values saved — approve to make them official", tone: "ok" });
    } catch (err) {
      setToast({ message: err instanceof Error ? err.message : "Could not save", tone: "error" });
    } finally {
      setSaving(false);
    }
  };

  const initialize = async () => {
    if (!league || !data) return;
    setSaving(true);
    try {
      const res = await api<{ rules: Rule[]; approved: boolean }>(`/api/leagues/${league.id}/rules`,
        { method: "PUT", body: { action: "initialize" } });
      if (!res?.rules?.length) throw new Error("Draft rules could not be confirmed");
      setData({ ...data, rules: res.rules, approved: res.approved });
      setToast({ message: "Scoring rules initialized. Review the draft before approving it.", tone: "ok" });
    } catch (err) {
      setToast({ message: err instanceof Error ? err.message : "Could not initialize scoring rules", tone: "error" });
    } finally { setSaving(false); }
  };

  const approve = async () => {
    if (!league || !data) return;
    setSaving(true);
    try {
      const res = await api<{ rules: Rule[]; approved: boolean }>(
        `/api/leagues/${league.id}/rules`,
        { method: "PUT", body: { action: "approve" } },
      );
      setData({ ...data, rules: res.rules, approved: true });
      setToast({ message: "Scoring rules approved — official points enabled", tone: "ok" });
      reload();
    } catch (err) {
      setToast({ message: err instanceof Error ? err.message : "Could not approve", tone: "error" });
    } finally {
      setSaving(false);
    }
  };

  if (leagueLoading || (loading && !data))
    return (
      <div className="mx-auto max-w-5xl px-4 py-6 md:px-8">
        <Skeleton className="mb-6 h-20" />
        <Skeleton className="h-96 rounded-xl" />
      </div>
    );
  if (error)
    return (
      <div className="mx-auto max-w-5xl px-4 py-8">
        <ErrorNote message={error} onRetry={reload} />
      </div>
    );
  if (!data) return null;

  const categories = SCORING_CATEGORIES.filter((c) =>
    data.rules.some((r) => r.eventType === c),
  );

  return (
    <div className="mx-auto max-w-5xl px-4 py-6 md:px-8 md:py-8">
      <PageHeader
        eyebrow={`${league?.name} · position-based scoring`}
        title="Scoring rules"
        subtitle="Numerical values are configuration, not code. Nothing here is official until the League Leader approves the set."
        actions={
          <>
            <Badge tone={data.approved ? "live" : "warn"}>
              {data.approved ? "Approved" : "Draft configuration"}
            </Badge>
            {isLeader && !data.rules.length && (
              <Button onClick={initialize} loading={saving}>Initialize draft rules</Button>
            )}
            {isLeader && data.rules.length > 0 && (
              <>
                <Button variant="outline" onClick={save} loading={saving} disabled={!dirty}>
                  <Save className="h-4 w-4" /> Save draft
                </Button>
                <Button onClick={approve} loading={saving} disabled={data.approved}>
                  <BadgeCheck className="h-4 w-4" /> Approve set
                </Button>
              </>
            )}
          </>
        }
      />

      {!data.approved && (
        <div className="mb-5 flex items-start gap-3 rounded-lg border border-card-y/40 bg-card-y/8 px-4 py-3.5">
          <CircleAlert className="mt-0.5 h-4 w-4 shrink-0 text-card-y" />
          <p className="text-[13.5px] leading-relaxed text-chalk">
            These values are a <strong className="text-card-y">draft</strong>. Match submission is
            blocked until every rule is approved, so no unofficial number can ever reach the table.
          </p>
        </div>
      )}

      {!isLeader && (
        <div className="mb-5 flex items-center gap-3 rounded-lg border border-line bg-pitch-900 px-4 py-3 text-[13.5px] text-sage">
          <SlidersHorizontal className="h-4 w-4 shrink-0" />
          Only the League Leader can edit or approve scoring rules.
        </div>
      )}

      <Panel className="overflow-x-auto">
        <table className="w-full min-w-[640px] border-collapse">
          <thead>
            <tr className="border-b border-line">
              <th className="slate px-4 py-3 text-left">Event</th>
              {POSITIONS.map((p) => (
                <th key={p} className="slate px-4 py-3 text-right">
                  {p}
                </th>
              ))}
            </tr>
          </thead>
          <tbody className="divide-y divide-line-soft">
            {categories.map((category) => (
              <tr key={category} className="transition-colors hover:bg-pitch-800/60">
                <td className="px-4 py-3">
                  <span className="text-[14.5px] text-chalk">{CATEGORY_LABELS[category] ?? category}</span>
                </td>
                {POSITIONS.map((position) => {
                  const rule = data.rules.find((r) => r.position === position && r.eventType === category);
                  const k = key(position, category);
                  if (!rule)
                    return (
                      <td key={position} className="num px-4 py-2 text-right text-[13px] text-sage-dim">
                        —
                      </td>
                    );
                  return (
                    <td key={position} className="px-4 py-2 text-right">
                      <input
                        type="number"
                        step={0.5}
                        min={-20}
                        max={50}
                        disabled={!isLeader}
                        value={draft[k] ?? rule.points}
                        onChange={(e) => setDraft({ ...draft, [k]: e.target.value })}
                        className={`num h-9 w-20 rounded-md border bg-pitch-900 px-2 text-right text-[14px] transition-colors focus:border-green focus:outline-none disabled:opacity-70 ${
                          Number(draft[k] ?? rule.points) !== Number(rule.points)
                            ? "border-card-y text-card-y"
                            : Number(rule.points) < 0
                              ? "border-line text-card-r"
                              : "border-line text-chalk"
                        }`}
                      />
                    </td>
                  );
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </Panel>

      <div className="mt-5 grid gap-4 sm:grid-cols-2">
        <Panel className="p-4">
          <Slate>Captain</Slate>
          <p className="mt-2 text-[13.5px] leading-relaxed text-sage">
            The captain scores <span className="text-green">double</span> fantasy points. The
            vice-captain takes over the double when the captain does not play, if the league rule
            allows it (set on the members screen).
          </p>
        </Panel>
        <Panel className="p-4">
          <Slate>Recalculation</Slate>
          <p className="mt-2 text-[13.5px] leading-relaxed text-sage">
            Points are keyed per match and per player, and standings are rebuilt from the ledger.
            Recalculating can never duplicate an already-counted result.
          </p>
        </Panel>
      </div>

      <Slate className="mt-6 block">
        {data.rules.length} rules · {POSITIONS.length} positions ·{" "}
        {data.approved ? "approved" : "draft"}
      </Slate>
      {toast && <Toast message={toast.message} tone={toast.tone} onClose={() => setToast(null)} />}
    </div>
  );
}
