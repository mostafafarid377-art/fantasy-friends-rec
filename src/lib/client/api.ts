"use client";

import { useCallback, useEffect, useRef, useState, type SetStateAction } from "react";
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

const LEGACY_QUEUE = "ff.pending.ops";
let actorId: string | null = null;
const reads = new Map<string, Promise<unknown>>();
const recovery = new Map<string, Promise<number>>();
export const RECOVERED_EVENT = "ff:operations-recovered";

export function setOperationActor(id: string | null) {
  if (actorId !== id) reads.clear();
  actorId = id;
  try { window.localStorage.removeItem(LEGACY_QUEUE); } catch { /* storage disabled */ }
}

function readQueue(actor: string): QueueItem[] {
  try {
    const raw = window.localStorage.getItem(`ff.pending.ops.v2.${actor}`);
    const items = raw ? JSON.parse(raw) : [];
    return Array.isArray(items) ? items.filter((item) => item?.method === "POST" && isReplayable(item.route)) : [];
  } catch { return []; }
}

function writeQueue(actor: string, items: QueueItem[]) {
  try { window.localStorage.setItem(`ff.pending.ops.v2.${actor}`, JSON.stringify(items.slice(-25))); }
  catch { /* storage disabled */ }
}

function isReplayable(route: unknown): route is string {
  return typeof route === "string" && /^\/api\/(?:leagues(?:\/join|\/[^/?#]+\/(?:players|teams|fixtures))?|matches(?:\/[^/?#]+\/events)?)$/.test(route);
}

type RequestOptions = {
  method?: HttpMethod;
  body?: unknown;
  signal?: AbortSignal;
  idempotent?: boolean;
  operationId?: string;
  recoveryActor?: string;
};

export async function api<T = unknown>(route: string, options: RequestOptions = {}): Promise<T> {
  const method = options.method ?? "GET";
  if (method === "GET" && !options.signal) {
    // Share only in-flight reads (no TTL or persistent cache of private data).
    const previous = reads.get(route);
    if (previous) return previous as Promise<T>;
    const request = requestJson<T>(route, options);
    reads.set(route, request);
    try { return await request; }
    finally { if (reads.get(route) === request) reads.delete(route); }
  }
  return requestJson<T>(route, options);
}

async function requestJson<T>(route: string, options: RequestOptions): Promise<T> {
  const method = options.method ?? "GET";
  const actor = options.recoveryActor ?? actorId;
  const multipart = options.body instanceof FormData ? options.body : null;
  const binary = options.body instanceof Blob ? options.body : null;
  const operationId = !multipart && !binary && options.idempotent && method === "POST" && isReplayable(route)
    ? options.operationId ?? newOperationId() : undefined;
  const queued = actor && operationId && options.body !== undefined;
  if (queued) {
    writeQueue(actor, [...readQueue(actor).filter((q) => q.operationId !== operationId), {
      operationId, route, method, payload: options.body, createdAt: new Date().toISOString(),
    }]);
  }

  let response: Response;
  try {
    response = await fetch(route, {
      method, cache: "no-store", credentials: "same-origin", signal: options.signal,
      headers: {
        ...(!multipart ? { "Content-Type": binary?.type || "application/json" } : {}),
        ...(operationId ? { "x-operation-id": operationId } : {}),
        ...(options.recoveryActor ? { "x-ff-recovery-actor": options.recoveryActor } : {}),
      },
      body: multipart ?? binary ?? (options.body === undefined ? undefined : JSON.stringify(options.body)),
    });
  } catch (err) {
    if (options.signal?.aborted) throw err;
    throw new ApiRequestError(queued
      ? "The server did not confirm the change. You can retry the pending request in Settings."
      : "The server did not confirm the request. Check your connection and reload before retrying.", 0, err);
  }

  let data: any;
  try { data = await response.json(); }
  catch { throw new ApiRequestError("The server did not return a valid response", response.status); }
  if (!response.ok || data?.state === "unknown") {
    if (queued && response.status >= 400 && response.status < 500 && response.status !== 401 && response.status !== 429) {
      writeQueue(actor, readQueue(actor).filter((q) => q.operationId !== operationId));
    }
    throw new ApiRequestError(typeof data?.error === "string" ? data.error : "The request was not confirmed",
      response.ok ? 409 : response.status, data?.details);
  }

  if (queued) writeQueue(actor, readQueue(actor).filter((q) => q.operationId !== operationId));
  if (method !== "GET") reads.clear();
  return data as T;
}

export function assertConfirmed<T extends { id: string; leagueId?: string }>(record: T | undefined | null, message: string, leagueId?: string): T {
  if (typeof record?.id !== "string" || !record.id || (leagueId !== undefined && leagueId !== record.leagueId)) {
    throw new ApiRequestError(message, 409);
  }
  return record;
}

export function recoverPendingOperations(actor: string | null = actorId): Promise<number> {
  if (!actor) return Promise.resolve(0);
  const ongoing = recovery.get(actor);
  if (ongoing) return ongoing;
  const task = (async () => {
    let recovered = 0;
    let firstError: unknown;
    for (const item of readQueue(actor)) {
      if (actor !== actorId) break;
      try {
        await api(item.route, { method: item.method, body: item.payload, idempotent: true,
          operationId: item.operationId, recoveryActor: actor });
        recovered++;
      } catch (err) { firstError = err; break; }
    }
    if (recovered) window.dispatchEvent(new Event(RECOVERED_EVENT));
    if (firstError) throw firstError;
    return recovered;
  })();
  recovery.set(actor, task);
  return task.finally(() => recovery.delete(actor));
}

export function pendingCount(): number { return actorId ? readQueue(actorId).length : 0; }

export function useSession(initial: SessionPayload) {
  const [data, setData] = useState(initial);
  const router = useRouter();
  const generation = useRef(0);
  const refresh = useCallback(async () => {
    const seq = ++generation.current;
    const result = await api<SessionPayload>("/api/auth/session");
    if (seq === generation.current) setData(result);
    return result;
  }, []);
  const logout = useCallback(async () => {
    await api("/api/auth/logout", { method: "POST" });
    generation.current++;
    setOperationActor(null);
    setData({ user: null, leagues: [], unread: 0 });
    router.replace("/login");
  }, [router]);
  const setUnread = useCallback((count: number) => setData((old) => old.unread === count ? old : { ...old, unread: count }), []);
  const forgetLeague = useCallback((id: string) => {
    generation.current++;
    setData((old) => ({ ...old, leagues: old.leagues.filter((league) => league.id !== id) }));
  }, []);
  return { ...data, refresh, logout, setUnread, forgetLeague };
}

export function useApi<T>(route: string | null, deps: unknown[] = [], options: { refreshKey?: number } = {}) {
  const [state, setState] = useState<{ route: string; data: T | null; error: string | null; loading: boolean } | null>(null);
  const generation = useRef(0);
  const active = useRef(route);
  useEffect(() => { active.current = route; }, [route]);
  const load = useCallback(async () => {
    if (!route || route !== active.current) return;
    const seq = ++generation.current;
    setState((previous) => ({ route, data: previous?.route === route ? previous.data : null, error: null, loading: true }));
    try {
      const result = await api<T>(route);
      if (seq === generation.current && active.current === route) setState({ route, data: result, error: null, loading: false });
    } catch (err) {
      if (seq === generation.current && active.current === route) {
        setState((previous) => ({ route, data: previous?.route === route ? previous.data : null,
          error: err instanceof Error ? err.message : "Could not load", loading: false }));
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [route, ...deps, options.refreshKey]);
  useEffect(() => {
    void load();
    const onRecovered = () => void load();
    window.addEventListener(RECOVERED_EVENT, onRecovered);
    return () => { generation.current++; window.removeEventListener(RECOVERED_EVENT, onRecovered); };
  }, [load]);
  const setData = useCallback((next: SetStateAction<T | null>) => {
    if (!route || route !== active.current) return;
    generation.current++;
    setState((previous) => ({ route,
      data: typeof next === "function" ? (next as (old: T | null) => T | null)(previous?.route === route ? previous.data : null) : next,
      error: null, loading: false,
    }));
  }, [route]);
  const current = state?.route === route ? state : null;
  return { data: current?.data ?? null, error: current?.error ?? null,
    loading: Boolean(route) && (current?.loading ?? true), reload: load, setData };
}
