import { useCallback, useEffect, useRef, useState } from 'react';
import type { ReadResult } from '../ports/securityDataReader';

export type AsyncState<T> =
  | { readonly phase: 'idle' }
  | { readonly phase: 'loading' }
  | { readonly phase: 'done'; readonly result: ReadResult<T> };

/**
 * Runs a read and keeps only the latest response: host calls cannot be cancelled, so a stale answer
 * (older request id) is ignored instead of overwriting newer state.
 */
export function useReadResult<T>(load: (() => Promise<ReadResult<T>>) | null, key: string): { state: AsyncState<T>; retry: () => void; refresh: () => void; refreshing: boolean } {
  const [state, setState] = useState<AsyncState<T>>({ phase: 'idle' });
  const [attempt, setAttempt] = useState(0);
  const [refreshing, setRefreshing] = useState(false);
  const latest = useRef(0);
  // A refresh reads again but keeps what is on screen until the new answer arrives (retry and a new key show the loading state, as before).
  const keepShown = useRef(false);

  useEffect(() => {
    if (!load) {
      setState({ phase: 'idle' });
      return;
    }
    const id = ++latest.current;
    const keep = keepShown.current;
    keepShown.current = false;
    if (keep) setRefreshing(true);
    else {
      setRefreshing(false);
      setState({ phase: 'loading' });
    }
    load().then(
      (result) => {
        if (id === latest.current) {
          setState({ phase: 'done', result });
          setRefreshing(false);
        }
      },
      () => {
        if (id === latest.current) {
          setState({ phase: 'done', result: { status: 'error', errorClass: 'unknown', message: 'The read failed unexpectedly.' } });
          setRefreshing(false);
        }
      },
    );
    // `key` identifies the request (reader + table); `load` is recreated on every render by design.
  }, [key, attempt]);

  const retry = useCallback(() => setAttempt((n) => n + 1), []);
  const refresh = useCallback(() => {
    keepShown.current = true;
    setAttempt((n) => n + 1);
  }, []);
  return { state, retry, refresh, refreshing };
}
