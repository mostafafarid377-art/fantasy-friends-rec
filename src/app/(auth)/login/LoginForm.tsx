"use client";

import { useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { z } from "zod";
import { ArrowRight, MailWarning } from "lucide-react";
import { api, ApiRequestError } from "@/lib/client/api";
import { GoogleSignIn } from "@/components/GoogleSignIn";
import { Button, Field, TextInput } from "@/components/ui";

const schema = z.object({
  email: z.string().email("Enter a valid email address"),
  password: z.string().min(1, "Enter your password"),
});

type Values = z.infer<typeof schema>;

export default function LoginForm({ next, googleEnabled, authError }: { next: string; googleEnabled: boolean; authError?: string }) {
  const router = useRouter();
  const [serverError, setServerError] = useState<string | null>(null);
  const [showAuthError, setShowAuthError] = useState(true);
  const message = serverError ?? (showAuthError ? authError : null);

  const {
    register,
    handleSubmit,
    formState: { errors, isSubmitting },
  } = useForm<Values>({ resolver: zodResolver(schema), defaultValues: { email: "", password: "" } });

  const onSubmit = async (values: Values) => {
    setServerError(null);
    setShowAuthError(false);
    try {
      await api("/api/auth/login", { method: "POST", body: values });
      router.push(next);
      router.refresh();
    } catch (err) {
      if (err instanceof ApiRequestError) setServerError(err.message);
      else setServerError("Could not sign you in");
    }
  };

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
      {googleEnabled && <GoogleSignIn next={next} />}
      <form onSubmit={handleSubmit(onSubmit)} className={`${googleEnabled ? "mt-5" : "mt-8"} space-y-5`} noValidate>
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

        <Button type="submit" size="lg" loading={isSubmitting} className="w-full">
          Sign in <ArrowRight className="h-4 w-4" />
        </Button>

      </form>
    </div>
  );
}
