import type { OperationRecord } from '../domain/history/types';

/** Where the operation ledger lives and how long it lasts, in words the UI shows as they are. */
export interface OperationStoreInfo {
  /** `session`: lost when the tool closes. `host`: the host's per-tool settings (durability not verified). */
  readonly kind: 'session' | 'host';
  readonly notice: string;
}

/**
 * Persistence of the operation ledger. The domain never knows where records live. Implementations store only the allow-listed
 * `OperationRecord` fields and return `dropped` for stored entries they could not read.
 */
export interface OperationStore {
  readonly info: OperationStoreInfo;
  list(): Promise<{ readonly records: readonly OperationRecord[]; readonly dropped: number }>;
  /** Inserts or replaces the record with the same operation id. Rejects when it could not be stored. */
  put(record: OperationRecord): Promise<void>;
  clear(): Promise<void>;
}
