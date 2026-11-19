"use client";

import { useEffect, useState } from "react";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { z } from "zod";
import { BadgeCheck, MailWarning, Save } from "lucide-react";
import { PageHeader } from "@/components/AppShell";
import { Avatar, Badge, Button, ErrorNote, Field, Panel, Skeleton, Slate, TextInput, Toast } from "@/components/ui";
import { useLeague } from "@/components/LeagueContext";
import { api, useApi } from "@/lib/client/api";

const schema = z.object({
  displayName: z.string().min(2).max(60),
  username: z.string().min(3).max(24).regex(/^[a-z0-9_]+$/i),
  avatarUrl: z.union([z.string().url(), z.literal("")]),
  bio: z.string().max(280),
});

type Values = z.infer<typeof schema>;

type Data = {
  profile: {
    id: string;
    email: string;
    username: string;
    displayName: string;
    avatarUrl: string | null;
    bio: string | null;
    emailVerified: boolean;
    createdAt: string;
  };
  stats: {
    leagues: number;
    roles: Record<string, number>;
    totalPoints: number;
    matchesPlayed: number;
    bestRank: number | null;
  };
};

export default function ProfilePage() {
  const { refresh, logout } = useLeague();
  const { data, loading, error, reload, setData } = useApi<Data>("/api/me");
  const [toast, setToast] = useState<{ message: string; tone: "ok" | "error" } | null>(null);
  const [busy, setBusy] = useState(false);
  const [verifyLink, setVerifyLink] = useState<string | null>(null);

  const {
    register,
    handleSubmit,
    reset,
    formState: { errors, isSubmitting, isDirty },
  } = useForm<Values>({ resolver: zodResolver(schema) });

  useEffect(() => {
    if (!data) return;
    reset({
      displayName: data.profile.displayName,
      username: data.profile.username,
      avatarUrl: data.profile.avatarUrl ?? "",
      bio: data.profile.bio ?? "",
    });
  }, [data, reset]);

  const onSubmit = async (values: Values) => {
    try {
      const res = await api<{ profile: Data["profile"] }>("/api/me", {
        method: "PATCH",
        body: {
          displayName: values.displayName,
          username: values.username,
          avatarUrl: values.avatarUrl || null,
          bio: values.bio || null,
        },
      });
      setData({ ...data!, profile: res.profile });
      setToast({ message: "Profile saved", tone: "ok" });
      void refresh().catch((error) => console.warn("[session refresh]", error));
    } catch (err) {
      setToast({ message: err instanceof Error ? err.message : "Could not save", tone: "error" });
    }
  };

  const resend = async () => {
    setBusy(true);
    try {
      const res = await api<{ devLink: string | null }>("/api/auth/resend", {
        method: "POST",
        body: { kind: "verify_email" },
      });
      setVerifyLink(res.devLink);
      setToast({ message: res.devLink ? "Verification link ready" : "Verification email sent", tone: "ok" });
    } catch (err) {
      setToast({ message: err instanceof Error ? err.message : "Could not send", tone: "error" });
    } finally {
      setBusy(false);
    }
  };

  if (loading && !data)
    return (
      <div className="mx-auto max-w-3xl px-4 py-6 md:px-8">
        <Skeleton className="mb-6 h-20" />
        <Skeleton className="h-96 rounded-xl" />
      </div>
    );
  if (error)
    return (
      <div className="mx-auto max-w-3xl px-4 py-8">
        <ErrorNote message={error} onRetry={reload} />
      </div>
    );
  if (!data) return null;

  return (
    <div className="mx-auto max-w-3xl px-4 py-6 md:px-8 md:py-8">
      <PageHeader
        eyebrow={`Member since ${new Date(data.profile.createdAt).toLocaleDateString()}`}
        title="Profile"
        subtitle="How you appear to the rest of the league."
        actions={
          <Button variant="outline" onClick={() => void logout()}>
            Sign out
          </Button>
        }
      />

      <div className="mb-6 grid grid-cols-2 gap-3 md:grid-cols-4">
        <Box label="Leagues" value={String(data.stats.leagues)} />
        <Box label="Total points" value={String(data.stats.totalPoints)} />
        <Box label="Matches" value={String(data.stats.matchesPlayed)} />
        <Box label="Best rank" value={data.stats.bestRank ? `#${data.stats.bestRank}` : "—"} accent />
      </div>

      {!data.profile.emailVerified && (
        <div className="mb-6 rounded-lg border border-card-y/40 bg-card-y/8 p-4">
          <div className="flex flex-wrap items-center gap-3">
            <MailWarning className="h-4 w-4 shrink-0 text-card-y" />
            <span className="flex-1 text-[14px] text-chalk">Your email address is not confirmed yet.</span>
            <Button size="sm" variant="outline" onClick={resend} loading={busy}>
              Send verification link
            </Button>
          </div>
          {verifyLink && (
            <a href={verifyLink} className="mt-2 block break-all text-[13px] text-green underline">
              {verifyLink}
            </a>
          )}
        </div>
      )}

      <Panel className="p-5">
        <div className="mb-5 flex items-center gap-4">
          <Avatar name={data.profile.displayName} url={data.profile.avatarUrl} size={64} ring />
          <div className="min-w-0">
            <div className="flex flex-wrap items-center gap-2">
              <h2 className="text-[26px] text-chalk">{data.profile.displayName}</h2>
              {data.profile.emailVerified && (
                <Badge tone="live">
                  <BadgeCheck className="h-3 w-3" /> verified
                </Badge>
              )}
            </div>
            <div className="num mt-1 text-[12.5px] uppercase tracking-[0.12em] text-sage-dim">
              @{data.profile.username} · {data.profile.email}
            </div>
            <div className="mt-2 flex flex-wrap gap-1.5">
              {Object.entries(data.stats.roles).map(([role, count]) => (
                <Badge key={role} tone={role === "leader" ? "info" : "neutral"}>
                  {role} ×{count}
                </Badge>
              ))}
            </div>
          </div>
        </div>

        <form onSubmit={handleSubmit(onSubmit)} className="space-y-4" noValidate>
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="Display name" error={errors.displayName?.message}>
              <TextInput {...register("displayName")} />
            </Field>
            <Field label="Username" error={errors.username?.message}>
              <TextInput {...register("username")} />
            </Field>
          </div>
          <Field label="Avatar URL" hint="Paste an image link — or leave it empty for initials.">
            <TextInput placeholder="https://…" {...register("avatarUrl")} />
            {errors.avatarUrl && <span className="mt-1.5 block text-xs text-card-r">{errors.avatarUrl.message}</span>}
          </Field>
          <Field label="Bio" error={errors.bio?.message}>
            <TextInput placeholder="Gaffer of the Tuesday Night League" {...register("bio")} />
          </Field>

          <div className="flex items-center justify-between pt-1">
            <Slate>{isDirty ? "Unsaved changes" : "All changes saved"}</Slate>
            <Button type="submit" loading={isSubmitting || busy}>
              <Save className="h-4 w-4" /> Save profile
            </Button>
          </div>
        </form>
      </Panel>

      {toast && <Toast message={toast.message} tone={toast.tone} onClose={() => setToast(null)} />}
    </div>
  );
}

function Box({ label, value, accent }: { label: string; value: string; accent?: boolean }) {
  return (
    <div className={`panel rounded-lg px-4 py-3.5 ${accent ? "border-green/35" : ""}`}>
      <div className="slate">{label}</div>
      <div className={`num mt-1.5 text-[24px] font-semibold ${accent ? "text-green" : "text-chalk"}`}>{value}</div>
    </div>
  );
}
