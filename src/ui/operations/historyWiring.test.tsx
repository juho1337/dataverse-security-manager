import { act, render, renderHook, screen, waitFor, within } from '@testing-library/react';
import type { ReactNode } from 'react';
import { describe, expect, it } from 'vitest';
import { MemoryOperationStore } from '../../application/operations/memoryOperationStore';
import { approvePlan, createWritePlan, plannedWrite } from '../../domain/operations';
import type { OperationRecord } from '../../domain/history/types';
import type { OperationStore } from '../../ports/operationStore';
import { OperationRecorder } from '../../application/operations/recorder';
import { beginRoleEdit, confirmAndApply } from '../../application/roleEditing/service';
import type { OperationResult } from '../../domain/operations';
import { PRIVILEGE_IDS, type CellValue, type PrivilegeCells, type PrivilegeId, type RoleMatrix, type RoleRow } from '../../domain/privileges';
import { stage, type HeldDepth } from '../../domain/roleEditing';
import type { ReadResult, SecurityDataReader } from '../../ports/securityDataReader';
import type { SecurityDataWriter } from '../../ports/securityDataWriter';
import { useRoleEditing } from '../edit/useRoleEditing';
import { OperationsModule } from './OperationsModule';
import { OperationRecorderContext } from './RecorderContext';

// A write made in this session shows up in the Operations module without a manual refresh, newest first, with honest statuses.
// Synthetic only: a fake writer and reader, an in-memory ledger.

const ROLE = '11111111-1111-1111-1111-111111111111';
const ENV = '00000000-0000-4000-8000-000000000002';
const catalog = Object.fromEntries(PRIVILEGE_IDS.map((p, i) => [p, `00000000-0000-0000-0000-${String(i + 1).padStart(12, '0')}`])) as Record<PrivilegeId, string>;

type Held = Partial<Record<PrivilegeId, HeldDepth>>;
const cellsOf = (held: Held): PrivilegeCells =>
  Object.fromEntries(PRIVILEGE_IDS.map((p) => [p, (held[p] ? { kind: 'depth', depth: held[p] } : { kind: 'noGrant' }) as CellValue])) as PrivilegeCells;
const rowOf = (held: Held): RoleRow => ({ roleId: ROLE, name: 'Test role', cells: cellsOf(held), isManaged: false, parentRootRoleId: null });
const matrixOf = (held: Held): RoleMatrix => ({ table: { logicalName: 'account', displayName: 'Account', supported: true }, roles: [rowOf(held)], privilegeCatalog: catalog });

function world(initial: Held, readFails = false) {
  const held: Held = { ...initial };
  const accepted: OperationResult = { outcome: 'notVerified', message: 'accepted', failure: 'none' };
  const writer: SecurityDataWriter = {
    addPrivilege: async (_a, _r, id, depth) => {
      held[PRIVILEGE_IDS.find((p) => catalog[p] === id) as PrivilegeId] = depth;
      return accepted;
    },
    removePrivilege: async () => accepted,
    assignRole: async () => accepted,
    unassignRole: async () => accepted,
    moveUser: async () => accepted,
  };
  const reader: SecurityDataReader = {
    listTables: async () => ({ status: 'ok', data: [] }),
    loadRoleMatrix: async (): Promise<ReadResult<RoleMatrix>> => (readFails ? { status: 'error', errorClass: 'network', message: 'down' } : { status: 'ok', data: matrixOf(held) }),
    loadRoleDetails: async () => ({ status: 'error', errorClass: 'unknown', message: 'n/a' }),
  };
  return { writer, reader, initial };
}

async function edit(recorder: OperationRecorder, w: ReturnType<typeof world>, privilege: PrivilegeId, depth: HeldDepth) {
  const start = beginRoleEdit(matrixOf(w.initial), rowOf(w.initial), false);
  if (!start.ok) throw new Error(start.reason);
  const staged = stage(start.session, privilege, depth);
  if (!staged.ok) throw new Error(staged.reason);
  return confirmAndApply({ session: staged.session, writer: w.writer, reader: w.reader, actor: 'Owner', environmentId: ENV, recorder });
}

describe('Operations shows the writes of this session', () => {
  it('lists a verified and an unverified edit newest first, without a manual refresh', async () => {
    const store = new MemoryOperationStore();
    render(<OperationsModule store={store} now={() => 9_000_000} />);
    await screen.findByText('No operations recorded yet.');

    const first = await edit(new OperationRecorder(store, () => Date.UTC(2026, 10, 3, 9)), world({ Read: 'Basic' }), 'Read', 'Local');
    const second = await edit(new OperationRecorder(store, () => Date.UTC(2026, 10, 3, 10)), world({ Read: 'Basic' }, true), 'Write', 'Basic');
    expect(first?.result.overall).toBe('succeeded');
    expect(second?.result.overall).toBe('notVerified');

    const table = await screen.findByRole('table', { name: /Recorded operations/ });
    await waitFor(() => expect(within(table).getAllByRole('row').slice(1)).toHaveLength(2));
    const rows = within(table).getAllByRole('row').slice(1);
    expect(rows[0]!.textContent).toContain(`Show ${second?.approval.operationId}`);
    expect(rows[0]!.textContent).toContain('Not verified');
    expect(rows[0]!.textContent).not.toContain('Succeeded (verified)');
    expect(rows[1]!.textContent).toContain(`Show ${first?.approval.operationId}`);
    expect(rows[1]!.textContent).toContain('Succeeded (verified)');
  });
});

describe('the screens reach the recorder of the app', () => {
  it('a confirmed edit in the Role Analyzer hook is recorded through the app recorder', async () => {
    const store = new MemoryOperationStore();
    const recorder = new OperationRecorder(store);
    const w = world({ Read: 'Basic' });
    const wrapper = ({ children }: { children: ReactNode }) => <OperationRecorderContext.Provider value={recorder}>{children}</OperationRecorderContext.Provider>;
    const { result } = renderHook(() => useRoleEditing({ reader: w.reader, writer: w.writer, actor: 'Owner', environmentId: ENV, onReload: () => undefined }), { wrapper });
    act(() => result.current.begin(matrixOf(w.initial), rowOf(w.initial), false));
    act(() => result.current.stage(ROLE, 'Read', 'Local'));
    act(() => result.current.openPreview());
    await act(async () => {
      await result.current.confirm();
    });
    const { records } = await store.list();
    expect(records).toHaveLength(1);
    expect(records[0]?.steps[0]).toMatchObject({ kind: 'addPrivilege', outcome: 'succeeded', verified: true });
  });

  it('without an app recorder the same edit still works and leaves no history', async () => {
    const store = new MemoryOperationStore();
    const w = world({ Read: 'Basic' });
    const { result } = renderHook(() => useRoleEditing({ reader: w.reader, writer: w.writer, actor: 'Owner', environmentId: ENV, onReload: () => undefined }));
    act(() => result.current.begin(matrixOf(w.initial), rowOf(w.initial), false));
    act(() => result.current.stage(ROLE, 'Read', 'Local'));
    act(() => result.current.openPreview());
    await act(async () => {
      await result.current.confirm();
    });
    expect(result.current.phase.kind).toBe('done');
    expect((await store.list()).records).toHaveLength(0);
  });
});

describe('Operations: snapshots are applied in request order', () => {
  it('a slow older snapshot that arrives after a newer one does not replace it', async () => {
    const inner = new MemoryOperationStore();
    const answers: Array<(snapshot: readonly OperationRecord[]) => void> = [];
    const store: OperationStore = {
      info: inner.info,
      put: (r) => inner.put(r),
      clear: () => inner.clear(),
      list: () => new Promise((resolve) => answers.push((records) => resolve({ records, dropped: 0 }))),
    };
    render(<OperationsModule store={store} now={() => 9_000_000} />);
    await waitFor(() => expect(answers).toHaveLength(1)); // the first load
    await act(async () => answers[0]!([]));
    await screen.findByText('No operations recorded yet.');

    const recorder = new OperationRecorder(inner, () => Date.UTC(2026, 10, 3, 9));
    const plan = (id: string) => approvePlan(createWritePlan([plannedWrite.assignRole('22222222-2222-2222-2222-222222222222', '11111111-1111-1111-1111-111111111111', 'Assign')]), ENV, 'Owner', 1, { operationId: id });
    await recorder.begin(plan('first'));
    const older = (await inner.list()).records;
    await recorder.begin(plan('second'));
    const newer = (await inner.list()).records;
    await waitFor(() => expect(answers).toHaveLength(3)); // one read per ledger change
    expect(older).toHaveLength(1);
    expect(newer).toHaveLength(2);

    await act(async () => answers[2]!(newer)); // the newer snapshot arrives first ...
    await act(async () => answers[1]!(older)); // ... the older one arrives late and must be ignored
    const table = await screen.findByRole('table', { name: /Recorded operations/ });
    expect(within(table).getAllByRole('row').slice(1)).toHaveLength(2);
  });
});
