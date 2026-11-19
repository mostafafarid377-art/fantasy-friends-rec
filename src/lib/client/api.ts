"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";

export type SessionUser = {
  id: string;
  email: string;
  username: string;
  displayName: string;
  avatarUrl: string | null;
  bio: string | null;
  emailVerified: boolean;
  createdAt: string;
};

export type SessionLeague = {
  id: string;
  name: string;
  format: "5v5" | "7v7";
  starters: number;
  subsCount: number;
  inviteCode: string;
  role: "leader" | "manager" | "organizer";
  teamName: string | null;
  rank: number | null;
  totalPoints: string | null;
};

export type SessionPayload = {
  user: SessionUser | null;
  leagues: SessionLeague[];
  unread: number;
};

export class ApiRequestError extends Error {
  status: number;
  details: unknown;
  constructor(message: string, status: number, details?: unknown) {
    super(message);
    this.status = status;
    this.details = details;
  }
}

export function newOperationId(): string {
  const c = globalThis.crypto;
  if (c && "randomUUID" in c) return c.randomUUID();
  return `op-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}

export type HttpMethod = "GET" | "POST" | "PUT" | "PATCH" | "DELETE";

type QueueItem = {
  operationId: string;
  route: string;
  method: HttpMethod;
  payload: unknown;
  createdAt: string;
};

const QUEUE_KEY = "ff.pending.ops";

function readQueue(): QueueItem[] {
  if (typeof window === "undefined") return [];
  try {
    const raw = window.localStorage.getItem(QUEUE_KEY);
    return raw ? (JSON.parse(raw) as QueueItem[]) : [];
  } catch {
    return [];
  }
}

function writeQueue(items: QueueItem[]) {
  try {
    window.localStorage.setItem(QUEUE_KEY, JSON.stringify(items.slice(-25)));
  } catch {
    /* storage unavailable — retries simply won't persist */
  }
}

/**
 * Fetch wrapper with idempotent mutation support.
 *
 * `mutate()` sends a stable operation id, queues the request locally until
 * the server confirms, and on retry reuses the SAME id and payload. A
 * "read verification" failure after a confirmed write never re-sends the
 * request — the queue only drops an item once the server has acknowledged.
 */
export async function api<T = unknown>(
  route: string,
  options: {
    method?: HttpMethod;
    body?: unknown;
    signal?: AbortSignal;
    idempotent?: boolean;
    operationId?: string;
  } = {},
): Promise<T> {
  const method = options.method ?? "GET";
  const operationId = options.idempotent ? (options.operationId ?? newOperationId()) : undefined;

  if (operationId && options.body !== undefined) {
    const queue = readQueue();
    queue.push({
      operationId,
      route,
      method,
      payload: options.body,
      createdAt: new Date().toISOString(),
    });
    writeQueue(queue);
  }

  let response: Response;
  try {
    response = await fetch(route, {
      method,
      headers: {
        "Content-Type": "application/json",
        ...(operationId ? { "x-operation-id": operationId } : {}),
      },
      body: options.body !== undefined ? JSON.stringify(options.body) : undefined,
      credentials: "same-origin",
      signal: options.signal,
    });
  } catch (err) {
    // Network failure: the operation stays queued for recovery.
    if (operationId) {
      // keep it queued
    }
    throw new ApiRequestError(
      navigator.onLine
        ? "The server could not be reached. Your change is saved and will retry."
        : "You are offline. Your change is saved and will retry when you reconnect.",
      0,
      err,
    );
  }

  const text = await response.text();
  const data: unknown = text ? JSON.parse(text) : {};

  if (!response.ok) {
    const message =
      data && typeof data === "object" && "error" in data
        ? String((data as { error: unknown }).error)
        : "Request failed";
    const error = new ApiRequestError(message, response.status, data);
    if (operationId && response.status !== 409) {
      // permanent failure — stop retrying this payload
      writeQueue(readQueue().filter((q) => q.operationId !== operationId));
    }
    throw error;
  }

  if (operationId) {
    writeQueue(readQueue().filter((q) => q.operationId !== operationId));
  }
  return data as T;
}

/** Re-sends anything still queued from a previous session or a crash. */
export async function recoverPendingOperations(): Promise<number> {
  const queue = readQueue();
  if (!queue.length) return 0;
  let recovered = 0;
  for (const item of queue) {
    try {
      await api(item.route, {
        method: item.method,
        body: item.payload,
        idempotent: true,
        operationId: item.operationId,
      });
      recovered++;
      writeQueue(readQueue().filter((q) => q.operationId !== item.operationId));
    } catch (err) {
      if (err instanceof ApiRequestError && err.status === 409) {
        // id already applied or in flight — drop it, never double-write
        writeQueue(readQueue().filter((q) => q.operationId !== item.operationId));
      }
      break; // still failing: stop and keep the rest for the next attempt
    }
  }
  return recovered;
}

export function pendingCount(): number {
  return readQueue().length;
}

/* ------------------------------------------------------------------ */
/* Hooks                                                               */
/* ------------------------------------------------------------------ */

export function useSession() {
  const [data, setData] = useState<SessionPayload | null>(null);
  const [loading, setLoading] = useState(true);
  const router = useRouter();

  const refresh = useCallback(async () => {
    try {
      const res = await api<SessionPayload>("/api/auth/session");
      setData(res);
      return res;
    } catch {
      setData({ user: null, leagues: [], unread: 0 });
      return null;
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const logout = useCallback(async () => {
    await api("/api/auth/logout", { method: "POST" });
    setData({ user: null, leagues: [], unread: 0 });
    router.push("/login");
  }, [router]);

  return { ...data, loading, refresh, logout };
}

export function useApi<T>(
  route: string | null,
  deps: unknown[] = [],
  options: { refreshKey?: number } = {},
) {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(Boolean(route));
  const abortRef = useRef<AbortController | null>(null);

  const load = useCallback(async () => {
    if (!route) return;
    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;
    setLoading(true);
    setError(null);
    try {
      const res = await api<T>(route, { signal: controller.signal });
      setData(res);
    } catch (err) {
      if (err instanceof DOMException && err.name === "AbortError") return;
      setError(err instanceof Error ? err.message : "Could not load");
    } finally {
      setLoading(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [route, ...deps, options.refreshKey]);

  useEffect(() => {
    void load();
    return () => abortRef.current?.abort();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [load]);

  return { data, error, loading, reload: load, setData };
}
