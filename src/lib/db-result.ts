export class ApiError extends Error {
  constructor(message: string, public status = 400, public details?: unknown) {
    super(message);
  }
}

type DbError = { code: string; message: string; details?: string | null; hint?: string | null };

export function checkDb(error: DbError | null, action: string): void {
  if (!error) return;
  const status = ({ '42501': 403, '23505': 409, '23503': 422, '23514': 422,
    '22023': 422, 'P0001': 409, 'P0002': 404, '40001': 409 } as Record<string, number>)[error.code] ?? 500;
  if (status >= 500) console.error('[database]', action, error);
  // Don't expose constraint values, internal relation names, or raw server errors.
  const reason = ({ '42501': 'permission denied', '23505': 'a conflicting record already exists',
    '23503': 'a related record no longer exists', '23514': 'a field failed database validation',
    '40001': 'the record changed; reload and try again' } as Record<string, string>)[error.code];
  throw new ApiError(`${action}: ${reason ?? (status < 500 ? error.message : `database request failed${error.code ? ` (${error.code})` : ''}`)}`, status);
}

export function confirmedRow<T extends { id: string; league_id?: string }>(
  data: T | null, error: DbError | null, action: string, leagueId?: string,
): T {
  checkDb(error, action);
  if (!data?.id || (leagueId !== undefined && data.league_id !== leagueId)) {
    throw new ApiError(`${action}: no matching record was confirmed`, 409);
  }
  return data;
}
