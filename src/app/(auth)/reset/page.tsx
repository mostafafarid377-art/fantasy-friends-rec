"use client";

import { Suspense, useState } from "react";
import { useRouter } from "next/navigation";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { z } from "zod";
import { ArrowRight, CheckCircle2 } from "lucide-react";
import { api, ApiRequestError } from "@/lib/client/api";
import { Button, Field, TextInput } from "@/components/ui";

const schema = z
  .object({
    password: z.string().min(8, "At least 8 characters"),
    confirm: z.string(),
  })
  .refine((v) => v.password === v.confirm, { message: "Passwords do not match", path: ["confirm"] });

type Values = z.infer<typeof schema>;

function ResetForm() {
  const router = useRouter();
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);

  const {
    register,
    handleSubmit,
    formState: { errors, isSubmitting },
  } = useForm<Values>({ resolver: zodResolver(schema) });

  const onSubmit = async (values: Values) => {
    setError(null);
    try {
      await api("/api/auth/reset", {
        method: "POST",
        body: { password: values.password },
        idempotent: true,
      });
      setDone(true);
      setTimeout(() => router.push("/login"), 1800);
    } catch (err) {
      setError(err instanceof ApiRequestError ? err.message : "Could not reset the password");
    }
  };

  if (done) {
    return (
      <div className="animate-rise rounded-xl border border-green/40 bg-green/8 p-5">
        <div className="flex items-center gap-2.5">
          <CheckCircle2 className="h-5 w-5 text-green" />
          <h2 className="text-xl text-chalk">Password updated</h2>
        </div>
        <p className="mt-2 text-[14.5px] text-sage">All sessions were signed out. Redirecting…</p>
      </div>
    );
  }

  return (
    <form onSubmit={handleSubmit(onSubmit)} className="mt-8 space-y-5" noValidate>
      {error && (
        <div className="rounded-lg border border-card-r/40 bg-card-r/10 px-4 py-3 text-sm text-chalk">{error}</div>
      )}
      <Field label="New password" error={errors.password?.message}>
        <TextInput type="password" autoComplete="new-password" placeholder="At least 8 characters" {...register("password")} />
      </Field>
      <Field label="Confirm password" error={errors.confirm?.message}>
        <TextInput type="password" autoComplete="new-password" placeholder="Repeat" {...register("confirm")} />
      </Field>
      <Button type="submit" size="lg" loading={isSubmitting} className="w-full">
        Set new password <ArrowRight className="h-4 w-4" />
      </Button>
    </form>
  );
}

export default function ResetPage() {
  return (
    <div className="animate-fade">
      <div className="slate mb-3">Account recovery</div>
      <h1 className="text-[clamp(2.2rem,5vw,3rem)] text-chalk">Choose a password</h1>
      <p className="mt-3 text-[14.5px] text-sage">
        This link is valid for one hour and can only be used once.
      </p>
      <Suspense fallback={null}>
        <ResetForm />
      </Suspense>
    </div>
  );
}
