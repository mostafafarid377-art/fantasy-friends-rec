"use client";
import { useState } from "react";
import { Shield } from "lucide-react";

export function TeamLogo({ url, size = 24 }: { url?: string | null; size?: number }) {
  const [failed, setFailed] = useState<string | null>(null);
  return <span aria-hidden="true" className="inline-grid shrink-0 place-items-center overflow-hidden rounded-md border border-line bg-panel align-middle text-sage"
    style={{ width: size, height: size }}>
    {url && failed !== url ? <img alt="" src={url} loading="lazy" referrerPolicy="no-referrer" className="h-full w-full object-contain" onError={() => setFailed(url)} />
      : <Shield className="h-3/5 w-3/5" />}
  </span>;
}

export function RealTeamName({ name, logo }: { name: string; logo?: string | null }) {
  return <span className="inline-flex max-w-full min-w-0 items-center gap-1.5"><TeamLogo url={logo} /><span className="min-w-0 break-words">{name}</span></span>;
}
