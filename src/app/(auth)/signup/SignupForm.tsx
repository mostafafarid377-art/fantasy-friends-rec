"use client";

import { useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { z } from "zod";
import { ArrowRight, CheckCircle2 } from "lucide-react";
import { api, ApiRequestError } from "@/lib/client/api";
import { GoogleSignIn } from "@/components/GoogleSignIn";
import { TurnstileChallenge } from "@/components/TurnstileChallenge";
import { turnstileSiteKey } from "@/lib/turnstile";
import { Button, Field, TextInput } from "@/components/ui";

const schema = z
  .object({
    displayName: z.string().min(2, "Enter your name").max(60),
    username: z
      .string()
      .min(3, "At least 3 characters")
      .max(24, "At most 24 characters")
      .regex(/^[a-z0-9_]+$/i, "Letters, numbers and underscores only"),
    email: z.string().email("Enter a valid email address"),
    password: z.string().min(8, "At least 8 characters").max(128),
    confirm: z.string(),
  })
  .refine((v) => v.password === v.confirm, { message: "Passwords do not match", path: ["confirm"] });

type Values = z.infer<typeof schema>;

export default function SignupForm({ next, googleStartToken }: { next: string; googleStartToken: string | null }) {
  const router = useRouter();
  const [serverError, setServerError] = useState<string | null>(null);
  const [verificationSent, setVerificationSent] = useState(false);
  const [captchaToken, setCaptchaToken] = useState<string | null>(null);
  const [captchaReset, setCaptchaReset] = useState(0);
  const captchaRequired = Boolean(turnstileSiteKey());

  const {
    register,
    handleSubmit,
    setError,
    formState: { errors, isSubmitting },
  } = useForm<Values>({ resolver: zodResolver(schema), defaultValues: { confirm: "" } });

  const onSubmit = async (values: Values) => {
    setServerError(null);
    setVerificationSent(false);
    if (captchaRequired && !captchaToken) return; // button is disabled until verified
    try {
      const res = await api<{ requiresEmailVerification?: boolean; user?: { id: string } }>(
        "/api/auth/signup",
        {
          method: "POST",
          body: {
            displayName: values.displayName,
            username: values.username,
            ...(captchaToken ? { captchaToken } : {}),
            email: values.email,
            password: values.password,
          },
        },
      );
      if (res?.requiresEmailVerification) {
        setVerificationSent(true);
        return;
      }
      if (!res?.user?.id) throw new ApiRequestError("Account creation could not be confirmed", 409);
      router.push("/dashboard");
      router.refresh();
    } catch (err) {
      // The token was consumed by the attempt — a fresh challenge is required.
      setCaptchaToken(null);
      setCaptchaReset((n) => n + 1);
      if (err instanceof ApiRequestError && err.details && typeof err.details === "object") {
        const fields = err.details as Record<string, string[]>;
        Object.entries(fields).forEach(([key, messages]) =>
          setError(key as keyof Values, { message: messages?.[0] }),
        );
        setServerError(err.message);
      } else if (err instanceof ApiRequestError) {
        setServerError(err.message);
      } else {
        setServerError("Could not create your account");
      }
    }
  };

  return (
    <div className="animate-fade">
      <div className="slate mb-3">New account</div>
      <h1 className="text-[clamp(2.2rem,5vw,3rem)] text-chalk">Create account</h1>
      <p className="mt-3 text-[14.5px] text-sage">
        Already registered?{" "}
        <Link href={next === "/dashboard" ? "/login" : `/login?${new URLSearchParams({ next })}`} className="text-green underline-offset-4 hover:underline">
          Sign in
        </Link>
        .
      </p>

      {googleStartToken && !verificationSent && <GoogleSignIn next={next} startToken={googleStartToken} />}
      {verificationSent ? (
        <div className="mt-8 rounded-xl border border-green/40 bg-green/8 p-5">
          <div className="flex items-center gap-2.5">
            <CheckCircle2 className="h-5 w-5 text-green" />
            <h2 className="text-xl text-chalk">Check your email</h2>
          </div>
          <p className="mt-3 text-[14.5px] leading-relaxed text-sage">
            Your account was created. Open the confirmation link sent by Supabase to verify your email and finish signing in.
          </p>
          <Link href={next === "/dashboard" ? "/login" : `/login?${new URLSearchParams({ next })}`} className="mt-4 inline-flex text-green underline underline-offset-4">Return to sign in</Link>
        </div>
      ) : (
        <form onSubmit={handleSubmit(onSubmit)} className={`${googleStartToken ? "mt-5" : "mt-8"} space-y-5`} noValidate>
          {serverError && (
            <div className="rounded-lg border border-card-r/40 bg-card-r/10 px-4 py-3 text-sm text-chalk">
              {serverError}
            </div>
          )}

          <Field label="Display name" error={errors.displayName?.message}>
            <TextInput placeholder="Jordan Pickford-ish" autoComplete="name" {...register("displayName")} />
          </Field>

          <Field
            label="Username"
            error={errors.username?.message}
            hint="Used for mentions and the members list"
          >
            <TextInput placeholder="gaffer" autoComplete="username" {...register("username")} />
          </Field>

          <Field label="Email" error={errors.email?.message}>
            <TextInput type="email" autoComplete="email" placeholder="you@example.com" {...register("email")} />
          </Field>

          <div className="grid gap-5 sm:grid-cols-2">
            <Field label="Password" error={errors.password?.message}>
              <TextInput type="password" autoComplete="new-password" placeholder="At least 8" {...register("password")} />
            </Field>
            <Field label="Confirm" error={errors.confirm?.message}>
              <TextInput type="password" autoComplete="new-password" placeholder="Repeat" {...register("confirm")} />
            </Field>
          </div>

          <TurnstileChallenge onToken={setCaptchaToken} resetKey={captchaReset} />

          <Button type="submit" size="lg" loading={isSubmitting} disabled={isSubmitting || (captchaRequired && !captchaToken)} className="w-full">
            Create account <ArrowRight className="h-4 w-4" />
          </Button>
        </form>
      )}
    </div>
  );
}
