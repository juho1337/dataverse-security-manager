import { describe, expect, it } from 'vitest';
import type { OperationResult } from '../../domain/operations';
import { PRIVILEGE_IDS, type CellValue, type PrivilegeCells, type PrivilegeId, type RoleMatrix, type RoleRow } from '../../domain/privileges';
import { stage, type EditSession, type HeldDepth } from '../../domain/roleEditing';
import type { ReadResult, SecurityDataReader } from '../../ports/securityDataReader';
import type { SecurityDataWriter } from '../../ports/securityDataWriter';
import { beginRoleEdit, confirmAndApply, rereadRole } from './service';
import { deriveStatus, isVerified } from '../../domain/history/record';
import { analyzeOperation } from '../../domain/history/reconcile';
import { flakyStore, testLedger } from '../../test/ledger';
import { HISTORY_BLOCKED_MESSAGE } from '../operations/ledger';
import { OperationRecorder } from '../operations/recorder';

const ROLE = '11111111-1111-1111-1111-111111111111';
const ROOT = '22222222-2222-2222-2222-222222222222';
const ENV = '00000000-0000-4000-8000-000000000002';
const catalog = Object.fromEntries(PRIVILEGE_IDS.map((p, i) => [p, `00000000-0000-0000-0000-${String(i + 1).padStart(12, '0')}`])) as Record<PrivilegeId, string>;

type Held = Partial<Record<PrivilegeId, HeldDepth>>;
const cellsOf = (held: Held): PrivilegeCells =>
  Object.fromEntries(PRIVILEGE_IDS.map((p) => [p, (held[p] ? { kind: 'depth', depth: held[p] } : { kind: 'noGrant' }) as CellValue])) as PrivilegeCells;

const row = (over: Partial<RoleRow> = {}, held: Held = { Read: 'Basic' }): RoleRow => ({
  roleId: ROLE, name: 'Test role', cells: cellsOf(held), isManaged: false, parentRootRoleId: null, ...over,
});
const matrixOf = (rows: RoleRow[], over: Partial<RoleMatrix> = {}): RoleMatrix => ({
  table: { logicalName: 'account', displayName: 'Account', supported: true }, roles: rows, privilegeCatalog: catalog, ...over,
});

describe('beginRoleEdit', () => {
  it('starts an edit session for a known root, unmanaged role with a catalog', () => {
    const r = beginRoleEdit(matrixOf([row()]), row(), false);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.session).toMatchObject({ table: 'account', role: { roleId: ROLE, isRootRole: true, isManaged: false } });
  });

  it('refuses without a privilege catalog, with unknown managed state, and with unknown lineage', () => {
    expect(beginRoleEdit(matrixOf([row()], { privilegeCatalog: undefined as never }), row(), false)).toMatchObject({ ok: false });
    const noManaged = beginRoleEdit(matrixOf([]), { roleId: ROLE, name: 'x', cells: cellsOf({}), parentRootRoleId: null }, false);
    expect(noManaged).toMatchObject({ ok: false });
    expect(!noManaged.ok && noManaged.reason).toMatch(/managed/);
    const noLineage = beginRoleEdit(matrixOf([]), { roleId: ROLE, name: 'x', cells: cellsOf({}), isManaged: false }, false);
    expect(!noLineage.ok && noLineage.reason).toMatch(/lineage/);
  });

  it('refuses a managed role, incomplete data, and a Business Unit copy (naming the root to edit instead)', () => {
    expect(beginRoleEdit(matrixOf([]), row({ isManaged: true }), false)).toMatchObject({ ok: false });
    expect(beginRoleEdit(matrixOf([]), row(), true)).toMatchObject({ ok: false });
    expect(beginRoleEdit(matrixOf([]), row({ parentRootRoleId: ROOT }), false)).toMatchObject({ ok: false, redirectToRoleId: ROOT });
  });
});

/** An in-memory Dataverse for one role: the writer changes it, the reader reflects it, like the real thing after a successful write. */
function world(initial: Held, opts: { failOn?: PrivilegeId; ignore?: PrivilegeId; readFails?: boolean } = {}) {
  const held: Held = { ...initial };
  const log: string[] = [];
  const toPriv = (id: string) => PRIVILEGE_IDS.find((p) => catalog[p] === id) as PrivilegeId;
  const ok: OperationResult = { outcome: 'notVerified', message: 'accepted', failure: 'none' };
  const writer: SecurityDataWriter = {
    addPrivilege: async (_a, _r, id, depth) => {
      const p = toPriv(id);
      log.push(`add ${p} ${depth}`);
      if (opts.failOn === p) return { outcome: 'failed', message: 'refused', failure: 'permission' };
      if (opts.ignore !== p) held[p] = depth;
      return ok;
    },
    removePrivilege: async (_a, _r, id) => {
      const p = toPriv(id);
      log.push(`remove ${p}`);
      if (opts.failOn === p) return { outcome: 'failed', message: 'refused', failure: 'permission' };
      delete held[p];
      return ok;
    },
    assignRole: async () => ok, unassignRole: async () => ok, moveUser: async () => ok,
  };
  const reader: SecurityDataReader = {
    listTables: async () => ({ status: 'ok', data: [] }),
    loadRoleMatrix: async (): Promise<ReadResult<RoleMatrix>> =>
      opts.readFails ? { status: 'error', errorClass: 'network', message: 'down' } : { status: 'ok', data: matrixOf([row({}, held)]) },
    loadRoleDetails: async () => ({ status: 'error', errorClass: 'unknown', message: 'n/a' }),
  };
  return { held, log, writer, reader };
}

function sessionFor(held: Held, changes: [PrivilegeId, HeldDepth][]): EditSession {
  const start = beginRoleEdit(matrixOf([row({}, held)]), row({}, held), false);
  if (!start.ok) throw new Error(start.reason);
  let s = start.session;
  for (const [p, d] of changes) {
    const r = stage(s, p, d);
    if (!r.ok) throw new Error(r.reason);
    s = r.session;
  }
  return s;
}

describe('confirmAndApply', () => {
  const base = (w: ReturnType<typeof world>, s: EditSession) => ({ session: s, writer: w.writer, reader: w.reader, actor: 'Owner', environmentId: ENV, now: () => 1_000 });

  it('applies the confirmed plan through the writer, re-reads, and reports success only from the re-read', async () => {
    const w = world({ Read: 'Basic' });
    const out = await confirmAndApply(base(w, sessionFor({ Read: 'Basic' }, [['Read', 'Local'], ['Write', 'Basic']])));
    expect(out?.result.overall).toBe('succeeded');
    expect(w.log).toEqual(['add Write Basic', 'add Read Local']);
    expect(out?.approval).toMatchObject({ approvedBy: 'Owner', environmentId: ENV });
    expect(out?.approval.plan.writes).toHaveLength(2);
  });

  it('returns null and writes nothing when no change is staged', async () => {
    const w = world({ Read: 'Basic' });
    expect(await confirmAndApply(base(w, sessionFor({ Read: 'Basic' }, [])))).toBeNull();
    expect(w.log).toEqual([]);
  });

  it('reports a failed write and a request the re-read does not confirm', async () => {
    const failing = world({ Read: 'Basic' }, { failOn: 'Write' });
    const a = await confirmAndApply(base(failing, sessionFor({ Read: 'Basic' }, [['Write', 'Basic'], ['Read', 'Local']])));
    expect(a?.result.overall).toBe('failed');
    expect(a?.result.items.map((i) => i.outcome)).toEqual(['failed', 'skipped']);
    const ignored = world({ Read: 'Basic' }, { ignore: 'Read' });
    const b = await confirmAndApply(base(ignored, sessionFor({ Read: 'Basic' }, [['Read', 'Local']])));
    expect(b?.result.items[0]).toMatchObject({ outcome: 'failed', foundDepth: 'Basic' });
  });

  it('is notVerified, never success, when the re-read fails', async () => {
    const w = world({ Read: 'Basic' }, { readFails: true });
    const out = await confirmAndApply(base(w, sessionFor({ Read: 'Basic' }, [['Read', 'Local']])));
    expect(out?.result.overall).toBe('notVerified');
    expect(out?.result.verified).toBe(false);
  });
});

describe('rereadRole', () => {
  it('finds the role cells, and returns null for a missing role or a failed read', async () => {
    const w = world({ Read: 'Deep' });
    expect((await rereadRole(w.reader, 'account', ROLE))?.Read).toEqual({ kind: 'depth', depth: 'Deep' });
    expect(await rereadRole(w.reader, 'account', '99999999-9999-9999-9999-999999999999')).toBeNull();
    expect(await rereadRole(world({}, { readFails: true }).reader, 'account', ROLE)).toBeNull();
  });
});

describe('operation history: a role edit is recorded', () => {
  const withLedger = (w: ReturnType<typeof world>, s: EditSession, recorder: OperationRecorder) => ({
    session: s, writer: w.writer, reader: w.reader, actor: 'Owner', environmentId: ENV, now: () => 1_000, recorder,
  });

  it('a verified edit is one ledger entry whose steps are verified by the re-read', async () => {
    const led = testLedger();
    const w = world({ Read: 'Basic' });
    const out = await confirmAndApply(withLedger(w, sessionFor({ Read: 'Basic' }, [['Read', 'Local'], ['Write', 'Basic']]), led.recorder));
    const [rec] = await led.records();
    expect(await led.records()).toHaveLength(1);
    expect(rec).toMatchObject({ operationId: out?.approval.operationId, environmentId: ENV, actor: 'Owner', source: 'user' });
    expect(rec?.correlationId).toMatch(/^[0-9a-f]{32}$/);
    expect(rec?.endedAtMs).toBeDefined();
    expect(rec?.steps.map((s) => [s.kind, s.outcome, s.verified])).toEqual([['addPrivilege', 'succeeded', true], ['addPrivilege', 'succeeded', true]]);
    expect(deriveStatus(rec!)).toBe('succeeded');
  });

  it('records the state read just before the write and the state the re-read found (schema v2)', async () => {
    const led = testLedger();
    const w = world({ Read: 'Basic' });
    await confirmAndApply(withLedger(w, sessionFor({ Read: 'Basic' }, [['Read', 'Local'], ['Write', 'Basic']]), led.recorder));
    const [rec] = await led.records();
    expect(rec?.schemaVersion).toBe(2);
    // the writes are ordered by the editor (additions before raises), so look the steps up by privilege
    const read = rec?.steps.find((s) => s.before?.kind === 'privilegeDepth' && s.before.privilege === 'Read');
    const write = rec?.steps.find((s) => s.before?.kind === 'privilegeDepth' && s.before.privilege === 'Write');
    expect(read).toMatchObject({
      before: { kind: 'privilegeDepth', table: 'account', roleId: ROLE, privilege: 'Read', depth: 'Basic' },
      after: { kind: 'privilegeDepth', privilege: 'Read', depth: 'Local' },
      stateIntegrity: 'ok',
    });
    expect(write).toMatchObject({ before: { privilege: 'Write', depth: 'None' }, after: { privilege: 'Write', depth: 'Basic' } });
  });

  it('the before-state is a fresh read, not the matrix loaded when the edit was staged (which may be stale)', async () => {
    const led = testLedger();
    const w = world({ Read: 'Local' }); // changed by someone else after staging: the session still believes Basic
    await confirmAndApply(withLedger(w, sessionFor({ Read: 'Basic' }, [['Read', 'Deep']]), led.recorder));
    const [rec] = await led.records();
    expect(rec?.steps[0]?.before).toMatchObject({ depth: 'Local' });
  });

  it('records no before-state when it could not be read before the write, so the step is not restorable', async () => {
    const led = testLedger();
    const w = world({ Read: 'Basic' }, { readFails: true });
    await confirmAndApply(withLedger(w, sessionFor({ Read: 'Basic' }, [['Read', 'Local']]), led.recorder));
    const [rec] = await led.records();
    expect(rec?.steps[0]?.before).toBeUndefined();
    expect(rec?.steps[0]?.after).toBeUndefined();
    expect(rec?.steps[0]?.stateChecksum).toBeUndefined();
  });

  it('a refused write is a failed step with its failure class, and the rest are skipped', async () => {
    const led = testLedger();
    const w = world({ Read: 'Basic' }, { failOn: 'Write' });
    await confirmAndApply(withLedger(w, sessionFor({ Read: 'Basic' }, [['Write', 'Basic'], ['Read', 'Local']]), led.recorder));
    const [rec] = await led.records();
    expect(rec?.steps.map((s) => [s.outcome, s.failure, s.verified])).toEqual([['failed', 'permission', false], ['skipped', 'none', false]]);
    expect(deriveStatus(rec!)).toBe('failed');
  });

  it('an accepted request that cannot be re-read is notVerified in the ledger, never verified', async () => {
    const led = testLedger();
    const w = world({ Read: 'Basic' }, { readFails: true });
    const out = await confirmAndApply(withLedger(w, sessionFor({ Read: 'Basic' }, [['Read', 'Local']]), led.recorder));
    expect(out?.result.overall).toBe('notVerified');
    const [rec] = await led.records();
    expect(rec?.steps[0]).toMatchObject({ outcome: 'notVerified', verified: false });
    expect(deriveStatus(rec!)).toBe('notVerified');
    expect(isVerified(rec!)).toBe(false);
  });

  it('a request the re-read does not confirm is failed in the ledger', async () => {
    const led = testLedger();
    const w = world({ Read: 'Basic' }, { ignore: 'Read' });
    await confirmAndApply(withLedger(w, sessionFor({ Read: 'Basic' }, [['Read', 'Local']]), led.recorder));
    const [rec] = await led.records();
    expect(rec?.steps[0]).toMatchObject({ outcome: 'failed', verified: false });
  });

  it('a ledger that stops working after the intent never changes or hides the write result', async () => {
    const store = flakyStore(1); // only the intent is saved; every later save fails
    const recorder = new OperationRecorder(store);
    const w = world({ Read: 'Basic' });
    const out = await confirmAndApply(withLedger(w, sessionFor({ Read: 'Basic' }, [['Read', 'Local']]), recorder));
    expect(out?.result.overall).toBe('succeeded');
    expect(w.log).toEqual(['add Read Local']);
    expect(recorder.lastSaveError).toBe('storage unavailable');
  });

  it('when the intent cannot be written nothing is sent and the result says so', async () => {
    const recorder = new OperationRecorder(flakyStore(0));
    const w = world({ Read: 'Basic' });
    const out = await confirmAndApply(withLedger(w, sessionFor({ Read: 'Basic' }, [['Read', 'Local']]), recorder));
    expect(w.log).toEqual([]);
    expect(out?.result.overall).toBe('failed');
    expect(out?.result.items[0]).toMatchObject({ outcome: 'skipped', message: HISTORY_BLOCKED_MESSAGE });
  });

  it('without a recorder the edit works as before', async () => {
    const w = world({ Read: 'Basic' });
    const out = await confirmAndApply({ session: sessionFor({ Read: 'Basic' }, [['Read', 'Local']]), writer: w.writer, reader: w.reader, actor: 'Owner', environmentId: ENV });
    expect(out?.result.overall).toBe('succeeded');
  });
});

describe('operation history: a step the re-read decides FAILED never keeps failure class none', () => {
  it('role edit: accepted but not shown by the re-read is an execution failure, and the advice does not say "(none)"', async () => {
    const led = testLedger();
    const w = world({ Read: 'Basic' }, { ignore: 'Read' });
    await confirmAndApply({ session: sessionFor({ Read: 'Basic' }, [['Read', 'Local']]), writer: w.writer, reader: w.reader, actor: 'Owner', environmentId: ENV, recorder: led.recorder });
    const [rec] = await led.records();
    expect(rec?.steps[0]).toMatchObject({ outcome: 'failed', failure: 'execution' });
    expect(analyzeOperation(rec!).advice[0]?.reason).not.toContain('(none)');
  });
});
