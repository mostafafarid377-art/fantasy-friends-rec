/**
 * A PostgREST-level instrumented Supabase client.
 *
 * Every `from(...)` chain and every `rpc(...)` call becomes exactly one HTTP
 * request to PostgREST, so counting them counts the database round trips a
 * route performs. The harness also records the order in which requests are
 * dispatched and resolved, which is what makes a sequential waterfall
 * (a read that only starts after an earlier read has already answered)
 * detectable instead of invisible.
 */

export type ReadKind = "table" | "rpc";

export type ReadEvent = { kind: ReadKind; name: string; dispatchedAt: number; resolvedAt: number };

export type ClientFixture = {
  /** Rows returned by `from(table)` when the builder is not a `maybeSingle`. */
  tables?: Record<string, unknown>;
  /** Rows returned by `from(table)` when the builder ends in `maybeSingle`. */
  singles?: Record<string, unknown>;
  /** Rows returned by `rpc(name)`. */
  rpcs?: Record<string, unknown>;
  /** PostgREST row count reported for a table read. */
  counts?: Record<string, number>;
};

export type InstrumentedClient = {
  client: any;
  reads: ReadEvent[];
  /** Reads dispatched in the same wave, i.e. without waiting for an earlier read. */
  waves: number[][];
  reset(): void;
};

const chainMethods = [
  "select", "eq", "neq", "in", "or", "order", "limit", "range", "gte", "lte", "gt", "lt",
  "is", "not", "filter", "single", "maybeSingle", "upsert", "insert", "update", "delete",
  "match", "contains", "overlaps", "textSearch", "not",
];

export function createInstrumentedClient(fixture: ClientFixture): InstrumentedClient {
  const reads: ReadEvent[] = [];
  let clock = 0;

  /** PostgREST returns one row for a `maybeSingle` read of a set-returning RPC. */
  function singleRow(value: unknown) {
    if (Array.isArray(value)) return value[0] ?? null;
    return value ?? null;
  }

  function makeBuilder(kind: ReadKind, name: string) {
    let single = false;
    const builder: Record<string, unknown> = {};
    for (const method of chainMethods) {
      builder[method] = () => {
        if (method === "maybeSingle" || method === "single") single = true;
        return builder;
      };
    }
    builder.then = (onFulfilled: (value: unknown) => unknown, onRejected?: (reason: unknown) => unknown) => {
      const dispatchedAt = clock++;
      const event: ReadEvent = { kind, name, dispatchedAt, resolvedAt: -1 };
      reads.push(event);
      const payload = kind === "table"
        ? {
          data: single
            ? (fixture.singles?.[name] ?? fixture.tables?.[name] ?? null)
            : (fixture.tables?.[name] ?? []),
          error: null,
          count: fixture.counts?.[name],
        }
        : { data: single ? singleRow(fixture.rpcs?.[name]) : (fixture.rpcs?.[name] ?? []), error: null };
      return Promise.resolve()
        .then(() => { event.resolvedAt = clock++; return payload; })
        .then(onFulfilled, onRejected);
    };
    return builder;
  }

  const client = {
    from: (table: string) => makeBuilder("table", table),
    rpc: (fn: string) => makeBuilder("rpc", fn),
    auth: {
      getClaims: async () => ({ data: { claims: { sub: "me", email: "me@example.test" } }, error: null }),
      getUser: async () => ({ data: { user: { id: "me", email: "me@example.test" } }, error: null }),
    },
  };

  function waves() {
    const result: number[][] = [];
    for (const read of reads) {
      const last = result[result.length - 1];
      if (last && read.dispatchedAt > last[last.length - 1]) result.push([]);
      (result[result.length - 1] ?? (result.push([]), result[result.length - 1])).push(read.dispatchedAt);
    }
    return result;
  }

  return {
    client,
    reads,
    get waves() { return waves(); },
    reset() { reads.length = 0; clock = 0; },
  } as InstrumentedClient;
}

/** Names of the reads, in dispatch order. */
export function readNames(reads: ReadEvent[]) {
  return reads.map((r) => `${r.kind}:${r.name}`);
}

/**
 * True when every read in `names` was dispatched before the first of them
 * answered, i.e. they ran concurrently instead of as a waterfall.
 *
 * When a name was read more than once the last occurrence counts: that is the
 * read that belongs to the batch under test.
 */
export function dispatchedTogether(reads: ReadEvent[], names: string[]) {
  const group = names.map((name) => {
    const matches = reads.filter((r) => `${r.kind}:${r.name}` === name);
    return matches[matches.length - 1];
  });
  if (group.some((r) => !r)) return false;
  const lastDispatch = Math.max(...group.map((r) => r.dispatchedAt));
  const firstResolve = Math.min(...group.map((r) => r.resolvedAt));
  return lastDispatch < firstResolve;
}
