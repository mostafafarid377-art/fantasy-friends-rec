"use client";

import { useState } from "react";
import Link from "next/link";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { z } from "zod";
import { ArrowRight, Inbox } from "lucide-react";
import { api, ApiRequestError } from "@/lib/client/api";
import { TurnstileChallenge } from "@/components/TurnstileChallenge";
import { turnstileSiteKey } from "@/lib/turnstile";
import { Button, Field, TextInput } from "@/components/ui";

const schema = z.object({ email: z.string().email("Enter a valid email address") });
type Values = z.infer<typeof schema>;

export default function ForgotPasswordPage() {
  const [sent, setSent] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [captchaToken, setCaptchaToken] = useState<string | null>(null);
  const [captchaReset, setCaptchaReset] = useState(0);
  const captchaRequired = Boolean(turnstileSiteKey());

  const {
    register,
    handleSubmit,
    formState: { errors, isSubmitting },
  } = useForm<Values>({ resolver: zodResolver(schema) });

  const onSubmit = async (values: Values) => {
    setError(null);
    if (captchaRequired && !captchaToken) return; // button is disabled until verified
    try {
      await api("/api/auth/forgot", {
        method: "POST",
        body: { ...values, ...(captchaToken ? { captchaToken } : {}) },
      });
      setSent(true);
    } catch (err) {
      // The token was consumed by the attempt — a fresh challenge is required.
      setCaptchaToken(null);
      setCaptchaReset((n) => n + 1);
      setError(err instanceof ApiRequestError ? err.message : "Could not send the request");
    }
  };

  return (
    <div className="animate-fade">
      <div className="slate mb-3">Account recovery</div>
      <h1 className="text-[clamp(2.2rem,5vw,3rem)] text-chalk">Reset password</h1>

      {sent ? (
        <div className="mt-8 rounded-xl border border-line bg-pitch-900 p-5">
          <div className="flex items-center gap-2.5">
            <Inbox className="h-5 w-5 text-green" />
            <h2 className="text-xl text-chalk">Check your inbox</h2>
          </div>
          <p className="mt-3 text-[14.5px] leading-relaxed text-sage">
            If an account exists for that address, a one-hour reset link is on its way. The
            link opens this app and signs you out of every device once used.
          </p>
          <div className="mt-5 flex gap-3">
            <Button href="/login" variant="outline">
              Back to sign in
            </Button>
            <Button variant="ghost" onClick={() => { setSent(false); setCaptchaToken(null); setCaptchaReset((n) => n + 1); }}>
              Send again
            </Button>
          </div>
        </div>
      ) : (
        /* method="post" matters only if client JS never runs: the native
           fallback must never be a GET, which would serialize the email into
           the URL, browser history and referer headers. */
        <form method="post" onSubmit={handleSubmit(onSubmit)} className="mt-8 space-y-5" noValidate>
          <p className="text-[14.5px] leading-relaxed text-sage">
            Enter the address you registered with and we will send a link to set a new password.
          </p>
          {error && (
            <div className="rounded-lg border border-card-r/40 bg-card-r/10 px-4 py-3 text-sm text-chalk">
              {error}
            </div>
          )}
          <Field label="Email" error={errors.email?.message}>
            <TextInput type="email" autoComplete="email" placeholder="you@example.com" {...register("email")} />
          </Field>
          <TurnstileChallenge onToken={setCaptchaToken} resetKey={captchaReset} />
          <Button type="submit" size="lg" loading={isSubmitting} disabled={isSubmitting || (captchaRequired && !captchaToken)} className="w-full">
            Send reset link <ArrowRight className="h-4 w-4" />
          </Button>
          <p className="text-center text-[13.5px] text-sage">
            <Link href="/login" className="underline-offset-4 hover:text-green hover:underline">
              Back to sign in
            </Link>
          </p>
        </form>
      )}
    </div>
  );
}
