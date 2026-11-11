import type { ApprovedPlan, OperationResult } from '../../domain/operations';
import {
  beginOperation,
  endOperation,
  markStepStarted,
  recordStepResult,
  type BeginOptions,
  type StepResultOptions,
} from '../../domain/history/record';
import type { OperationRecord } from '../../domain/history/types';
import type { OperationStore } from '../../ports/operationStore';

// Operations this page is running right now. Anything unfinished in storage and not in here was interrupted.
const active = new Set<string>();
export function isOperationActive(operationId: string): boolean {
  return active.has(operationId);
}
/** True while this page runs any write operation (the connection watcher must not tear the screens down under it). */
export function hasActiveOperations(): boolean {
  return active.size > 0;
}

const listeners = new Set<() => void>();
/** Called after every saved ledger change, so a visible history can refresh itself. Returns the unsubscribe function. */
export function onLedgerChange(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}
function notifyLedgerChange(): void {
  for (const l of [...listeners]) {
    try {
      l();
    } catch {
      // a listener must not break the ledger
    }
  }
}

/** The ledger could not be written. Like the XrmToolBox tool, a write must not start when its intent cannot be recorded. */
export class HistoryUnavailableError extends Error {
  readonly failure = 'history' as const;
  constructor() {
    super('The operation history could not be written, so nothing was sent.');
    this.name = 'HistoryUnavailableError';
  }
}

/**
 * Keeps the ledger of write operations. Order: `begin` (intent made durable, rejects when it cannot be) -> `stepStarted` ->
 * `stepResult` per step -> `end`. After the write has happened a failed save is remembered in `lastSaveError` instead of throwing,
 * because the write cannot be taken back.
 */
export class OperationRecorder {
  private readonly open = new Map<string, OperationRecord>();
  private queue: Promise<void> = Promise.resolve();
  lastSaveError: string | null = null;

  constructor(
    private readonly store: OperationStore,
    private readonly now: () => number = () => Date.now(),
  ) {}

  async begin(approval: ApprovedPlan, options: BeginOptions = {}): Promise<OperationRecord> {
    const record = beginOperation(approval, this.now(), options);
    // Registered BEFORE the first save: saving notifies the visible history, which reads the ledger and must not see this operation as
    // interrupted (an unfinished record that this session is not running).
    this.open.set(record.operationId, record);
    active.add(record.operationId);
    try {
      await this.save(record);
    } catch {
      this.open.delete(record.operationId);
      active.delete(record.operationId);
      throw new HistoryUnavailableError();
    }
    return record;
  }

  stepStarted(operationId: string, key: string): Promise<OperationRecord> {
    return this.update(operationId, (r) => markStepStarted(r, key, this.now()));
  }

  stepResult(operationId: string, key: string, result: OperationResult, options: StepResultOptions = {}): Promise<OperationRecord> {
    return this.update(operationId, (r) => recordStepResult(r, key, result, this.now(), options));
  }

  async end(operationId: string): Promise<OperationRecord> {
    const record = await this.update(operationId, (r) => endOperation(r, this.now()));
    this.open.delete(operationId);
    active.delete(operationId);
    return record;
  }

  private async update(operationId: string, change: (r: OperationRecord) => OperationRecord): Promise<OperationRecord> {
    const current = this.open.get(operationId);
    if (!current) throw new Error('This operation is not open in the ledger.');
    const next = change(current);
    this.open.set(operationId, next);
    try {
      await this.save(next);
      this.lastSaveError = null;
    } catch (e) {
      this.lastSaveError = e instanceof Error ? e.message : 'The history could not be saved.';
    }
    return next;
  }

  // One save at a time, in order, so a slow store cannot let an older state overwrite a newer one.
  private save(record: OperationRecord): Promise<void> {
    const run = this.queue.then(() => this.store.put(record)).then(() => notifyLedgerChange());
    this.queue = run.catch(() => undefined);
    return run;
  }
}
