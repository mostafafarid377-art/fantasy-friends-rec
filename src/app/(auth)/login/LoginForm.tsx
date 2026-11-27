"use client";

import { useEffect, useState, type FormEvent } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { z } from "zod";
import { ArrowRight, MailWarning } from "lucide-react";
import { api, ApiRequestError } from "@/lib/client/api";
import { GoogleSignIn } from "@/components/GoogleSignIn";
import { TurnstileChallenge } from "@/components/TurnstileChallenge";
import { turnstileSiteKey } from "@/lib/turnstile";
import { Button, Field, TextInput } from "@/components/ui";

const schema = z.object({
  email: z.string().email("Enter a valid email address"),
  password: z.string().min(1, "Enter your password"),
});

type Values = z.infer<typeof schema>;

export default function LoginForm({ next, googleStartToken, authError, mfa = false }: { next: string; googleStartToken: string | null; authError?: string; mfa?: boolean }) {
  const router = useRouter();
  const [serverError, setServerError] = useState<string | null>(null);
  const [showAuthError, setShowAuthError] = useState(true);
  const [captchaToken, setCaptchaToken] = useState<string | null>(null);
  const [captchaReset, setCaptchaReset] = useState(0);
  const captchaRequired = Boolean(turnstileSiteKey());
  const message = serverError ?? (showAuthError ? authError : null);
  const [needsCode, setNeedsCode] = useState(mfa);
  const [factorId, setFactorId] = useState<string | null>(null);

  // After Google or an email link, the session is waiting for its second step.
  useEffect(() => {
    if (!mfa) return;
    api<{ factorId: string }>("/api/auth/mfa/verify")
      .then((r) => setFactorId(r.factorId))
      .catch(() => { setNeedsCode(false); setServerError("Your sign-in expired. Please sign in again."); });
  }, [mfa]);

  const {
    register,
    handleSubmit,
    formState: { errors, isSubmitting },
  } = useForm<Values>({ resolver: zodResolver(schema), defaultValues: { email: "", password: "" } });

  const onSubmit = async (values: Values) => {
    setServerError(null);
    setShowAuthError(false);
    if (captchaRequired && !captchaToken) return; // button is disabled until verified
    try {
      const res = await api<{ mfaRequired?: boolean; factorId?: string }>("/api/auth/login", { method: "POST", body: { ...values, ...(captchaToken ? { captchaToken } : {}) } });
      if (res?.mfaRequired && res.factorId) {
        setFactorId(res.factorId);
        setNeedsCode(true);
        return;
      }
      router.push(next);
      router.refresh();
    } catch (err) {
      // The token was consumed by the attempt — a fresh challenge is required.
      setCaptchaToken(null);
      setCaptchaReset((n) => n + 1);
      if (err instanceof ApiRequestError) setServerError(err.message);
      else setServerError("Could not sign you in");
    }
  };

  if (needsCode) {
    return (
      <div className="animate-fade">
        <div className="slate mb-3">One more step</div>
        <h1 className="text-[clamp(2.2rem,5vw,3rem)] text-chalk">Two-step verification</h1>
        <p className="mt-3 text-[14.5px] text-sage">Enter the 6-digit code from your authenticator app.</p>
        {message && (
          <div role="alert" className="mt-5 flex items-start gap-2.5 rounded-lg border border-card-r/40 bg-card-r/10 px-4 py-3 text-sm text-chalk">
            <MailWarning aria-hidden="true" className="mt-0.5 h-4 w-4 shrink-0 text-card-r" />
            <span>{message}</span>
          </div>
        )}
        <MfaStep factorId={factorId} next={next} />
      </div>
    );
  }

  return (
    <div className="animate-fade">
      <div className="slate mb-3">Welcome back</div>
      <h1 className="text-[clamp(2.2rem,5vw,3rem)] text-chalk">Sign in</h1>
      <p className="mt-3 text-[14.5px] text-sage">
        No account yet?{" "}
        <Link href={next === "/dashboard" ? "/signup" : `/signup?${new URLSearchParams({ next })}`} className="text-green underline-offset-4 hover:underline">
          Create one
        </Link>
        .
      </p>

      {message && (
        <div role="alert" className="mt-5 flex items-start gap-2.5 rounded-lg border border-card-r/40 bg-card-r/10 px-4 py-3 text-sm text-chalk">
          <MailWarning aria-hidden="true" className="mt-0.5 h-4 w-4 shrink-0 text-card-r" />
          <span>{message}</span>
        </div>
      )}
      {googleStartToken && <GoogleSignIn next={next} startToken={googleStartToken} />}
      <form onSubmit={handleSubmit(onSubmit)} className={`${googleStartToken ? "mt-5" : "mt-8"} space-y-5`} noValidate>
        <Field label="Email" error={errors.email?.message}>
          <TextInput type="email" autoComplete="email" placeholder="you@example.com" {...register("email")} />
        </Field>

        <Field label="Password" error={errors.password?.message}>
          <TextInput type="password" autoComplete="current-password" placeholder="••••••••" {...register("password")} />
        </Field>

        <div className="flex items-center justify-between">
          <Link href="/forgot" className="text-[13.5px] text-sage underline-offset-4 hover:text-green hover:underline">
            Forgot password?
          </Link>
        </div>

        <TurnstileChallenge onToken={setCaptchaToken} resetKey={captchaReset} />

        <Button type="submit" size="lg" loading={isSubmitting} disabled={isSubmitting || (captchaRequired && !captchaToken)} className="w-full">
          Sign in <ArrowRight className="h-4 w-4" />
        </Button>

      </form>
    </div>
  );
}

function MfaStep({ factorId, next }: { factorId: string | null; next: string }) {
  const router = useRouter();
  const [code, setCode] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (!factorId || code.length !== 6) return;
    setBusy(true);
    setError(null);
    try {
      await api("/api/auth/mfa/verify", { method: "POST", body: { factorId, code } });
      router.push(next);
      router.refresh();
    } catch (err) {
      setError(err instanceof ApiRequestError ? err.message : "Could not verify the code");
      setBusy(false);
    }
  };

  return (
    <form onSubmit={submit} className="mt-8 space-y-5" noValidate>
      <Field label="Authentication code" error={error ?? undefined}>
        <TextInput
          inputMode="numeric"
          autoComplete="one-time-code"
          maxLength={6}
          placeholder="123456"
          value={code}
          onChange={(e) => setCode(e.target.value.replace(/\D/g, ""))}
        />
      </Field>
      <Button type="submit" size="lg" loading={busy} disabled={busy || !factorId || code.length !== 6} className="w-full">
        Verify <ArrowRight className="h-4 w-4" />
      </Button>
    </form>
  );
}
