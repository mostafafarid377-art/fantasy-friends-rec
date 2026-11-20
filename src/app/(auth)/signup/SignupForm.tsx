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

export default function SignupForm({ next, googleEnabled }: { next: string; googleEnabled: boolean }) {
  const router = useRouter();
  const [serverError, setServerError] = useState<string | null>(null);
  const [devLink, setDevLink] = useState<string | null>(null);
  const [verificationSent, setVerificationSent] = useState(false);

  const {
    register,
    handleSubmit,
    setError,
    formState: { errors, isSubmitting },
  } = useForm<Values>({ resolver: zodResolver(schema), defaultValues: { confirm: "" } });

  const onSubmit = async (values: Values) => {
    setServerError(null);
    setDevLink(null);
    setVerificationSent(false);
    try {
      const res = await api<{ devLink?: string | null; requiresEmailVerification?: boolean; user?: { id: string } }>(
        "/api/auth/signup",
        {
          method: "POST",
          body: {
            displayName: values.displayName,
            username: values.username,
            email: values.email,
            password: values.password,
          },
        },
      );
      if (res?.devLink) {
        setDevLink(res.devLink);
        return;
      }
      if (res?.requiresEmailVerification) {
        setVerificationSent(true);
        return;
      }
      if (!res?.user?.id) throw new ApiRequestError("Account creation could not be confirmed", 409);
      router.push("/dashboard");
      router.refresh();
    } catch (err) {
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

      {googleEnabled && !verificationSent && !devLink && <GoogleSignIn next={next} />}
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
      ) : devLink ? (
        <div className="mt-8 rounded-xl border border-green/40 bg-green/8 p-5">
          <div className="flex items-center gap-2.5">
            <CheckCircle2 className="h-5 w-5 text-green" />
            <h2 className="text-xl text-chalk">Confirm your email</h2>
          </div>
          <p className="mt-3 text-[14.5px] leading-relaxed text-sage">
            No SMTP provider is configured in this environment, so the verification message was
            written to the local outbox. Open the link below to verify your email address.
          </p>
          <a
            href={devLink}
            className="mt-4 inline-flex h-10 items-center rounded-md bg-green px-4 font-display text-[14px] font-bold uppercase tracking-[0.06em] text-[#04120a]"
          >
            Verify email <ArrowRight className="h-4 w-4" />
          </a>
        </div>
      ) : (
        <form onSubmit={handleSubmit(onSubmit)} className={`${googleEnabled ? "mt-5" : "mt-8"} space-y-5`} noValidate>
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

          <Button type="submit" size="lg" loading={isSubmitting} className="w-full">
            Create account <ArrowRight className="h-4 w-4" />
          </Button>
        </form>
      )}
    </div>
  );
}
