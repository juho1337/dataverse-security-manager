import { newestFirst } from '../../domain/history/record';
import { parseOperationRecords } from '../../domain/history/parse';
import type { OperationRecord } from '../../domain/history/types';
import type { OperationStore, OperationStoreInfo } from '../../ports/operationStore';

// Operation ledger in the PPTB host's per-tool settings (`window.toolboxAPI.settings`, documented in @pptb/types 1.2.7: getAll, get,
// set, setAll; "any JSON-serializable value"). UNVERIFIED on a real host: that the values survive restarts, size limits, whether
// several open instances share the key. Therefore the UI says so and offers export.

/** The part of `toolboxAPI.settings` used here (structural, so tests can fake it). */
export interface HostSettings {
  readonly get: (key: string) => Promise<unknown>;
  readonly set: (key: string, value: unknown) => Promise<void>;
}

export const HOST_STORE_KEY = 'operationHistory.v1';
/** Oldest operations are dropped beyond this, to keep the stored value small. Export keeps what the UI shows. */
export const MAX_STORED_OPERATIONS = 200;

export const HOST_STORE_NOTICE =
  'Saved in the Toolbox settings for this tool (host storage; how long it lasts and its size limits are not verified). Export the history to keep a copy.';

/** The settings API of the host, or null when it is not there (plain browser, tests, older host). */
export function hostSettingsOf(host: unknown): HostSettings | null {
  const api = (host as { toolboxAPI?: { settings?: Partial<HostSettings> } } | undefined)?.toolboxAPI?.settings;
  return api && typeof api.get === 'function' && typeof api.set === 'function' ? { get: api.get.bind(api), set: api.set.bind(api) } : null;
}

export class HostOperationStore implements OperationStore {
  readonly info: OperationStoreInfo = { kind: 'host', notice: HOST_STORE_NOTICE };
  private queue: Promise<unknown> = Promise.resolve();

  constructor(private readonly settings: HostSettings) {}

  async list(): Promise<{ readonly records: readonly OperationRecord[]; readonly dropped: number }> {
    return parseOperationRecords(await this.settings.get(HOST_STORE_KEY));
  }

  put(record: OperationRecord): Promise<void> {
    return this.serial(async () => {
      const { records } = await this.list();
      const merged = [...records.filter((r) => r.operationId !== record.operationId), record];
      await this.settings.set(HOST_STORE_KEY, newestFirst(merged).slice(0, MAX_STORED_OPERATIONS));
    });
  }

  clear(): Promise<void> {
    return this.serial(() => this.settings.set(HOST_STORE_KEY, []));
  }

  // Read-modify-write must not interleave with itself.
  private serial(work: () => Promise<void>): Promise<void> {
    const run = this.queue.then(work);
    this.queue = run.catch(() => undefined);
    return run;
  }
}
