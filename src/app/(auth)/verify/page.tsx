"use client";

import { Suspense, useEffect, useState } from "react";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { ArrowRight, Loader2, XCircle } from "lucide-react";
import { api, ApiRequestError } from "@/lib/client/api";
import { Button } from "@/components/ui";

function VerifyForm() {
  const params = useSearchParams();
  const token = params.get("token") ?? "";
  const [state, setState] = useState<"idle" | "working" | "ok" | "error">("idle");
  const [message, setMessage] = useState("");

  useEffect(() => {
    if (!token) {
      setState("error");
      setMessage("This verification link has no token.");
      return;
    }
    let cancelled = false;
    setState("working");
    api("/api/auth/verify", { method: "POST", body: { token } })
      .then(() => {
        if (!cancelled) setState("ok");
      })
      .catch((err) => {
        if (cancelled) return;
        setState("error");
        setMessage(err instanceof ApiRequestError ? err.message : "Verification failed");
      });
    return () => {
      cancelled = true;
    };
  }, [token]);

  return (
    <div className="animate-fade">
      <div className="slate mb-3">Email verification</div>
      <h1 className="text-[clamp(2.2rem,5vw,3rem)] text-chalk">
        {state === "ok" ? "Verified" : state === "error" ? "Link invalid" : "Confirming…"}
      </h1>

      <div className="mt-7 rounded-xl border border-line bg-pitch-900 p-5">
        {state === "working" && (
          <div className="flex items-center gap-3 text-[14.5px] text-sage">
            <Loader2 className="h-4 w-4 animate-spin text-green" />
            Checking your verification token…
          </div>
        )}
        {state === "ok" && (
          <p className="text-[14.5px] leading-relaxed text-sage">
            Your address is confirmed. Your account is fully secured and you can create or join
            leagues.
          </p>
        )}
        {state === "error" && (
          <div className="flex items-start gap-3 text-[14.5px] text-chalk">
            <XCircle className="mt-0.5 h-4 w-4 shrink-0 text-card-r" />
            <span>{message}</span>
          </div>
        )}
      </div>

      <div className="mt-6 flex gap-3">
        {state === "ok" && (
          <Button href="/dashboard">
            Go to dashboard <ArrowRight className="h-4 w-4" />
          </Button>
        )}
        {state === "error" && (
          <>
            <Button href="/login">Sign in</Button>
            <Button href="/dashboard" variant="outline">
              Continue unverified
            </Button>
          </>
        )}
      </div>

      <p className="mt-6 text-[13.5px] text-sage-dim">
        Need a fresh link?{" "}
        <Link href="/dashboard" className="underline-offset-4 hover:text-green hover:underline">
          Request it from your profile
        </Link>
        .
      </p>
    </div>
  );
}

export default function VerifyPage() {
  return (
    <Suspense fallback={null}>
      <VerifyForm />
    </Suspense>
  );
}
