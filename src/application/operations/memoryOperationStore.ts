import type { OperationRecord } from '../../domain/history/types';
import type { OperationStore, OperationStoreInfo } from '../../ports/operationStore';

export const SESSION_ONLY_NOTICE = 'Kept for this session only. Export the history (JSON or CSV) to keep it.';

/** In-memory ledger: honest about being temporary. Also the fallback when the host offers no settings storage. */
export class MemoryOperationStore implements OperationStore {
  readonly info: OperationStoreInfo = { kind: 'session', notice: SESSION_ONLY_NOTICE };
  private readonly byId = new Map<string, OperationRecord>();

  list(): Promise<{ readonly records: readonly OperationRecord[]; readonly dropped: number }> {
    return Promise.resolve({ records: [...this.byId.values()], dropped: 0 });
  }

  put(record: OperationRecord): Promise<void> {
    this.byId.set(record.operationId, record);
    return Promise.resolve();
  }

  clear(): Promise<void> {
    this.byId.clear();
    return Promise.resolve();
  }
}
