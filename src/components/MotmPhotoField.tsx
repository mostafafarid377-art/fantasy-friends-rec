"use client";

import { useEffect, useRef, useState } from "react";
import { Camera, ImagePlus, Trash2 } from "lucide-react";
import { Button } from "./ui";
import { MOTM_PHOTO_EDGE, MOTM_PHOTO_MAX_BYTES } from "@/lib/motm-photo";

export type MotmPhotoChange = { kind: "keep" } | { kind: "remove" } | { kind: "upload"; blob: Blob };
export const KEEP_MOTM_PHOTO: MotmPhotoChange = { kind: "keep" };

// Portrait crop so the player fills the card's photo area (spec: about 1:2).
const CROP_RATIO = 1 / 2;

async function optimize(file: File): Promise<Blob> {
  if (!file.size || file.size > 25 * 1024 * 1024) throw new Error("Choose a photo under 25 MB.");
  if (file.type && !/^image\/(jpeg|png|webp|heic|heif|avif)$/i.test(file.type)) {
    throw new Error("Choose a JPEG, PNG, WebP, AVIF or a supported phone photo.");
  }
  const source = URL.createObjectURL(file);
  try {
    const image = new Image();
    image.src = source;
    await image.decode().catch(() => { throw new Error("This browser couldn't open the photo. Try a JPEG or take a new photo."); });
    const { naturalWidth: w, naturalHeight: h } = image;
    if (!w || !h) throw new Error("This image has no usable photo.");
    // Largest centred portrait crop the source supports.
    let cw = w;
    let ch = Math.round(w / CROP_RATIO);
    if (ch > h) {
      ch = h;
      cw = Math.round(h * CROP_RATIO);
    }
    const scale = Math.min(1, MOTM_PHOTO_EDGE / Math.max(cw, ch));
    const canvas = document.createElement("canvas");
    canvas.width = Math.max(1, Math.round(cw * scale));
    canvas.height = Math.max(1, Math.round(ch * scale));
    const ctx = canvas.getContext("2d", { alpha: false });
    if (!ctx) throw new Error("This device couldn't prepare the image.");
    ctx.fillStyle = "#0a0f0d";
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.drawImage(image, (w - cw) / 2, (h - ch) / 2, cw, ch, 0, 0, canvas.width, canvas.height);
    const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, "image/jpeg", 0.8));
    if (!blob?.size || blob.size > MOTM_PHOTO_MAX_BYTES) throw new Error("The photo could not be compressed. Try a smaller image.");
    return blob;
  } finally {
    URL.revokeObjectURL(source);
  }
}

export function MotmPhotoField({ current, change, onChange, disabled, onPreparing }: {
  current: string | null;
  change: MotmPhotoChange;
  onChange: (change: MotmPhotoChange) => void;
  disabled: boolean;
  onPreparing: (busy: boolean) => void;
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

  const src = change.kind === "upload" ? preview : change.kind === "remove" ? null : current;
  const picker = (camera: boolean) => (
    <label className="inline-flex min-h-10 cursor-pointer items-center gap-1.5 rounded border border-line px-2.5 text-sm text-chalk focus-within:ring-2 focus-within:ring-green has-disabled:cursor-not-allowed has-disabled:opacity-50">
      {camera ? <Camera className="size-4" /> : <ImagePlus className="size-4" />}
      {camera ? "Take photo" : src ? "Replace from gallery" : "Choose from gallery"}
      <input type="file" accept="image/*" capture={camera ? "environment" : undefined} disabled={disabled || busy}
        className="sr-only" onChange={(e) => { const f = e.currentTarget.files?.[0]; e.currentTarget.value = ""; void select(f); }} />
    </label>
  );

  return (
    <div className="min-w-0">
      <div className="flex flex-wrap items-center gap-3">
        <div className="h-28 w-14 shrink-0 overflow-hidden rounded border border-line bg-[#060a08]">
          {src ? (
            // eslint-disable-next-line @next/next/no-img-element -- local preview blob or proxied storage URL
            <img src={src} alt="Man of the match preview" className="h-full w-full object-cover object-top" />
          ) : (
            <div className="flex h-full w-full items-end justify-center">
              <svg viewBox="0 0 100 100" className="h-[80%] w-auto text-[#16211b]" fill="currentColor" aria-hidden>
                <circle cx="50" cy="30" r="17" /><path d="M14 100c2-26 16-40 36-40s34 14 36 40z" />
              </svg>
            </div>
          )}
        </div>
        <div className="flex flex-wrap gap-2">{picker(false)}{picker(true)}</div>
      </div>
      {busy && <p role="status" className="mt-2 text-sm text-sage">Preparing photo…</p>}
      {error && <p role="alert" className="mt-2 text-sm text-card-y">{error} The current photo hasn't changed.</p>}
      {change.kind === "upload" && <p className="mt-2 text-xs text-sage">Photo selected. It will upload when you save.</p>}
      <div className="mt-2 flex flex-wrap gap-1">
        {(current || change.kind === "upload") && change.kind !== "remove" && (
          <Button size="sm" variant="ghost" disabled={disabled || busy} onClick={() => { setError(null); onChange({ kind: "remove" }); }}>
            <Trash2 className="size-4" /> Remove photo
          </Button>
        )}
        {change.kind !== "keep" && (
          <Button size="sm" variant="ghost" disabled={disabled || busy} onClick={() => { setError(null); onChange(KEEP_MOTM_PHOTO); }}>
            Undo photo change
          </Button>
        )}
      </div>
    </div>
  );
}
