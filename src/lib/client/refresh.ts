"use client";

import { useEffect, useRef } from "react";

/**
 * One refresh coordinator for the whole app.
 *
 * Pages used to attach their own `focus` listener and their own polling
 * timer, so a single tab switch could trigger the same request several times
 * from different places. Everything now subscribes here: the app installs a
 * single `focus`/`visibilitychange` listener and runs a single poll timer, and
 * each subscriber decides what to refresh.
 */

type Subscriber = {
  id: number;
  run: () => void;
  pollMs: number;
  lastRun: number;
  lastPoll: number;
};

const subscribers = new Map<number, Subscriber>();
let nextId = 1;
let listening = false;
let timer: ReturnType<typeof setTimeout> | null = null;

/**
 * A refresh that just ran is still fresh. A focus event that lands right
 * after a poll tick must not repeat the same request.
 */
export const REFRESH_FRESHNESS_MS = 1000;

function isVisible() {
  return typeof document === "undefined" || document.visibilityState === "visible";
}

function fire(subscriber: Subscriber) {
  try {
    subscriber.run();
  } catch (error) {
    console.warn("[refresh]", error);
  }
}

/** The tab became active again: refresh everything that asked for it. */
function wake() {
  if (!isVisible()) return;
  const now = Date.now();
  for (const subscriber of [...subscribers.values()]) {
    if (subscriber.lastRun && now - subscriber.lastRun < REFRESH_FRESHNESS_MS) continue;
    subscriber.lastRun = now;
    fire(subscriber);
  }
}

/** Refresh the subscribers whose polling interval has elapsed. */
function poll() {
  if (!isVisible()) return;
  const now = Date.now();
  for (const subscriber of [...subscribers.values()]) {
    if (!subscriber.pollMs) continue;
    if (now - subscriber.lastPoll < subscriber.pollMs) continue;
    subscriber.lastPoll = now;
    subscriber.lastRun = now;
    fire(subscriber);
  }
}

/** Arms a single timer for the next poll that is due. */
function schedule() {
  if (timer) {
    clearTimeout(timer);
    timer = null;
  }  if (typeof window === "undefined") return;
  const now = Date.now();
  let next = Infinity;
  for (const subscriber of subscribers.values()) {
    if (!subscriber.pollMs) continue;
    next = Math.min(next, subscriber.lastPoll + subscriber.pollMs);
  }
  if (next === Infinity) return;
  const delay = Math.max(0, Math.min(next - now, 60_000));
  timer = setTimeout(() => {
    timer = null;
    poll();
    schedule();
  }, delay);
}

function ensureListening() {
  if (listening || typeof window === "undefined") return;
  listening = true;
  window.addEventListener("focus", wake);
  document.addEventListener("visibilitychange", wake);
}

function release() {
  if (subscribers.size > 0 || !listening) return;
  listening = false;
  window.removeEventListener("focus", wake);
  document.removeEventListener("visibilitychange", wake);
}

/**
 * Disarms the shared timer and drops every subscriber. Called on sign-out so
 * no authenticated read (poll tick or focus refresh) can fire in the window
 * between the session cookies being cleared and the signed-in tree
 * unmounting — such a request would correctly fail with a 401, and a client
 * that knows it signed out should not issue it at all.
 */
export function stopAppRefreshes() {
  subscribers.clear();
  if (timer) {
    clearTimeout(timer);
    timer = null;
  }
  release();
}

/**
 * Runs `run` when the tab regains focus and, when `pollMs` is set, on a
 * timer. `enabled` lets a page opt out until it has something to refresh.
 */
export function useAppRefresh(run: () => void, options: { pollMs?: number; enabled?: boolean } = {}) {
  const { pollMs = 0, enabled = true } = options;
  const runRef = useRef(run);
  useEffect(() => { runRef.current = run; }, [run]);

  useEffect(() => {
    if (!enabled) return;
    const id = nextId++;
    subscribers.set(id, { id, run: () => runRef.current(), pollMs, lastRun: 0, lastPoll: Date.now() });
    ensureListening();
    schedule();
    return () => {
      subscribers.delete(id);
      release();
      schedule();
    };
  }, [pollMs, enabled]);
}
