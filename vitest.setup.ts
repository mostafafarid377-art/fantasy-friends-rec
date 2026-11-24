// Next.js server modules (responses, session helpers, and the console
// interception paths its testing utilities load) expect AsyncLocalStorage to
// exist as a global, the way the Next.js server runtime provides it. Plain
// Node only exposes it through node:async_hooks, so tests polyfill the global
// once for the whole suite. Without it, Next falls back to a stub storage
// whose methods throw `Invariant: AsyncLocalStorage accessed in runtime where
// it is not available` the first time a route handler logs during a test.
import { AsyncLocalStorage } from "node:async_hooks";

if (!globalThis.AsyncLocalStorage) {
  (globalThis as Record<string, unknown>).AsyncLocalStorage = AsyncLocalStorage;
}
