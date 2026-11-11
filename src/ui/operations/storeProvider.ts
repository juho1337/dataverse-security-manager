import { MemoryOperationStore } from '../../application/operations/memoryOperationStore';
import { HostOperationStore, hostSettingsOf } from '../../adapters/pptb/operationStoreHost';
import { OperationRecorder } from '../../application/operations/recorder';
import type { OperationStore } from '../../ports/operationStore';

// One ledger per host (or one in-memory ledger without a host), so the module and any writer share it.

let memory: OperationStore | null = null;
const hostStores = new WeakMap<object, OperationStore>();

/** The host's settings storage when the host documents it, otherwise an in-memory ledger that says it is temporary. */
export function getOperationStore(host: unknown): OperationStore {
  const api = (host as { toolboxAPI?: object } | undefined)?.toolboxAPI;
  const settings = hostSettingsOf(host);
  if (api && settings) {
    let store = hostStores.get(api);
    if (!store) {
      store = new HostOperationStore(settings);
      hostStores.set(api, store);
    }
    return store;
  }
  memory ??= new MemoryOperationStore();
  return memory;
}

const recorders = new WeakMap<OperationStore, OperationRecorder>();

/** The recorder over the same ledger the Operations module shows, so a write and the history always meet in one place. */
export function getOperationRecorder(host: unknown): OperationRecorder {
  const store = getOperationStore(host);
  let recorder = recorders.get(store);
  if (!recorder) {
    recorder = new OperationRecorder(store);
    recorders.set(store, recorder);
  }
  return recorder;
}
