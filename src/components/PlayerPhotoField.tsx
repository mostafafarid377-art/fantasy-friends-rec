"use client";

import { useEffect, useRef, useState } from "react";
import { Camera, ImagePlus } from "lucide-react";
import { Avatar, Button, Field, TextInput } from "./ui";
import { PHOTO_EDGE, PHOTO_MAX_BYTES } from "@/lib/player-photo";

export type PhotoChange = { kind: "keep" | "remove" } | { kind: "upload"; blob: Blob } | { kind: "link"; url: string };
export const KEEP_PHOTO: PhotoChange = { kind: "keep" };

async function optimize(file: File) {
  if (!file.size || file.size > 25 * 1024 * 1024) throw new Error("Choose a photo under 25 MB.");
  if (file.type && !/^image\/(jpeg|png|webp|heic|heif|avif)$/i.test(file.type)) {
    throw new Error("Choose a JPEG, PNG, WebP, AVIF or a supported phone photo.");
  }
  const source = URL.createObjectURL(file);
  try {
    const image = new Image();
    image.src = source;
    await image.decode().catch(() => { throw new Error("This browser couldn’t open the photo. Try a JPEG or take a new photo."); });
    if (!image.naturalWidth || !image.naturalHeight) throw new Error("This image has no usable photo.");
    const crop = Math.min(image.naturalWidth, image.naturalHeight);
    const edge = Math.min(PHOTO_EDGE, crop);
    const canvas = document.createElement("canvas");
    canvas.width = canvas.height = edge;
    const ctx = canvas.getContext("2d", { alpha: false });
    if (!ctx) throw new Error("This device couldn’t prepare the image.");
    ctx.fillStyle = "#f4f7f5";
    ctx.fillRect(0, 0, edge, edge);
    ctx.drawImage(image, (image.naturalWidth - crop) / 2, (image.naturalHeight - crop) / 2, crop, crop, 0, 0, edge, edge);
    const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, "image/jpeg", 0.84));
    if (!blob?.size || blob.size > PHOTO_MAX_BYTES) throw new Error("The photo could not be compressed. Try a smaller image.");
    return blob;
  } finally { URL.revokeObjectURL(source); }
}

export function PlayerPhotoField({ name, current, change, onChange, disabled, onPreparing }: {
  name: string; current: string | null; change: PhotoChange; onChange: (change: PhotoChange) => void;
  disabled: boolean; onPreparing: (busy: boolean) => void;
}) {
  const [error, setError] = useState<string | null>(null);
  const [preview, setPreview] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const request = useRef(0);
  const blob = change.kind === "upload" ? change.blob : null;
  useEffect(() => () => { request.current++; }, []);
  useEffect(() => {
    const url = blob ? URL.createObjectURL(blob) : null;
    setPreview(url);
    return () => { if (url) URL.revokeObjectURL(url); };
  }, [blob]);

  async function select(file?: File) {
    if (!file) return;
    const serial = ++request.current;
    setError(null); setBusy(true); onPreparing(true);
    try {
      const optimized = await optimize(file);
      if (request.current === serial) onChange({ kind: "upload", blob: optimized });
    } catch (err) {
      if (request.current === serial) setError(err instanceof Error ? err.message : "Could not prepare this photo.");
    } finally {
      if (request.current === serial) { setBusy(false); onPreparing(false); }
    }
  }

  const src = change.kind === "upload" ? preview : change.kind === "remove" ? null : change.kind === "link" ? (/^https?:\/\//i.test(change.url) ? change.url : null) : current;
  const input = (camera: boolean) => (
    <label className="inline-flex min-h-10 items-center gap-1.5 rounded border border-line px-2.5 text-sm text-chalk focus-within:ring-2 focus-within:ring-green has-disabled:opacity-50">
      {camera ? <Camera className="size-4" /> : <ImagePlus className="size-4" />}
      {camera ? "Take photo" : src ? "Replace from gallery" : "Choose from gallery"}
      <input type="file" accept="image/*" capture={camera ? "environment" : undefined} disabled={disabled || busy}
        className="sr-only" onChange={(e) => { const file = e.currentTarget.files?.[0]; e.currentTarget.value = ""; void select(file); }} />
    </label>
  );
  return (
    <fieldset className="min-w-0 rounded-lg border border-line p-3">
      <legend className="px-1 text-sm font-semibold text-chalk">Player photo</legend>
      <div className="flex flex-wrap items-center gap-3">
        <Avatar name={name || "Player"} url={src} size={60} />
        <div className="flex flex-wrap gap-2">{input(false)}{input(true)}</div>
      </div>
      {busy && <p role="status" className="mt-2 text-sm text-sage">Preparing photo…</p>}
      {error && <p role="alert" className="mt-2 text-sm text-card-y">{error} The current photo hasn’t changed.</p>}
      {change.kind === "upload" && <p className="mt-2 text-xs text-sage">Photo selected. It will upload when you save.</p>}
      {change.kind === "remove" && <p className="mt-2 text-xs text-sage">Photo will be removed when you save.</p>}
      <div className="mt-2 flex flex-wrap gap-1">
        {(current || change.kind === "upload" || change.kind === "link") && change.kind !== "remove" &&
          <Button size="sm" variant="ghost" disabled={disabled || busy} onClick={() => { setError(null); onChange(current ? { kind: "remove" } : KEEP_PHOTO); }}>Remove photo</Button>}
        {change.kind !== "keep" && <Button size="sm" variant="ghost" disabled={disabled || busy} onClick={() => { setError(null); onChange(KEEP_PHOTO); }}>Undo photo change</Button>}
        {change.kind !== "link" && <Button size="sm" variant="ghost" disabled={disabled || busy} onClick={() => { setError(null); onChange({ kind: "link", url: current?.startsWith("http") ? current : "" }); }}>Use image link</Button>}
      </div>
      {change.kind === "link" && <Field label="Photo URL" hint="Use a full http or https image link.">
        <TextInput type="url" placeholder="https://…" disabled={disabled} value={change.url} onChange={(e) => onChange({ kind: "link", url: e.target.value })} />
      </Field>}
    </fieldset>
  );
}
