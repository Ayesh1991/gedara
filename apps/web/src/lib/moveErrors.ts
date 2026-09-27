// Move refusals (rpc_move, migration 58) → message keys. Pure, so tests can import it.

export type MoveError = 'newer' | 'moved' | 'cycle' | 'unknown' | 'denied' | 'generic';

export function moveErrorKey(e: unknown): MoveError {
  // A thrown database error carries `details`; a parked outbox op's error carries `detail`.
  const err = e as { code?: string; details?: string; detail?: string } | null;
  if (err?.code === 'GDMVC') return (err.details ?? err.detail) === 'moved' ? 'moved' : 'newer';
  if (err?.code === '23514') return 'cycle';
  if (err?.code === '23503') return 'unknown';
  if (err?.code === '42501') return 'denied';
  return 'generic';
}
