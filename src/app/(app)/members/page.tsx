"use client";
import { useRouter } from "next/navigation";

import { useState } from "react";
import { Check, Copy, LogOut, ShieldCheck, Trash2, UserCog, Users } from "lucide-react";
import { PageHeader } from "@/components/AppShell";
import {
  Avatar,
  Badge,
  Button,
  ConfirmDialog,
  EmptyState,
  ErrorNote,
  Field,
  Modal,
  Panel,
  Select,
  Skeleton,
  Slate,
  TextInput,
  Toast,
} from "@/components/ui";
import { useActiveLeague, useLeague } from "@/components/LeagueContext";
import { api, useApi } from "@/lib/client/api";

type Member = {
  profileId: string;
  role: "leader" | "manager" | "organizer";
  teamName: string | null;
  joinedAt: string;
  username: string;
  displayName: string;
  avatarUrl: string | null;
};

type Data = {
  members: Member[];
  league: { id: string; name: string; inviteCode: string; format: string; vicePolicy: string };
  role: string;
  activity: { id: string; summary: string; action: string; createdAt: string }[];
};

export default function MembersPage() {
  const router = useRouter();
  const { league, loading: leagueLoading } = useActiveLeague();
  const { user, refresh } = useLeague();
  const { data, loading, error, reload } = useApi<Data>(
    league ? `/api/leagues/${league.id}` : null,
    [league?.id],
  );

  const [copied, setCopied] = useState(false);
  const [toast, setToast] = useState<{ message: string; tone: "ok" | "error" } | null>(null);
  const [roleTarget, setRoleTarget] = useState<Member | null>(null);
  const [nextRole, setNextRole] = useState<Member["role"]>("manager");
  const [saving, setSaving] = useState(false);
  const [confirm, setConfirm] = useState<{ kind: "leave" | "remove"; member?: Member } | null>(null);

  const isLeader = data?.role === "leader";

  const copyCode = async () => {
    if (!data) return;
    try {
      await navigator.clipboard.writeText(data.league.inviteCode);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      setToast({ message: `Invite code: ${data.league.inviteCode}`, tone: "ok" });
    }
  };

  const saveRole = async () => {
    if (!league || !roleTarget) return;
    setSaving(true);
    try {
      await api(`/api/leagues/${league.id}/members`, {
        method: "PATCH",
        body: { profileId: roleTarget.profileId, role: nextRole },
      });
      setToast({ message: "Role updated", tone: "ok" });
      setRoleTarget(null);
      reload();
      void refresh().catch((error) => console.warn("[session refresh]", error));
    } catch (err) {
      setToast({ message: err instanceof Error ? err.message : "Role change failed", tone: "error" });
    } finally {
      setSaving(false);
    }
  };

  const runConfirm = async () => {
    if (!league || !confirm) return;
    setSaving(true);
    try {
      if (confirm.kind === "leave") {
        await api(`/api/leagues/${league.id}/members`, { method: "DELETE" });
        setConfirm(null);
        setToast({ message: "You left the league", tone: "ok" });
        await refresh();
        router.replace("/dashboard");
      } else if (confirm.member) {
        await api(`/api/leagues/${league.id}/members?profileId=${confirm.member.profileId}`, {
          method: "DELETE",
        });
        setToast({ message: "Manager removed", tone: "ok" });
        setConfirm(null);
        reload();
      }
    } catch (err) {
      setToast({ message: err instanceof Error ? err.message : "Action failed", tone: "error" });
      setConfirm(null);
    } finally {
      setSaving(false);
    }
  };

  const updateSettings = async (patch: Record<string, unknown>) => {
    if (!league) return;
    try {
      await api(`/api/leagues/${league.id}`, { method: "PATCH", body: patch });
      setToast({ message: "League settings saved", tone: "ok" });
      reload();
      void refresh().catch((error) => console.warn("[session refresh]", error));
    } catch (err) {
      setToast({ message: err instanceof Error ? err.message : "Could not save settings", tone: "error" });
    }
  };

  if (leagueLoading || (loading && !data))
    return (
      <div className="mx-auto max-w-4xl px-4 py-6 md:px-8">
        <Skeleton className="mb-6 h-20" />
        <Skeleton className="h-72 rounded-xl" />
      </div>
    );
  if (error)
    return (
      <div className="mx-auto max-w-4xl px-4 py-8">
        <ErrorNote message={error} onRetry={reload} />
      </div>
    );
  if (!data) return null;

  return (
    <div className="mx-auto max-w-4xl px-4 py-6 md:px-8 md:py-8">
      <PageHeader
        eyebrow={`${data.league.name} · ${data.league.format}`}
        title="League members"
        subtitle="Roles decide what each person may do. Permissions are enforced on the server, not just hidden in the interface."
        actions={
          <Button
            variant="danger"
            onClick={() => setConfirm({ kind: "leave" })}
          >
            <LogOut className="h-4 w-4" /> Leave league
          </Button>
        }
      />

      {/* invite */}
      <Panel className="mb-5 flex flex-col gap-4 p-5 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <Slate>Invitation code</Slate>
          <div className="num mt-1.5 text-[34px] font-semibold tracking-[0.16em] text-green">
            {data.league.inviteCode}
          </div>
          <p className="mt-1 text-[12.5px] text-sage-dim">Share it — anyone with the code can join.</p>
        </div>
        <Button onClick={copyCode} variant={copied ? "primary" : "outline"}>
          {copied ? <Check className="h-4 w-4" /> : <Copy className="h-4 w-4" />}
          {copied ? "Copied" : "Copy code"}
        </Button>
      </Panel>

      {/* members */}
      <Panel className="overflow-hidden">
        <div className="flex items-center justify-between border-b border-line px-4 py-3.5">
          <div className="flex items-center gap-2">
            <Users className="h-4 w-4 text-green" />
            <Slate>{data.members.length} managers</Slate>
          </div>
        </div>
        <ul className="divide-y divide-line-soft">
          {data.members.map((m) => (
            <li key={m.profileId} className="flex flex-wrap items-center gap-3 px-4 py-3.5">
              <Avatar name={m.displayName} url={m.avatarUrl} size={38} />
              <div className="min-w-0 flex-1">
                <div className="truncate text-[15px] font-semibold text-chalk">
                  {m.displayName}
                  {m.profileId === user?.id && <span className="ml-2 text-[10.5px] uppercase tracking-widest text-green">you</span>}
                </div>
                <div className="truncate text-[12px] text-sage-dim">
                  @{m.username} · {m.teamName ?? "no team name"} · joined{" "}
                  {new Date(m.joinedAt).toLocaleDateString()}
                </div>
              </div>

              <Badge tone={m.role === "leader" ? "info" : m.role === "organizer" ? "live" : "neutral"}>
                {m.role === "leader" ? "League leader" : m.role === "organizer" ? "Organizer" : "Manager"}
              </Badge>

              {isLeader && m.profileId !== user?.id && (
                <div className="flex gap-1.5">
                  <button
                    onClick={() => {
                      setRoleTarget(m);
                      setNextRole(m.role);
                    }}
                    className="rounded border border-line p-1.5 text-sage transition-colors hover:border-green hover:text-green"
                    aria-label="Change role"
                  >
                    <UserCog className="h-4 w-4" />
                  </button>
                  <button
                    onClick={() => setConfirm({ kind: "remove", member: m })}
                    className="rounded border border-line p-1.5 text-sage transition-colors hover:border-card-r hover:text-card-r"
                    aria-label="Remove from league"
                  >
                    <Trash2 className="h-4 w-4" />
                  </button>
                </div>
              )}
            </li>
          ))}
        </ul>
      </Panel>

      {/* league policy (leader) */}
      {isLeader && (
        <Panel className="mt-5 p-5">
          <div className="mb-4 flex items-center gap-2">
            <ShieldCheck className="h-4 w-4 text-green" />
            <Slate>Review policy</Slate>
          </div>
          <div className="grid max-w-xl gap-4">
            <Field label="Vice-captain rule" hint="What happens when the captain does not play.">
              <Select
                value={data.league.vicePolicy}
                onChange={(e) => updateSettings({ vicePolicy: e.target.value })}
              >
                <option value="auto_captain">Vice-captain inherits the double</option>
                <option value="none">No doubling without the captain</option>
              </Select>
            </Field>
          </div>
        </Panel>
      )}

      {/* activity */}
      <Panel className="mt-5 p-5">
        <Slate>League activity</Slate>
        {!data.activity.length ? (
          <p className="mt-3 text-[13.5px] text-sage-dim">Nothing has happened yet.</p>
        ) : (
          <ul className="mt-3 divide-y divide-line-soft">
            {data.activity.map((a) => (
              <li key={a.id} className="flex items-start gap-3 py-2.5">
                <span className="num w-28 shrink-0 text-[11px] uppercase tracking-[0.1em] text-sage-dim">
                  {new Date(a.createdAt).toLocaleDateString()}
                </span>
                <span className="flex-1 text-[13.5px] text-chalk">{a.summary}</span>
                <span className="num hidden shrink-0 text-[10.5px] uppercase text-green-dim sm:block">{a.action}</span>
              </li>
            ))}
          </ul>
        )}
      </Panel>

      <Modal
        open={Boolean(roleTarget)}
        onClose={() => setRoleTarget(null)}
        title={`Role for ${roleTarget?.displayName ?? ""}`}
        width="max-w-md"
      >
        <div className="space-y-4">
          <Field label="Role" hint="Leaders manage settings and approve results. Organizers record matches.">
            <Select value={nextRole} onChange={(e) => setNextRole(e.target.value as Member["role"])}>
              <option value="manager">Manager — own squad only</option>
              <option value="organizer">Match Organizer — records matches</option>
              <option value="leader">League Leader — full control</option>
            </Select>
          </Field>
          <div className="flex justify-end gap-2.5">
            <Button variant="ghost" onClick={() => setRoleTarget(null)}>
              Cancel
            </Button>
            <Button onClick={saveRole} loading={saving}>
              Save role
            </Button>
          </div>
        </div>
      </Modal>

      <ConfirmDialog
        open={Boolean(confirm)}
        title={confirm?.kind === "leave" ? "Leave this league?" : "Remove this manager?"}
        body={
          confirm?.kind === "leave"
            ? "You will lose access to this league's squad, standings and matches. Your history stays with the league."
            : `${confirm?.member?.displayName ?? "This manager"} will lose access immediately. Their results remain in the table.`
        }
        confirmLabel={confirm?.kind === "leave" ? "Leave league" : "Remove manager"}
        danger
        loading={saving}
        onConfirm={runConfirm}
        onCancel={() => setConfirm(null)}
      />

      {toast && <Toast message={toast.message} tone={toast.tone} onClose={() => setToast(null)} />}
    </div>
  );
}
