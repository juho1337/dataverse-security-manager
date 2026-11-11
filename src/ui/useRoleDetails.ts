import { useCallback, useEffect, useRef, useState } from 'react';
import type { RoleFamily } from '../domain/access';
import type { ReadResult, SecurityDataReader } from '../ports/securityDataReader';

export type DetailState = { readonly phase: 'loading' } | { readonly phase: 'done'; readonly result: ReadResult<RoleFamily> };

/**
 * Lazily loads the details (Business Unit instances, direct users, teams, members) of one logical role per call.
 * Host calls cannot be cancelled, so every request carries a token per role and a stale answer is dropped; an answer
 * that arrives after the table changed (the owning component unmounted) is dropped as well.
 */
export function useRoleDetails(reader: SecurityDataReader, table: string) {
  const [states, setStates] = useState<Readonly<Record<string, DetailState>>>({});
  const tokens = useRef<Record<string, number>>({});
  const started = useRef(new Set<string>());
  const alive = useRef(true);

  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);

  const run = useCallback(
    (rootRoleId: string, onDone?: () => void) => {
      const token = (tokens.current[rootRoleId] ?? 0) + 1;
      tokens.current[rootRoleId] = token;
      started.current.add(rootRoleId);
      setStates((s) => ({ ...s, [rootRoleId]: { phase: 'loading' } }));
      const settle = (result: ReadResult<RoleFamily>) => {
        if (alive.current && tokens.current[rootRoleId] === token) setStates((s) => ({ ...s, [rootRoleId]: { phase: 'done', result } }));
        onDone?.();
      };
      reader.loadRoleDetails(table, rootRoleId).then(settle, () =>
        settle({ status: 'error', errorClass: 'unknown', message: 'The read failed unexpectedly.' }),
      );
    },
    [reader, table],
  );

  /** Loads once per role; collapsing and expanding again does not reload. */
  const ensure = useCallback(
    (rootRoleId: string) => {
      if (!started.current.has(rootRoleId)) run(rootRoleId);
    },
    [run],
  );

  // Bulk loading (the holder / Business Unit filter needs every candidate role's assignments): a few reads at a time, never all at once.
  const queue = useRef<string[]>([]);
  const inflight = useRef(0);
  const pump = useRef<() => void>(() => undefined);
  pump.current = () => {
    while (alive.current && inflight.current < BULK_CONCURRENCY && queue.current.length > 0) {
      const id = queue.current.shift()!;
      if (started.current.has(id)) continue;
      inflight.current++;
      run(id, () => {
        inflight.current--;
        pump.current();
      });
    }
  };
  /** Queues the roles that were not loaded yet; at most `BULK_LIMIT` per call. Returns how many were queued. */
  const ensureMany = useCallback((rootRoleIds: readonly string[]): number => {
    const fresh = rootRoleIds.filter((id) => !started.current.has(id) && !queue.current.includes(id)).slice(0, BULK_LIMIT);
    queue.current.push(...fresh);
    pump.current();
    return fresh.length;
  }, []);

  // Where the next re-read batch starts, so that repeated clicks cover a list longer than BULK_LIMIT instead of re-reading its first part again.
  const refreshCursor = useRef(0);
  /**
   * Reads the given roles AGAIN (the same few at a time), also those that were loaded before: the "Refresh users" button. At most `BULK_LIMIT`
   * per call; with a longer list each click continues where the previous one stopped (and wraps around). A role keeps its old answer on screen
   * until its own read starts. Returns how many were queued.
   */
  const refreshMany = useCallback((rootRoleIds: readonly string[]): number => {
    const all = [...new Set(rootRoleIds)];
    if (all.length === 0) return 0;
    const start = refreshCursor.current % all.length;
    const window = [...all.slice(start), ...all.slice(0, start)].slice(0, BULK_LIMIT);
    refreshCursor.current = (start + window.length) % all.length;
    const fresh = window.filter((id) => !queue.current.includes(id));
    for (const id of fresh) started.current.delete(id);
    queue.current.push(...fresh);
    pump.current();
    return fresh.length;
  }, []);

  return { states, ensure, ensureMany, refreshMany, retry: run };
}

const BULK_CONCURRENCY = 4;
/** One click loads at most this many roles' assignments (each is several Dataverse reads). */
export const BULK_LIMIT = 150;
