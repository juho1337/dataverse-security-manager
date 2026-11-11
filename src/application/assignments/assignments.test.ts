import { describe, expect, it, vi } from 'vitest';
import { explainUserAccess } from '../../domain/buMove/userAccess';
import type { Role, SecuritySnapshot, UserAccess } from '../../domain/buMove/types';
import { SYNTHETIC_ACCESS_SNAPSHOT } from '../../adapters/fixture/accessFixture';
import type { OperationResult } from '../../domain/operations';
import type { ReadResult } from '../../ports/accessReader';
import type { SecurityDataWriter } from '../../ports/securityDataWriter';
import { planAssignments } from './planner';
import { confirmAndApplyAssignments } from './service';
import { deriveStatus, isVerified } from '../../domain/history/record';
import { analyzeOperation } from '../../domain/history/reconcile';
import { flakyStore, testLedger } from '../../test/ledger';
import { HISTORY_BLOCKED_MESSAGE } from '../operations/ledger';
import { OperationRecorder } from '../operations/recorder';

// Synthetic only. The fake environment holds the direct assignments; the fake writer changes them (or not), and the reader reads them back,
// so "verified" can only ever come from what the re-read shows.

const snapshot = (over: Partial<SecuritySnapshot> = {}): SecuritySnapshot => ({ ...SYNTHETIC_ACCESS_SNAPSHOT, ...over });
const accessOf = (snap: SecuritySnapshot, userId: string): UserAccess => explainUserAccess(snap, userId);
const role = (id: string): Role => SYNTHETIC_ACCESS_SNAPSHOT.roles.find((r) => r.id === id) as Role;
const catalogHq = SYNTHETIC_ACCESS_SNAPSHOT.roles.filter((r) => r.businessUnitId === 'bu-hq');

describe('planAssignments', () => {
  const cara = accessOf(snapshot(), 'u-cara'); // BU Contoso (hq), directly holds Project Contributor, default team gives Basic User

  it('plans an assignment and a removal with descriptions, additions first', () => {
    const p = planAssignments({
      access: cara,
      catalog: catalogHq,
      requests: [{ action: 'unassign', roleId: 'r-contrib' }, { action: 'assign', roleId: 'r-admin' }],
    });
    expect(p.items.map((i) => [i.action, i.status])).toEqual([['assign', 'planned'], ['unassign', 'planned']]);
    expect(p.plan?.writes.map((w) => w.kind)).toEqual(['assignRole', 'unassignRole']);
    expect(p.plan?.writes[0]?.description).toContain('System Administrator');
    expect(p.warnings.join(' ')).toContain('removes the privileges');
  });

  it('is idempotent: already assigned and not assigned produce no write', () => {
    const p = planAssignments({
      access: cara,
      catalog: catalogHq,
      requests: [{ action: 'assign', roleId: 'r-contrib' }, { action: 'unassign', roleId: 'r-admin' }],
    });
    expect(p.items.map((i) => i.status).sort()).toEqual(['alreadyAssigned', 'notAssigned']);
    expect(p.plan).toBeNull();
  });

  it('refuses a role of another business unit and names the right copy when the lineage is known', () => {
    const north: Role = { ...role('r-contrib-north'), parentRootRoleId: 'r-contrib' };
    const hq: Role = { ...role('r-contrib'), parentRootRoleId: 'r-contrib' };
    const p = planAssignments({ access: cara, catalog: [north, hq], requests: [{ action: 'assign', roleId: 'r-contrib-north' }] });
    expect(p.items[0]).toMatchObject({ status: 'refused' });
    expect(p.items[0]?.reason).toContain('business unit it belongs to (Contoso)');
    expect(p.items[0]?.reason).toContain('Use the copy of "Project Contributor" in Contoso');
    expect(p.plan).toBeNull();
  });

  it('refuses unknown roles, disabled users, and conflicting or incomplete reads; the same request twice is one', () => {
    const finn = accessOf(snapshot(), 'u-finn');
    expect(planAssignments({ access: finn, catalog: SYNTHETIC_ACCESS_SNAPSHOT.roles.filter((r) => r.businessUnitId === 'bu-north'), requests: [{ action: 'assign', roleId: 'r-sales' }] }).items[0]?.reason).toContain('disabled');
    expect(planAssignments({ access: cara, catalog: catalogHq, requests: [{ action: 'assign', roleId: 'nope' }] }).items[0]?.reason).toContain('not in the list');
    const both = planAssignments({ access: cara, catalog: catalogHq, requests: [{ action: 'assign', roleId: 'r-admin' }, { action: 'unassign', roleId: 'r-admin' }] });
    expect(both.items).toHaveLength(1);
    expect(both.items[0]?.status).toBe('refused');
    expect(both.plan).toBeNull();
    const twice = planAssignments({ access: cara, catalog: catalogHq, requests: [{ action: 'assign', roleId: 'r-admin' }, { action: 'assign', roleId: 'R-ADMIN' }] });
    expect(twice.plan?.writes).toHaveLength(1);
    const pat = accessOf(snapshot(), 'u-pat'); // a team membership that cannot be read: incomplete
    expect(pat.isComplete).toBe(false);
    const incomplete = planAssignments({ access: pat, catalog: catalogHq, requests: [{ action: 'assign', roleId: 'r-admin' }] });
    expect(incomplete.items[0]?.status).toBe('refused');
    expect(incomplete.items[0]?.reason).toContain('could not be read completely');
    expect(incomplete.plan).toBeNull();
  });

  it('says when a role is also held through a team, and warns when the user would be left without roles', () => {
    const p = planAssignments({ access: cara, catalog: catalogHq, requests: [{ action: 'assign', roleId: 'r-basic' }] });
    expect(p.items[0]?.alsoViaTeam).toBe(true);
    expect(p.items[0]?.status).toBe('planned');
    const ben = accessOf(snapshot({ memberships: SYNTHETIC_ACCESS_SNAPSHOT.memberships.filter((m) => m.userId !== 'u-ben') }), 'u-ben');
    const removing = planAssignments({ access: ben, catalog: [], requests: [{ action: 'unassign', roleId: 'r-contrib-north' }] });
    expect(removing.warnings.join(' ')).toContain('no roles at all');
    const teamOnly = planAssignments({ access: cara, catalog: catalogHq, requests: [{ action: 'unassign', roleId: 'r-basic' }] });
    expect(teamOnly.items[0]?.status).toBe('notAssigned');
    expect(teamOnly.items[0]?.reason).toContain('comes through a team');
  });
});

/** A fake environment: direct assignments of one user, a writer with scripted behaviour, and a reader that reads the real (fake) state. */
function environment(initial: readonly string[], behaviour: { assign?: (roleId: string) => OperationResult; unassign?: (roleId: string) => OperationResult; applyOnAccept?: (kind: 'assign' | 'unassign') => boolean } = {}) {
  const held = new Set(initial);
  const calls: string[] = [];
  const writer: SecurityDataWriter = {
    addPrivilege: vi.fn(),
    removePrivilege: vi.fn(),
    moveUser: vi.fn(),
    assignRole: async (_a, _u, roleId) => {
      calls.push(`assign:${roleId}`);
      const r = behaviour.assign?.(roleId) ?? { outcome: 'notVerified' as const, message: 'Accepted.', failure: 'none' as const };
      if (r.outcome !== 'failed' && (behaviour.applyOnAccept?.('assign') ?? true)) held.add(roleId);
      return r;
    },
    unassignRole: async (_a, _u, roleId) => {
      calls.push(`unassign:${roleId}`);
      const r = behaviour.unassign?.(roleId) ?? { outcome: 'notVerified' as const, message: 'Accepted.', failure: 'none' as const };
      if (r.outcome !== 'failed' && (behaviour.applyOnAccept?.('unassign') ?? true)) held.delete(roleId);
      return r;
    },
  };
  let reads = 0;
  let readOutcome: (n: number) => 'ok' | 'error' | 'partial' = () => 'ok';
  const reader = {
    loadUserAccess: async (userId: string): Promise<ReadResult<UserAccess>> => {
      reads++;
      const mode = readOutcome(reads);
      if (mode === 'error') return { status: 'error', errorClass: 'network', message: 'down' };
      const snap = snapshot({ directAssignments: [...held].map((roleId) => ({ userId, roleId })) });
      const access = explainUserAccess(snap, userId);
      return mode === 'partial' ? { status: 'partial', data: { ...access, isComplete: false }, notes: ['gap'] } : { status: 'ok', data: access };
    },
  };
  return { held, calls, writer, reader, setReads: (f: typeof readOutcome) => { readOutcome = f; }, reads: () => reads };
}

const plan = (held: readonly string[], requests: Parameters<typeof planAssignments>[0]['requests']) => {
  const snap = snapshot({ directAssignments: held.map((roleId) => ({ userId: 'u-cara', roleId })) });
  return planAssignments({ access: explainUserAccess(snap, 'u-cara'), catalog: catalogHq, requests });
};

const confirm = (env: ReturnType<typeof environment>, p: ReturnType<typeof plan>, extra: { isCancelled?: () => boolean } = {}) =>
  confirmAndApplyAssignments({ plan: p, writer: env.writer, reader: env.reader, actor: 'tester', environmentId: 'env-1', ...extra });

describe('confirmAndApplyAssignments', () => {
  it('verifies each item by a fresh read and reports succeeded only when the read shows the wanted state', async () => {
    const env = environment(['r-contrib']);
    const out = await confirm(env, plan(['r-contrib'], [{ action: 'assign', roleId: 'r-admin' }, { action: 'unassign', roleId: 'r-contrib' }]));
    expect(env.calls).toEqual(['assign:r-admin', 'unassign:r-contrib']);
    expect(out?.result.items.map((i) => [i.outcome, i.heldAfter])).toEqual([['succeeded', true], ['succeeded', false]]);
    expect(out?.result.overall).toBe('succeeded');
    expect(out?.result.verified).toBe(true);
    expect(out?.approval.operationId).toBeTruthy();
  });

  it('never claims success from the API response alone: accepted but absent on re-read is failed', async () => {
    const env = environment([], { applyOnAccept: () => false });
    const out = await confirm(env, plan([], [{ action: 'assign', roleId: 'r-admin' }]));
    expect(out?.result.items[0]).toMatchObject({ outcome: 'failed', heldAfter: false });
    expect(out?.result.items[0]?.message).toContain('re-read does not show');
    expect(out?.result.overall).toBe('failed');
  });

  it('is notVerified when the final re-read fails or is incomplete and does not show the change', async () => {
    const failing = environment([]);
    failing.setReads((n) => (n >= 2 ? 'error' : 'ok'));
    const a = await confirm(failing, plan([], [{ action: 'assign', roleId: 'r-admin' }]));
    expect(a?.result.items[0]?.outcome).toBe('notVerified');
    expect(a?.result.overall).toBe('notVerified');

    const incomplete = environment(['r-contrib']);
    incomplete.setReads((n) => (n >= 2 ? 'partial' : 'ok'));
    const b = await confirm(incomplete, plan(['r-contrib'], [{ action: 'unassign', roleId: 'r-contrib' }]));
    expect(b?.result.items[0]?.outcome).toBe('notVerified'); // absence in an incomplete read is not proof
    expect(b?.result.verified).toBe(false);
  });

  it('sends nothing when the read before applying fails or is incomplete', async () => {
    const down = environment([]);
    down.setReads(() => 'error');
    const a = await confirm(down, plan([], [{ action: 'assign', roleId: 'r-admin' }]));
    expect(down.calls).toEqual([]);
    expect(a?.result.overall).toBe('failed');
    expect(a?.result.items[0]?.message).toContain('before applying');
    const partial = environment([]);
    partial.setReads(() => 'partial');
    await confirm(partial, plan([], [{ action: 'assign', roleId: 'r-admin' }]));
    expect(partial.calls).toEqual([]);
  });

  it('does not duplicate an assignment made after the preview', async () => {
    const env = environment(['r-admin']); // someone assigned it between preview and confirm
    const out = await confirm(env, plan([], [{ action: 'assign', roleId: 'r-admin' }]));
    expect(env.calls).toEqual([]);
    expect(out?.result.items[0]).toMatchObject({ outcome: 'skipped', noChange: true });
    expect(out?.result.overall).toBe('skipped');
  });

  it('stops at the first failed write, reports the rest as not attempted, and re-reads what actually happened', async () => {
    const env = environment(['r-contrib'], { assign: (id) => (id === 'r-admin' ? { outcome: 'failed', message: 'Not allowed.', failure: 'permission' } : { outcome: 'notVerified', message: 'ok', failure: 'none' }) });
    const out = await confirm(env, plan(['r-contrib'], [{ action: 'assign', roleId: 'r-admin' }, { action: 'unassign', roleId: 'r-contrib' }]));
    expect(env.calls).toEqual(['assign:r-admin']);
    expect(out?.result.items.map((i) => i.outcome)).toEqual(['failed', 'skipped']);
    expect(out?.result.items[1]?.message).toContain('failed');
    expect(out?.result.overall).toBe('failed');
    expect(env.held.has('r-contrib')).toBe(true);
  });

  it('reports a partial result and treats an uncertain write as a stop', async () => {
    const env = environment(['r-contrib'], { unassign: () => ({ outcome: 'uncertain', message: 'Timed out.', failure: 'execution' }), applyOnAccept: (k) => k === 'assign' });
    const out = await confirm(env, plan(['r-contrib'], [{ action: 'assign', roleId: 'r-admin' }, { action: 'unassign', roleId: 'r-contrib' }]));
    expect(out?.result.items.map((i) => i.outcome)).toEqual(['succeeded', 'failed']);
    expect(out?.result.overall).toBe('partiallyApplied');
    const thrown = environment([]);
    thrown.writer.assignRole = async () => { throw new Error('boom'); };
    const t = await confirm(thrown, plan([], [{ action: 'assign', roleId: 'r-admin' }, { action: 'assign', roleId: 'r-basic' }]));
    expect(t?.result.items[0]?.outcome).toBe('failed');
    expect(t?.result.items[1]?.outcome).toBe('skipped');
  });

  it('honours cancellation before the next write and returns null when there is nothing to write', async () => {
    const env = environment([]);
    let n = 0;
    const out = await confirm(env, plan([], [{ action: 'assign', roleId: 'r-admin' }, { action: 'assign', roleId: 'r-basic' }]), { isCancelled: () => n++ >= 1 });
    expect(env.calls).toEqual(['assign:r-admin']);
    expect(out?.result.items[1]).toMatchObject({ outcome: 'skipped' });
    expect(out?.result.items[1]?.message).toContain('Cancelled');
    expect(await confirm(env, plan([], []))).toBeNull();
  });
});

describe('operation history: role assignments are recorded', () => {
  const withLedger = (env: ReturnType<typeof environment>, p: ReturnType<typeof plan>, recorder: OperationRecorder) =>
    confirmAndApplyAssignments({ plan: p, writer: env.writer, reader: env.reader, actor: 'tester', environmentId: 'env-1', recorder });

  it('a verified assignment and removal are verified steps of one entry', async () => {
    const led = testLedger();
    const env = environment(['r-contrib']);
    const out = await withLedger(env, plan(['r-contrib'], [{ action: 'assign', roleId: 'r-admin' }, { action: 'unassign', roleId: 'r-contrib' }]), led.recorder);
    const [rec] = await led.records();
    expect(await led.records()).toHaveLength(1);
    expect(rec).toMatchObject({ operationId: out?.approval.operationId, environmentId: 'env-1', actor: 'tester' });
    expect(rec?.steps.map((s) => [s.kind, s.outcome, s.verified])).toEqual([['assignRole', 'succeeded', true], ['unassignRole', 'succeeded', true]]);
    expect(deriveStatus(rec!)).toBe('succeeded');
  });

  it('records whether the user held each role in the complete read before applying and in the final re-read (schema v2)', async () => {
    const led = testLedger();
    const env = environment(['r-contrib']);
    await withLedger(env, plan(['r-contrib'], [{ action: 'assign', roleId: 'r-admin' }, { action: 'unassign', roleId: 'r-contrib' }]), led.recorder);
    const [rec] = await led.records();
    expect(rec?.schemaVersion).toBe(2);
    expect(rec?.steps[0]).toMatchObject({ before: { kind: 'roleHeld', roleId: 'r-admin', held: false }, after: { kind: 'roleHeld', roleId: 'r-admin', held: true }, stateIntegrity: 'ok' });
    expect(rec?.steps[1]).toMatchObject({ before: { roleId: 'r-contrib', held: true }, after: { roleId: 'r-contrib', held: false } });
  });

  it('records no after-state when the final re-read could not tell', async () => {
    const led = testLedger();
    const env = environment([]);
    env.setReads((n) => (n >= 2 ? 'error' : 'ok'));
    await withLedger(env, plan([], [{ action: 'assign', roleId: 'r-admin' }]), led.recorder);
    const [rec] = await led.records();
    expect(rec?.steps[0]?.before).toMatchObject({ held: false });
    expect(rec?.steps[0]?.after).toBeUndefined();
  });

  it('an accepted request that the re-read does not show is failed, never verified', async () => {
    const led = testLedger();
    const env = environment([], { applyOnAccept: () => false });
    await withLedger(env, plan([], [{ action: 'assign', roleId: 'r-admin' }]), led.recorder);
    const [rec] = await led.records();
    expect(rec?.steps[0]).toMatchObject({ outcome: 'failed', verified: false });
    expect(isVerified(rec!)).toBe(false);
  });

  it('an incomplete final re-read leaves the step notVerified', async () => {
    const led = testLedger();
    const env = environment([]);
    env.setReads((n) => (n >= 2 ? 'error' : 'ok'));
    await withLedger(env, plan([], [{ action: 'assign', roleId: 'r-admin' }]), led.recorder);
    const [rec] = await led.records();
    expect(rec?.steps[0]).toMatchObject({ outcome: 'notVerified', verified: false });
    expect(deriveStatus(rec!)).toBe('notVerified');
  });

  it('a failed write keeps its failure class and the later steps are skipped', async () => {
    const led = testLedger();
    const env = environment([], { assign: (roleId) => (roleId === 'r-admin' ? { outcome: 'failed', message: 'Dataverse refused.', failure: 'permission' } : { outcome: 'notVerified', message: 'Accepted.', failure: 'none' }) });
    await withLedger(env, plan([], [{ action: 'assign', roleId: 'r-admin' }, { action: 'assign', roleId: 'r-contrib' }]), led.recorder);
    const [rec] = await led.records();
    expect(rec?.steps.map((s) => [s.outcome, s.failure])).toEqual([['failed', 'permission'], ['skipped', 'none']]);
  });

  it('a ledger that stops working after the intent never changes or hides the write result', async () => {
    const recorder = new OperationRecorder(flakyStore(1));
    const env = environment([]);
    const out = await withLedger(env, plan([], [{ action: 'assign', roleId: 'r-admin' }]), recorder);
    expect(out?.result.overall).toBe('succeeded');
    expect(env.calls).toEqual(['assign:r-admin']);
    expect(recorder.lastSaveError).toBe('storage unavailable');
  });

  it('when the intent cannot be written nothing is sent', async () => {
    const env = environment([]);
    const out = await withLedger(env, plan([], [{ action: 'assign', roleId: 'r-admin' }]), new OperationRecorder(flakyStore(0)));
    expect(env.calls).toEqual([]);
    expect(out?.result.items[0]).toMatchObject({ outcome: 'skipped', message: HISTORY_BLOCKED_MESSAGE });
  });
});

describe('operation history: a step the re-read decides FAILED never keeps failure class none (assignments)', () => {
  it('accepted but not shown by the re-read is an execution failure, and the advice does not say "(none)"', async () => {
    const led = testLedger();
    const env = environment([], { applyOnAccept: () => false });
    await confirmAndApplyAssignments({ plan: plan([], [{ action: 'assign', roleId: 'r-admin' }]), writer: env.writer, reader: env.reader, actor: 'tester', environmentId: 'env-1', recorder: led.recorder });
    const [rec] = await led.records();
    expect(rec?.steps[0]).toMatchObject({ outcome: 'failed', failure: 'execution' });
    expect(analyzeOperation(rec!).advice[0]?.reason).not.toContain('(none)');
  });
});
