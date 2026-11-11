import { describe, expect, it } from 'vitest';
import { HostOperationStore, hostSettingsOf, HOST_STORE_KEY, MAX_STORED_OPERATIONS, type HostSettings } from '../../adapters/pptb/operationStoreHost';
import { approvePlan, createWritePlan, plannedWrite } from '../../domain/operations';
import { beginOperation, deriveStatus, reconcileAbandoned } from '../../domain/history/record';
import type { OperationRecord } from '../../domain/history/types';
import type { OperationStore } from '../../ports/operationStore';
import { MemoryOperationStore } from './memoryOperationStore';
import { flakyStore } from '../../test/ledger';
import { HistoryUnavailableError, isOperationActive, OperationRecorder, onLedgerChange } from './recorder';

const U = '22222222-2222-2222-2222-222222222222';
const R = '11111111-1111-1111-1111-111111111111';

function approval(id: string) {
  return approvePlan(createWritePlan([plannedWrite.assignRole(U, R, 'Assign')]), 'env-1', 'ann', 1, { operationId: id });
}

function fakeSettings(): HostSettings & { data: Map<string, unknown> } {
  const data = new Map<string, unknown>();
  return { data, get: (k) => Promise.resolve(structuredClone(data.get(k))), set: (k, v) => (data.set(k, structuredClone(v)), Promise.resolve()) };
}

describe('OperationRecorder', () => {
  it('records begin, result and end, and only marks success when verified', async () => {
    const store = new MemoryOperationStore();
    let t = 100;
    const rec = new OperationRecorder(store, () => t++);
    const op = await rec.begin(approval('o1'), { serverCorrelationId: 'srv' });
    const key = op.steps[0]!.key;
    await rec.stepStarted('o1', key);
    await rec.stepResult('o1', key, { outcome: 'succeeded', message: 'ok', failure: 'none' });
    const done = await rec.end('o1');
    expect(done.steps[0]).toMatchObject({ outcome: 'notVerified', verified: false });
    const stored = (await store.list()).records[0]!;
    expect(stored.endedAtMs).toBeDefined();
    expect(stored.serverCorrelationId).toBe('srv');
  });

  it('does not start when the intent cannot be recorded', async () => {
    const broken: OperationStore = { ...new MemoryOperationStore(), info: { kind: 'session', notice: '' }, list: () => Promise.reject(new Error('x')), put: () => Promise.reject(new Error('disk')), clear: () => Promise.resolve() };
    await expect(new OperationRecorder(broken).begin(approval('o2'))).rejects.toBeInstanceOf(HistoryUnavailableError);
  });

  it('keeps going after the write when a later save fails, and says so', async () => {
    const mem = new MemoryOperationStore();
    let fail = false;
    const flaky: OperationStore = { info: mem.info, list: () => mem.list(), clear: () => mem.clear(), put: (r) => (fail ? Promise.reject(new Error('full')) : mem.put(r)) };
    const rec = new OperationRecorder(flaky);
    const op = await rec.begin(approval('o3'));
    fail = true;
    await rec.stepResult('o3', op.steps[0]!.key, { outcome: 'failed', message: 'm', failure: 'execution' });
    expect(rec.lastSaveError).toBe('full');
  });

  it('rejects updates for an operation that is not open', async () => {
    await expect(new OperationRecorder(new MemoryOperationStore()).end('nope')).rejects.toThrow();
  });
});

describe('stores', () => {
  it('memory store says it is temporary', () => {
    expect(new MemoryOperationStore().info).toMatchObject({ kind: 'session' });
    expect(new MemoryOperationStore().info.notice).toContain('session only');
  });

  it('host store persists through toolboxAPI.settings, upserts and caps the size', async () => {
    const settings = fakeSettings();
    const store = new HostOperationStore(settings);
    const a = beginOperation(approval('a'), 10);
    await store.put(a);
    await store.put({ ...a, endedAtMs: 20 });
    expect((await store.list()).records).toHaveLength(1);
    expect((await store.list()).records[0]!.endedAtMs).toBe(20);
    const many: OperationRecord[] = Array.from({ length: MAX_STORED_OPERATIONS + 5 }, (_, i) => beginOperation(approval(`m${i}`), 1000 + i));
    await Promise.all(many.map((m) => store.put(m)));
    const { records } = await store.list();
    expect(records).toHaveLength(MAX_STORED_OPERATIONS);
    expect(records.some((r) => r.operationId === 'a')).toBe(false);
    await store.clear();
    expect((await store.list()).records).toEqual([]);
  });

  it('host store reports unreadable entries instead of hiding the rest', async () => {
    const settings = fakeSettings();
    settings.data.set(HOST_STORE_KEY, [beginOperation(approval('ok'), 1), { broken: true }]);
    expect(await new HostOperationStore(settings).list()).toMatchObject({ dropped: 1, records: [{ operationId: 'ok' }] });
  });

  it('detects the host settings API only when get and set exist', () => {
    expect(hostSettingsOf(undefined)).toBeNull();
    expect(hostSettingsOf({ toolboxAPI: {} })).toBeNull();
    expect(hostSettingsOf({ toolboxAPI: { settings: { get: () => Promise.resolve(1) } } })).toBeNull();
    expect(hostSettingsOf({ toolboxAPI: { settings: fakeSettings() } })).not.toBeNull();
  });
});

describe('a freshly begun operation is running, not interrupted', () => {
  it('the visible history, refreshed by the intent save itself, shows it as in progress', async () => {
    const store = new MemoryOperationStore();
    const recorder = new OperationRecorder(store);
    const seen: string[] = [];
    const off = onLedgerChange(() => {
      void store.list().then((r) => {
        for (const rec of reconcileAbandoned(r.records, isOperationActive)) seen.push(deriveStatus(rec));
      });
    });
    await recorder.begin(approval('fresh-1'));
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    off();
    expect(seen).toEqual(['inProgress']);
    expect(isOperationActive('fresh-1')).toBe(true);
    await recorder.end('fresh-1');
    expect(isOperationActive('fresh-1')).toBe(false);
  });

  it('an intent that could not be saved is not left registered as running', async () => {
    const recorder = new OperationRecorder(flakyStore(0));
    await expect(recorder.begin(approval('never-saved'))).rejects.toBeInstanceOf(HistoryUnavailableError);
    expect(isOperationActive('never-saved')).toBe(false);
    await expect(recorder.stepStarted('never-saved', 'x')).rejects.toThrow(/not open/);
  });
});
