"use client";

import { useEffect, type ReactNode } from "react";
import Link from "next/link";
import {
  AlertTriangle,
  ArrowRight,
  CheckCircle2,
  Loader2,
  Plus,
  Search,
  X,
} from "lucide-react";

export function Slate({ children, className = "" }: { children: ReactNode; className?: string }) {
  return <div className={`slate ${className}`}>{children}</div>;
}

export function Panel({
  children,
  className = "",
  bleed = false,
}: {
  children: ReactNode;
  className?: string;
  bleed?: boolean;
}) {
  return (
    <section className={`panel ${bleed ? "" : "rounded-xl"} ${className}`}>{children}</section>
  );
}

type ButtonProps = {
  children: ReactNode;
  onClick?: () => void;
  type?: "button" | "submit";
  variant?: "primary" | "ghost" | "outline" | "danger" | "quiet";
  size?: "sm" | "md" | "lg";
  disabled?: boolean;
  loading?: boolean;
  className?: string;
  href?: string;
  title?: string;
};

export function Button({
  children,
  onClick,
  type = "button",
  variant = "primary",
  size = "md",
  disabled,
  loading,
  className = "",
  href,
  title,
}: ButtonProps) {
  const base =
    "relative inline-flex items-center justify-center gap-2 font-display font-bold uppercase tracking-[0.06em] transition-all duration-150 active:translate-y-px disabled:opacity-45 disabled:pointer-events-none select-none";
  const sizes = {
    sm: "h-8 px-3 text-[13px]",
    md: "h-10 px-4 text-[14px]",
    lg: "h-12 px-6 text-[16px]",
  }[size];
  const variants = {
    primary:
      "bg-green text-[#04120a] hover:bg-green-glow shadow-[0_0_0_1px_rgba(49,224,125,0.4),0_8px_24px_-12px_rgba(49,224,125,0.75)]",
    outline: "border border-line text-chalk hover:border-green hover:text-green bg-pitch-900/60",
    ghost: "text-sage hover:text-chalk hover:bg-pitch-800",
    quiet: "bg-pitch-800 text-chalk border border-line hover:border-green-dim",
    danger: "bg-card-r/12 text-card-r border border-card-r/40 hover:bg-card-r/20",
  }[variant];

  const content = loading ? (
    <>
      <Loader2 className="h-4 w-4 animate-spin" />
      <span>Working…</span>
    </>
  ) : (
    children
  );

  if (href) {
    return (
      <Link href={href} className={`${base} ${sizes} ${variants} ${className}`} title={title}>
        {content}
      </Link>
    );
  }
  return (
    <button
      type={type}
      onClick={onClick}
      disabled={disabled || loading}
      title={title}
      className={`${base} ${sizes} ${variants} ${className}`}
    >
      {content}
    </button>
  );
}

export function Field({
  label,
  hint,
  error,
  children,
}: {
  label: string;
  hint?: string;
  error?: string;
  children: ReactNode;
}) {
  return (
    <label className="block">
      <span className="slate mb-2 block">{label}</span>
      {children}
      {hint && !error && <span className="mt-1.5 block text-xs text-sage-dim">{hint}</span>}
      {error && (
        <span className="mt-1.5 flex items-start gap-1.5 text-xs text-card-r">
          <AlertTriangle className="mt-px h-3.5 w-3.5 shrink-0" />
          {error}
        </span>
      )}
    </label>
  );
}

export const inputClass =
  "w-full h-11 rounded-lg bg-pitch-900 border border-line px-3.5 text-[15px] text-chalk placeholder:text-sage-dim/70 transition-colors focus:border-green focus:outline-none focus:ring-1 focus:ring-green/40";

export function TextInput(props: React.InputHTMLAttributes<HTMLInputElement>) {
  return <input {...props} className={`${inputClass} ${props.className ?? ""}`} />;
}

export function Select(props: React.SelectHTMLAttributes<HTMLSelectElement>) {
  return (
    <select
      {...props}
      className={`${inputClass} appearance-none bg-[url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='12' height='8' fill='none'%3E%3Cpath d='M1 1l5 5 5-5' stroke='%238FA39A' stroke-width='1.6'/%3E%3C/svg%3E")] bg-[length:12px] bg-[right_14px_center] bg-no-repeat pr-9 ${props.className ?? ""}`}
    />
  );
}

export function Badge({
  children,
  tone = "neutral",
  className = "",
}: {
  children: ReactNode;
  tone?: "neutral" | "live" | "warn" | "danger" | "info";
  className?: string;
}) {
  const tones = {
    neutral: "border-line text-sage bg-pitch-800",
    live: "border-green/45 text-green bg-green/10",
    warn: "border-card-y/45 text-card-y bg-card-y/10",
    danger: "border-card-r/45 text-card-r bg-card-r/10",
    info: "border-green-dim/50 text-green-glow bg-green-deep/20",
  }[tone];
  return (
    <span
      className={`inline-flex items-center gap-1.5 rounded border px-2 py-[3px] text-[10.5px] font-semibold uppercase tracking-[0.14em] ${tones} ${className}`}
    >
      {children}
    </span>
  );
}

export function LiveDot() {
  return <span className="relative flex h-1.5 w-1.5">
    <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-green opacity-70" />
    <span className="relative inline-flex h-1.5 w-1.5 rounded-full bg-green" />
  </span>;
}

export function EmptyState({
  title,
  body,
  action,
  icon,
}: {
  title: string;
  body: string;
  action?: { label: string; href: string };
  icon?: ReactNode;
}) {
  return (
    <div className="flex flex-col items-center justify-center rounded-xl border border-dashed border-line px-6 py-14 text-center">
      <div className="mb-4 flex h-12 w-12 items-center justify-center rounded-full border border-line bg-pitch-900 text-green">
        {icon ?? <Plus className="h-5 w-5" />}
      </div>
      <h3 className="text-xl text-chalk">{title}</h3>
      <p className="mt-2 max-w-sm text-sm leading-relaxed text-sage">{body}</p>
      {action && (
        <Button href={action.href} className="mt-5">
          {action.label} <ArrowRight className="h-4 w-4" />
        </Button>
      )}
    </div>
  );
}

export function Skeleton({ className = "" }: { className?: string }) {
  return (
    <div
      className={`animate-pulse rounded bg-pitch-800 ${className}`}
      style={{ backgroundImage: "linear-gradient(90deg,#131c17,#1a251f,#131c17)" }}
    />
  );
}

export function TableSkeleton({ rows = 6 }: { rows?: number }) {
  return (
    <div className="space-y-px overflow-hidden rounded-lg border border-line">
      {Array.from({ length: rows }).map((_, i) => (
        <div key={i} className="flex items-center gap-4 bg-pitch-850 px-4 py-3.5">
          <Skeleton className="h-5 w-6" />
          <Skeleton className="h-4 flex-1" />
          <Skeleton className="h-4 w-14" />
        </div>
      ))}
    </div>
  );
}

export function ErrorNote({ message, onRetry }: { message: string; onRetry?: () => void }) {
  return (
    <div className="flex items-start gap-3 rounded-lg border border-card-r/40 bg-card-r/10 px-4 py-3">
      <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-card-r" />
      <div className="flex-1 text-sm text-chalk">{message}</div>
      {onRetry && (
        <button onClick={onRetry} className="slate text-card-r hover:text-chalk">
          Retry
        </button>
      )}
    </div>
  );
}

export function Toast({
  message,
  tone = "ok",
  onClose,
}: {
  message: string;
  tone?: "ok" | "error";
  onClose: () => void;
}) {
  useEffect(() => {
    const t = setTimeout(onClose, 4200);
    return () => clearTimeout(t);
  }, [onClose]);

  return (
    <div className="fixed inset-x-4 bottom-24 z-[80] flex justify-center md:inset-x-auto md:bottom-6 md:right-6">
      <div
        className={`animate-rise flex items-center gap-3 rounded-lg border px-4 py-3 shadow-2xl backdrop-blur ${
          tone === "ok"
            ? "border-green/40 bg-[#0b1a12]/95 text-chalk"
            : "border-card-r/50 bg-[#1c0d0d]/95 text-chalk"
        }`}
      >
        {tone === "ok" ? (
          <CheckCircle2 className="h-4 w-4 text-green" />
        ) : (
          <AlertTriangle className="h-4 w-4 text-card-r" />
        )}
        <span className="text-sm">{message}</span>
        <button onClick={onClose} aria-label="Dismiss" className="text-sage hover:text-chalk">
          <X className="h-4 w-4" />
        </button>
      </div>
    </div>
  );
}

export function Modal({
  open,
  onClose,
  title,
  children,
  width = "max-w-lg",
}: {
  open: boolean;
  onClose: () => void;
  title: string;
  children: ReactNode;
  width?: string;
}) {
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    document.body.style.overflow = "hidden";
    return () => {
      window.removeEventListener("keydown", onKey);
      document.body.style.overflow = "";
    };
  }, [open, onClose]);

  if (!open) return null;
  return (
    <div className="fixed inset-0 z-[90] flex items-end justify-center bg-black/75 p-0 backdrop-blur-sm sm:items-center sm:p-6">
      <button className="absolute inset-0 cursor-default" aria-label="Close" onClick={onClose} />
      <div
        className={`animate-rise relative w-full ${width} max-h-[92dvh] overflow-y-auto rounded-t-2xl border border-line bg-pitch-850 p-5 shadow-2xl sm:rounded-xl sm:p-6`}
      >
        <div className="mb-5 flex items-start justify-between gap-4">
          <h2 className="text-2xl text-chalk">{title}</h2>
          <button
            onClick={onClose}
            aria-label="Close dialog"
            className="rounded p-1 text-sage transition-colors hover:bg-pitch-800 hover:text-chalk"
          >
            <X className="h-5 w-5" />
          </button>
        </div>
        {children}
      </div>
    </div>
  );
}

export function ConfirmDialog({
  open,
  title,
  body,
  confirmLabel = "Confirm",
  danger,
  loading,
  onConfirm,
  onCancel,
}: {
  open: boolean;
  title: string;
  body: string;
  confirmLabel?: string;
  danger?: boolean;
  loading?: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  return (
    <Modal open={open} onClose={onCancel} title={title} width="max-w-md">
      <p className="text-sm leading-relaxed text-sage">{body}</p>
      <div className="mt-6 flex justify-end gap-3">
        <Button variant="ghost" onClick={onCancel}>
          Cancel
        </Button>
        <Button variant={danger ? "danger" : "primary"} loading={loading} onClick={onConfirm}>
          {confirmLabel}
        </Button>
      </div>
    </Modal>
  );
}

export function SearchBox({
  value,
  onChange,
  placeholder = "Search…",
}: {
  value: string;
  onChange: (v: string) => void;
  placeholder?: string;
}) {
  return (
    <div className="relative">
      <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-sage-dim" />
      <input
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        className={`${inputClass} pl-9`}
      />
      {value && (
        <button
          onClick={() => onChange("")}
          aria-label="Clear search"
          className="absolute right-3 top-1/2 -translate-y-1/2 text-sage-dim hover:text-chalk"
        >
          <X className="h-4 w-4" />
        </button>
      )}
    </div>
  );
}

export function Avatar({
  name,
  url,
  size = 36,
  ring = false,
}: {
  name: string;
  url?: string | null;
  size?: number;
  ring?: boolean;
}) {
  const initials = name
    .split(/\s+/)
    .slice(0, 2)
    .map((p) => p[0])
    .join("")
    .toUpperCase();
  return (
    <span
      className={`inline-flex shrink-0 items-center justify-center overflow-hidden rounded-full border ${
        ring ? "border-green/60" : "border-line"
      } bg-pitch-800 font-display font-bold text-green`}
      style={{ width: size, height: size, fontSize: Math.max(10, size * 0.36) }}
    >
      {url ? (
        // eslint-disable-next-line @next/next/no-img-element
        <img src={url} alt={name} className="h-full w-full object-cover" />
      ) : (
        initials
      )}
    </span>
  );
}
