import { MemoryOperationStore } from '../application/operations/memoryOperationStore';
import { OperationRecorder } from '../application/operations/recorder';
import type { OperationRecord } from '../domain/history/types';
import type { OperationStore } from '../ports/operationStore';

/** A recorder over an in-memory ledger (synthetic; no host). `records()` reads what the ledger holds right now. */
export function testLedger(now = 5_000) {
  const store = new MemoryOperationStore();
  const recorder = new OperationRecorder(store, () => now);
  return { store, recorder, records: async (): Promise<readonly OperationRecord[]> => (await store.list()).records };
}

/** A ledger store whose `put` rejects once `okPuts` saves have succeeded (0 = it can never write; 1 = only the intent is saved). */
export function flakyStore(okPuts: number): OperationStore & { readonly attempts: () => number } {
  const inner = new MemoryOperationStore();
  let puts = 0;
  return {
    info: inner.info,
    list: () => inner.list(),
    clear: () => inner.clear(),
    attempts: () => puts,
    put: (record) => {
      puts += 1;
      return puts > okPuts ? Promise.reject(new Error('storage unavailable')) : inner.put(record);
    },
  };
}
