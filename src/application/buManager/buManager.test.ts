import { describe, expect, it } from 'vitest';
import { createFakeEnvironment, SYNTHETIC_PRIVILEGES } from '../../adapters/fixture/buManagerFixture';
import { SYNTHETIC_ACCESS_SNAPSHOT } from '../../adapters/fixture/accessFixture';
import type { BuMoveRequest } from '../../domain/buMove/types';
import { approvePlan, refused, type OperationResult } from '../../domain/operations';
import { createWriteBoundary } from '../../adapters/pptb/writer/boundary';
import { createBusinessUnitMoveWriter } from '../../adapters/pptb/writer/buMove';
import { csvCell, redactEmails, resultToCsv, resultToJson } from './export';
import { executeBuMove } from './execute';
import { userStateReader } from './ports';
import { reconcileResult } from './reconcile';
import { writesForPlan } from './writePlan';
import { confirmAndRun, planMove, planRetryOf } from './service';
import { deriveStatus, isVerified } from '../../domain/history/record';
import { analyzeOperation } from '../../domain/history/reconcile';
import { flakyStore, testLedger } from '../../test/ledger';
import { HISTORY_BLOCKED_MESSAGE } from '../operations/ledger';
import { OperationRecorder } from '../operations/recorder';

// Ben (North, holds Project Contributor of North) moves to Contoso (the root). With "match roles in the target" he gets Contoso's identical
// Project Contributor. Cara (Contoso) moves to North. Finn is disabled, Svc is an application user.
const BEN = 'u-ben';
const CARA = 'u-cara';
const HQ = 'bu-hq';
const NORTH = 'bu-north';

const request = (over: Partial<BuMoveRequest> & Pick<BuMoveRequest, 'users'>): BuMoveRequest => ({
  targetBusinessUnitId: HQ,
  strategy: 'new',
  selection: { mode: 'allDirectRoles' },
  choices: [],
  ...over,
});

async function plan(env = createFakeEnvironment(), req: BuMoveRequest = request({ users: [{ userId: BEN, choices: [] }] })) {
  const out = await planMove(env.reader, req);
  if (!out.ok) throw new Error(out.message);
  return { env, planned: out.planned };
}

const run = (env: ReturnType<typeof createFakeEnvironment>, planned: Awaited<ReturnType<typeof plan>>['planned'], extra: object = {}) =>
  confirmAndRun({ planned, writer: env.writer, reader: env.reader, actor: 'tester', environmentId: 'env-1', ...extra });

describe('writes of a plan', () => {
  it('moves first, then assigns only the roles the plan restores; no write for retained roles, excluded or blocked users', async () => {
    const { planned } = await plan(createFakeEnvironment(), request({ users: [{ userId: BEN, choices: [] }, { userId: 'u-finn', choices: [] }, { userId: 'u-svc', choices: [] }] }));
    const keys = planned.writes.plan?.writes.map((w) => w.key) ?? [];
    expect(keys[0]).toBe(`moveUser:${BEN}:${HQ}`);
    expect(keys.filter((k) => k.startsWith('assignRole:'))).toEqual([`assignRole:${BEN}:r-contrib`]);
    expect(keys.some((k) => k.includes('u-finn') || k.includes('u-svc'))).toBe(false);
    expect(planned.writes.excluded.map((e) => e.userId).sort()).toEqual(['u-finn', 'u-svc']);
  });

  it('has no plan when nothing can be sent (everyone already in the target)', async () => {
    const out = await planMove(createFakeEnvironment().reader, request({ users: [{ userId: 'u-ann', choices: [] }] }));
    expect(out.ok && out.planned.writes.plan).toBeNull();
  });

  it('refuses to plan without users or with an unknown target', async () => {
    const env = createFakeEnvironment();
    expect((await planMove(env.reader, request({ users: [] }))).ok).toBe(false);
    const bad = await planMove(env.reader, request({ targetBusinessUnitId: 'nope', users: [{ userId: BEN, choices: [] }] }));
    expect(bad.ok).toBe(false);
  });
});

describe('executeBuMove: verification by a fresh read', () => {
  it('moves, restores the role and calls each step verified only after a read shows it', async () => {
    const { env, planned } = await plan();
    const result = await run(env, planned);
    expect(env.writes).toEqual([`moveUser:${BEN}:${HQ}`, `assignRole:${BEN}:r-contrib`]);
    expect(result?.overall).toBe('succeeded');
    expect(result?.users[0]?.steps.map((s) => [s.kind, s.outcome, s.sent])).toEqual([['moveUser', 'succeeded', true], ['assignRole', 'succeeded', true]]);
    expect(env.snapshot().users.find((u) => u.id === BEN)?.businessUnitId).toBe(HQ);
  });

  it('an accepted request that changed nothing is a failure, never a success', async () => {
    const { env, planned } = await plan(createFakeEnvironment({ ignoreWrites: true }));
    const result = await run(env, planned);
    const steps = result?.users[0]?.steps ?? [];
    expect(steps[0]).toMatchObject({ kind: 'moveUser', outcome: 'failed' });
    expect(steps[1]).toMatchObject({ kind: 'assignRole', outcome: 'skipped', sent: false });
    expect(result?.overall).toBe('failed');
    expect(env.writes).toEqual([`moveUser:${BEN}:${HQ}`]); // roles are not restored when the move is not confirmed
  });

  it('does not send anything again when the state is already satisfied (idempotent, no duplicate assignment)', async () => {
    const { env, planned } = await plan();
    await run(env, planned);
    env.writes.length = 0;
    const again = await run(env, planned);
    expect(env.writes).toEqual([]);
    expect(again?.users[0]?.steps.every((s) => s.outcome === 'succeeded' && !s.sent)).toBe(true);
    expect(env.snapshot().directAssignments.filter((a) => a.userId === BEN && a.roleId === 'r-contrib')).toHaveLength(1);
  });

  it('reports roles that disappeared in the move and were not removed by the plan', async () => {
    const { env, planned } = await plan(createFakeEnvironment({ removeRolesOnMove: true }));
    const result = await run(env, planned);
    expect(result?.users[0]?.rolesLost).toEqual(['r-contrib-north']);
    expect(result?.users[0]?.overall).toBe('succeeded'); // the planned steps did succeed; the loss is shown separately
  });
});

describe('executeBuMove: failures and uncertainty', () => {
  const fail = (failure: OperationResult['failure'], outcome: OperationResult['outcome'] = 'failed'): OperationResult => ({ outcome, failure, message: 'It did not work.' });

  it('a failed move skips that user and the run continues with the next user', async () => {
    const env = createFakeEnvironment({ failWrite: { kind: 'moveUser', nth: 1, result: fail('permission') } });
    const { planned } = await plan(env, request({ targetBusinessUnitId: NORTH, strategy: 'none', selection: { mode: 'none' }, users: [{ userId: CARA, choices: [] }, { userId: 'u-pat', choices: [] }] }));
    const result = await run(env, planned);
    expect(result?.users.map((u) => u.overall)).toEqual(['failed', 'succeeded']);
    expect(result?.overall).toBe('partiallyApplied');
    expect(result?.stoppedReason).toBeNull();
    expect(env.writes).toEqual([`moveUser:${CARA}:${NORTH}`, `moveUser:u-pat:${NORTH}`]);
  });

  it('a failed move does not restore the roles of that user', async () => {
    const env = createFakeEnvironment({ failWrite: { kind: 'moveUser', result: fail('validation') } });
    const { planned } = await plan(env);
    const result = await run(env, planned);
    expect(result?.users[0]?.steps.find((s) => s.kind === 'assignRole')).toMatchObject({ outcome: 'skipped', sent: false });
  });

  it('a failed identity check stops the whole run and lists the users it never reached', async () => {
    const env = createFakeEnvironment({ failWrite: { kind: 'moveUser', nth: 1, result: fail('identity') } });
    const { planned } = await plan(env, request({ targetBusinessUnitId: NORTH, strategy: 'none', selection: { mode: 'none' }, users: [{ userId: CARA, choices: [] }, { userId: 'u-pat', choices: [] }] }));
    expect(planned.writes.included).toHaveLength(2);
    const result = await run(env, planned);
    expect(result?.stoppedReason).toContain('stopped');
    expect(result?.users.map((u) => u.overall)).toEqual(['failed', 'skipped']);
    expect(env.writes).toHaveLength(1);
  });

  it('an uncertain move that a read cannot confirm stops the run: nothing after it is sent', async () => {
    const env = createFakeEnvironment({ ignoreWrites: true, failWrite: { kind: 'moveUser', nth: 1, result: fail('timeout', 'uncertain') } });
    const { planned } = await plan(env, request({ targetBusinessUnitId: NORTH, strategy: 'none', selection: { mode: 'none' }, users: [{ userId: CARA, choices: [] }, { userId: 'u-pat', choices: [] }] }));
    const result = await run(env, planned);
    expect(result?.users[0]?.steps[0]).toMatchObject({ kind: 'moveUser', outcome: 'uncertain' });
    expect(result?.stoppedReason).toContain('uncertain');
    expect(result?.users[1]?.overall).toBe('skipped');
    expect(env.writes).toHaveLength(1);
  });

  it('a thrown write is uncertain, not failed or successful', async () => {
    const env = createFakeEnvironment({ throwOn: 'moveUser' });
    const { planned } = await plan(env);
    const result = await run(env, planned);
    expect(result?.users[0]?.steps[0]).toMatchObject({ outcome: 'uncertain', failure: 'execution' });
    expect(result?.overall).not.toBe('succeeded');
  });

  it('an unreadable user is never written: the run stops before the first request', async () => {
    const { env, planned } = await plan();
    const approval = approvePlan(planned.writes.plan!, 'env-1', 'tester', Date.now());
    const result = await executeBuMove({ plan: planned.plan, approval, writer: env.writer, readState: async () => null });
    expect(env.writes).toEqual([]);
    expect(result.stoppedReason).toContain('could not be read');
    expect(result.users[0]?.overall).toBe('skipped');
  });

  it('a partial role failure keeps the verified move and reports the role step as failed', async () => {
    const env = createFakeEnvironment({ failWrite: { kind: 'assignRole', result: fail('permission') } });
    const { planned } = await plan(env);
    const result = await run(env, planned);
    expect(result?.users[0]?.steps.map((s) => s.outcome)).toEqual(['succeeded', 'failed']);
    expect(result?.users[0]?.overall).toBe('partiallyApplied');
  });

  it('applies nothing when the plan differs from the confirmed one', async () => {
    const { env, planned } = await plan();
    const other = await plan(createFakeEnvironment(), request({ users: [{ userId: BEN, choices: [] }], strategy: 'none' }));
    const approval = approvePlan(other.planned.writes.plan!, 'env-1', 'tester', Date.now());
    const result = await executeBuMove({ plan: planned.plan, approval, writer: env.writer, readState: userStateReader(env.reader) });
    expect(env.writes).toEqual([]);
    expect(result.stoppedReason).toContain('no longer matches');
  });
});

describe('reconcileResult: settled by reading, retry only when proven missing', () => {
  it('an uncertain move that actually applied becomes verified by a later read', async () => {
    const env = createFakeEnvironment({ applyDespiteFailure: true, failWrite: { kind: 'moveUser', result: { outcome: 'uncertain', failure: 'timeout', message: 'Timed out.' } } });
    const { planned } = await plan(env);
    const result = await run(env, planned);
    expect(result?.users[0]?.steps[0]?.outcome).toBe('succeeded'); // the write timed out, but the re-read shows it applied; the role step then ran
    expect(result?.overall).toBe('succeeded');
  });

  it('proves missing steps absent by a complete read and offers them as retry candidates; a role the read cannot disprove is not a candidate', async () => {
    const { env, planned } = await plan(createFakeEnvironment({ failWrite: { kind: 'assignRole', result: { outcome: 'failed', failure: 'throttling', message: 'Throttled.' } } }));
    const result = (await run(env, planned))!;
    const rec = await reconcileResult(result, userStateReader(env.reader));
    expect(rec.retry).toHaveLength(1);
    expect(rec.retry[0]).toMatchObject({ userId: BEN, fixCauseFirst: false });
    expect(rec.retry[0]?.steps.map((s) => s.kind)).toEqual(['assignRole']);

    const unknown = await reconcileResult(result, async () => ({ businessUnitId: HQ, directRoleIds: [], rolesComplete: false }));
    expect(unknown.retry).toEqual([]); // an incomplete role list proves nothing
  });

  it('flags a permission failure as needing its cause fixed first, and settles a step that later turned out applied', async () => {
    const { env, planned } = await plan(createFakeEnvironment({ failWrite: { kind: 'assignRole', result: { outcome: 'failed', failure: 'permission', message: 'Denied.' } } }));
    const result = (await run(env, planned))!;
    const rec = await reconcileResult(result, userStateReader(env.reader));
    expect(rec.retry[0]?.fixCauseFirst).toBe(true);
    // Someone assigns the role afterwards: a later read settles the step as verified and nothing remains to retry.
    const withRole = await reconcileResult(result, async () => ({ businessUnitId: HQ, directRoleIds: ['r-contrib'], rolesComplete: true }));
    expect(withRole.retry).toEqual([]);
    expect(withRole.result.overall).toBe('succeeded');
  });

  it('reports users it could not read again and concludes nothing for them', async () => {
    const { env, planned } = await plan(createFakeEnvironment({ ignoreWrites: true }));
    const result = (await run(env, planned))!;
    const rec = await reconcileResult(result, async () => null);
    expect(rec.unread).toEqual(['Ben Brooks']);
    expect(rec.retry).toEqual([]);
    expect(rec.result.overall).toBe(result.overall);
  });
});

describe('retry plan', () => {
  it('plans only the steps a read proved missing, needs a new confirmation, and never repeats the verified move', async () => {
    const { env, planned } = await plan(createFakeEnvironment({ failWrite: { kind: 'assignRole', result: { outcome: 'failed', failure: 'throttling', message: 'Throttled.' } } }));
    const result = (await run(env, planned))!;
    const rec = await reconcileResult(result, userStateReader(env.reader));
    const retry = planRetryOf(planned, rec.retry)!;
    expect(retry.writes.plan?.writes.map((w) => w.key)).toEqual([`assignRole:${BEN}:r-contrib`]);
    expect(retry.writes.plan?.hash).not.toBe(planned.writes.plan?.hash);
    env.writes.length = 0;
    const second = await run(env, retry);
    expect(env.writes).toEqual([`assignRole:${BEN}:r-contrib`]);
    expect(second?.users[0]?.steps.map((s) => s.kind)).toEqual(['assignRole']);
    expect(second?.overall).toBe('succeeded');
  });

  it('has nothing to retry when no step is proven missing', async () => {
    const { env, planned } = await plan();
    const result = (await run(env, planned))!;
    const rec = await reconcileResult(result, userStateReader(env.reader));
    expect(planRetryOf(planned, rec.retry)).toBeNull();
  });

  it('does not assign roles to a user who is not in the target business unit in a roles-only retry', async () => {
    const { env, planned } = await plan();
    const only = new Set([`assignRole:${BEN}:r-contrib`]);
    const retry = { ...planned, only, writes: writesForPlan(planned.plan, only) };
    const result = (await run(env, retry))!;
    expect(env.writes).toEqual([]);
    expect(result.users[0]?.steps[0]).toMatchObject({ kind: 'assignRole', outcome: 'skipped', sent: false });
  });
});

describe('export', () => {
  it('neutralises spreadsheet formulas and quotes per RFC 4180', () => {
    expect(csvCell('=SUM(A1)')).toBe("'=SUM(A1)");
    expect(csvCell('+1')).toBe("'+1");
    expect(csvCell('-1')).toBe("'-1");
    expect(csvCell('@x')).toBe("'@x");
    expect(csvCell('\tx')).toBe("'\tx");
    expect(csvCell('a,"b"')).toBe('"a,""b"""');
    expect(csvCell('plain')).toBe('plain');
  });

  it('exports ids, outcomes and messages only: no email addresses', async () => {
    const { env, planned } = await plan();
    const result = (await run(env, planned))!;
    const csv = resultToCsv(result);
    const json = resultToJson(result);
    expect(csv.split('\r\n')[0]).toContain('outcome');
    expect(csv).toContain('succeeded');
    expect(JSON.parse(json).users[0].steps).toHaveLength(2);
    for (const text of [csv, json]) expect(text).not.toMatch(/@example\.test/);
  });
});

describe('the fake environment itself', () => {
  it('is built from the shared synthetic data and refuses a write that is not in the confirmed plan', async () => {
    expect(SYNTHETIC_PRIVILEGES.length).toBeGreaterThan(0);
    const env = createFakeEnvironment();
    const { planned } = await plan(env);
    const approval = approvePlan(planned.writes.plan!, 'env-1', 'tester', Date.now());
    const r = await env.writer.moveUser(approval, 'u-cara', NORTH);
    expect(r.outcome).toBe('failed');
    expect(SYNTHETIC_ACCESS_SNAPSHOT.users.length).toBeGreaterThan(0);
  });
});

// ---- regression tests for the Codex review of #317

const customTo = (target: string, users: Array<{ userId: string; map: Array<[string, string]> }>): BuMoveRequest =>
  request({ targetBusinessUnitId: target, strategy: 'custom', users: users.map((u) => ({ userId: u.userId, choices: u.map.map(([s, c]) => ({ sourceRoleId: s, chosenRoleId: c, confirmed: true })) })) });
const failure = (f: OperationResult['failure'], outcome: OperationResult['outcome'] = 'failed'): OperationResult => ({ outcome, failure: f, message: 'It did not work.' });

describe('a later read can contradict the verified move', () => {
  it('marks the move failed when a later complete read shows the user outside the target (North -> target -> North)', async () => {
    const base = createFakeEnvironment();
    const { planned } = await plan(base);
    const real = base.writer;
    const writer = { ...real, async assignRole(approval: Parameters<typeof real.assignRole>[0], userId: string, roleId: string) {
      const r = await real.assignRole(approval, userId, roleId);
      base.setBusinessUnit(userId, NORTH); // moved back by someone else while the role was assigned
      return r;
    } };
    const result = (await confirmAndRun({ planned, writer, reader: base.reader, actor: 'tester', environmentId: 'env-1' }))!;
    const steps = result.users[0]!.steps;
    expect(steps.find((s) => s.kind === 'moveUser')).toMatchObject({ outcome: 'failed' });
    expect(steps.find((s) => s.kind === 'assignRole')).toMatchObject({ outcome: 'succeeded' });
    expect(result.overall).not.toBe('succeeded');
    // Reconciliation is offered: a read proves the move absent.
    const rec = await reconcileResult(result, userStateReader(base.reader));
    expect(rec.retry[0]?.steps.map((s) => s.kind)).toContain('moveUser');
  });

  it('an incomplete read changes nothing: the move stays succeeded', async () => {
    const base = createFakeEnvironment();
    const { planned } = await plan(base);
    let reads = 0;
    const reader = { loadUserAccess: async (id: string) => {
      const r = await base.reader.loadUserAccess(id);
      reads++;
      return reads >= 3 && r.status === 'ok' ? ({ ...r, status: 'partial', notes: ['gap'], data: { ...r.data, user: { ...r.data.user, businessUnitId: NORTH } } } as unknown as typeof r) : r;
    } };
    const result = (await confirmAndRun({ planned, writer: base.writer, reader: reader as never, actor: 'tester', environmentId: 'env-1' }))!;
    expect(result.users[0]!.steps.find((s) => s.kind === 'moveUser')?.outcome).toBe('succeeded');
  });
});

describe('a later read can contradict an earlier verified role', () => {
  it('marks the earlier role failed when a later complete read no longer lists it (overall is not success)', async () => {
    const base = createFakeEnvironment();
    const { planned } = await plan(base, customTo(NORTH, [{ userId: 'u-ann', map: [['r-admin', 'r-sales'], ['r-contrib', 'r-contrib-north']] }]));
    expect(planned.writes.plan?.writes.filter((w) => w.kind === 'assignRole')).toHaveLength(2);
    // A writer that, while the SECOND role is assigned, also drops the FIRST one (a plug-in / another administrator).
    const real = base.writer;
    const assigned: string[] = [];
    const writer = { ...real, async assignRole(approval: Parameters<typeof real.assignRole>[0], userId: string, roleId: string) {
      const r = await real.assignRole(approval, userId, roleId);
      assigned.push(roleId);
      if (assigned.length === 2) base.dropRole(userId, assigned[0]!);
      return r;
    } };
    const result = (await confirmAndRun({ planned, writer, reader: base.reader, actor: 'tester', environmentId: 'env-1' }))!;
    const steps = result.users[0]!.steps.filter((s) => s.kind === 'assignRole');
    expect(steps.find((s) => s.roleId === assigned[0])).toMatchObject({ outcome: 'failed' });
    expect(steps.find((s) => s.roleId === assigned[1])).toMatchObject({ outcome: 'succeeded' });
    expect(result.overall).not.toBe('succeeded');
  });
});

describe('a refusal by the write boundary is not reported as a sent request', () => {
  it('sent is false, and both exports say so, when the boundary refuses before dispatch', async () => {
    const env = createFakeEnvironment();
    const { planned } = await plan(env);
    const refusing = { ...env.writer, moveUser: async () => refused('identity', 'The environment id could not be verified, and writes require it. No change was sent.') };
    const result = (await confirmAndRun({ planned, writer: refusing, reader: env.reader, actor: 'tester', environmentId: 'env-1' }))!;
    expect(env.writes).toEqual([]);
    expect(result.users[0]?.steps[0]).toMatchObject({ kind: 'moveUser', outcome: 'failed', sent: false });
    expect(resultToCsv(result)).toContain(',no,');
    expect(resultToCsv(result)).not.toContain(',yes,');
    expect(JSON.stringify(JSON.parse(resultToJson(result)))).toContain('"requestSent":false');
  });

  it('through the real write boundary: an unverifiable environment id sends nothing and is reported as not sent', async () => {
    const calls: string[] = [];
    const raw = { update: async () => { calls.push('update'); }, associate: async () => { calls.push('associate'); } };
    const boundary = createWriteBoundary({ raw, verifyIdentity: async () => ({ status: 'unverified', writesAllowed: false } as never), now: () => 1 });
    const env = createFakeEnvironment();
    const { planned } = await plan(env);
    const writer = createBusinessUnitMoveWriter({ boundary }) as unknown as typeof env.writer;
    const result = (await confirmAndRun({ planned, writer: { ...env.writer, moveUser: writer.moveUser }, reader: env.reader, actor: 'tester', environmentId: '00000000-0000-0000-0000-0000000000e1' }))!;
    expect(calls).toEqual([]);
    expect(result.users[0]?.steps[0]).toMatchObject({ kind: 'moveUser', outcome: 'failed', sent: false });
  });
});

describe('a retry of a move also restores the planned roles', () => {
  it('a role the user still holds is not dropped from the retry: the move can remove it, so it is restored and verified', async () => {
    const env = createFakeEnvironment({ removeRolesOnMove: true, failWrite: { kind: 'moveUser', nth: 1, result: failure('throttling') } });
    const { planned } = await plan(env, customTo(HQ, [{ userId: BEN, map: [['r-contrib-north', 'r-contrib-north']] }]));
    const first = (await run(env, planned))!;
    expect(first.users[0]?.steps.find((s) => s.kind === 'moveUser')?.outcome).toBe('failed');
    const rec = await reconcileResult(first, userStateReader(env.reader));
    const retry = planRetryOf(planned, rec.retry)!;
    const keys = retry.writes.plan?.writes.map((w) => w.key) ?? [];
    expect(keys).toEqual([`moveUser:${BEN}:${HQ}`, `assignRole:${BEN}:r-contrib-north`]);
    const second = (await run(env, retry))!;
    expect(second.overall).toBe('succeeded');
    expect(second.users[0]?.steps.map((s) => [s.kind, s.outcome])).toEqual([['moveUser', 'succeeded'], ['assignRole', 'succeeded']]);
    const after = env.snapshot();
    expect(after.users.find((u) => u.id === BEN)?.businessUnitId).toBe(HQ);
    expect(after.directAssignments.some((a) => a.userId === BEN && a.roleId === 'r-contrib-north')).toBe(true);
  });
});

describe('users the run never reaches keep every planned step', () => {
  it('lists the move AND every role assignment of an unreached user, so reconciliation and a retry cover them', async () => {
    const env = createFakeEnvironment({ failWrite: { kind: 'moveUser', nth: 1, result: failure('identity') } });
    const { planned } = await plan(env, customTo(NORTH, [{ userId: CARA, map: [['r-contrib', 'r-contrib-north']] }, { userId: 'u-ann', map: [['r-admin', 'r-sales'], ['r-contrib', 'r-contrib-north']] }]));
    const result = (await run(env, planned))!;
    const ann = result.users.find((u) => u.userId === 'u-ann')!;
    expect(ann.overall).toBe('skipped');
    expect(ann.steps.map((x) => x.kind)).toEqual(['moveUser', 'assignRole', 'assignRole']);
    expect(ann.steps.every((x) => x.outcome === 'skipped' && !x.sent)).toBe(true);
    // A later read proves all of them absent: every step is a retry candidate (no role is silently dropped).
    const rec = await reconcileResult(result, userStateReader(env.reader));
    expect(rec.retry.find((c) => c.userId === 'u-ann')?.steps.map((x) => x.kind)).toEqual(['moveUser', 'assignRole', 'assignRole']);
    const again = planRetryOf(planned, rec.retry)!;
    const keys = again.writes.plan?.writes.map((w) => w.key) ?? [];
    expect(keys).toContain('assignRole:u-ann:r-sales');
    expect(keys).toContain('assignRole:u-ann:r-contrib-north');
  });

  it('a roles-only run reports only assignments for an unreached user, never a synthetic move', async () => {
    const env = createFakeEnvironment({ failWrite: { kind: 'assignRole', nth: 1, result: failure('identity') } });
    const { planned } = await plan(env, customTo(NORTH, [{ userId: CARA, map: [['r-contrib', 'r-contrib-north']] }, { userId: 'u-pat', map: [['r-basic', 'r-contrib-north']] }]));
    const only = new Set([`assignRole:${CARA}:r-contrib-north`, 'assignRole:u-pat:r-contrib-north']);
    const approval = approvePlan(writesForPlan(planned.plan, only).plan!, 'env-1', 'tester', Date.now());
    const inNorth = async () => ({ businessUnitId: NORTH, directRoleIds: [] as string[], rolesComplete: true });
    const result = await executeBuMove({ plan: planned.plan, approval, writer: env.writer, readState: inNorth, only });
    expect(result.stoppedReason).toContain('stopped');
    const pat = result.users.find((u) => u.userId === 'u-pat')!;
    expect(pat.steps.map((x) => x.kind)).toEqual(['assignRole']);
  });
});

describe('an assignment that is not proven stops the run', () => {
  const dropRole = (env: ReturnType<typeof createFakeEnvironment>, complete: boolean) => {
    const base = userStateReader(env.reader);
    return async (id: string) => {
      const st = await base(id);
      return st && st.businessUnitId === NORTH ? { ...st, directRoleIds: st.directRoleIds.filter((r) => r !== 'r-contrib-north' && r !== 'r-sales'), rolesComplete: complete } : st;
    };
  };

  it('an accepted assignment followed by an INCOMPLETE re-read is notVerified and nothing more is sent (no further steps, no later users)', async () => {
    const env = createFakeEnvironment();
    const { planned } = await plan(env, customTo(NORTH, [{ userId: CARA, map: [['r-contrib', 'r-contrib-north']] }, { userId: 'u-pat', map: [['r-basic', 'r-contrib-north']] }]));
    const approval = approvePlan(planned.writes.plan!, 'env-1', 'tester', Date.now());
    const result = await executeBuMove({ plan: planned.plan, approval, writer: env.writer, readState: dropRole(env, false) });
    expect(result.users[0]?.steps.map((x) => x.outcome)).toEqual(['succeeded', 'notVerified']);
    expect(result.stoppedReason).toContain('could not be verified');
    expect(result.users[1]?.overall).toBe('skipped');
    expect(env.writes).toEqual([`moveUser:${CARA}:${NORTH}`, `assignRole:${CARA}:r-contrib-north`]);
  });

  it('a definitively failed assignment (complete re-read, role absent) stops that user: the remaining roles are not sent', async () => {
    const env = createFakeEnvironment();
    const { planned } = await plan(env, customTo(NORTH, [{ userId: 'u-ann', map: [['r-admin', 'r-sales'], ['r-contrib', 'r-contrib-north']] }]));
    expect(planned.writes.plan?.writes.filter((w) => w.kind === 'assignRole')).toHaveLength(2);
    const approval = approvePlan(planned.writes.plan!, 'env-1', 'tester', Date.now());
    const result = await executeBuMove({ plan: planned.plan, approval, writer: env.writer, readState: dropRole(env, true) });
    expect(result.users[0]?.steps.map((x) => x.outcome)).toEqual(['succeeded', 'failed', 'skipped']);
    expect(env.writes).toHaveLength(2); // the move and the first assignment only
  });
});

describe('reconcile: a previously verified role that a complete read proves absent is no longer a success', () => {
  it('turns the step into failed, lists it as a retry candidate and cannot report overall success', async () => {
    const env = createFakeEnvironment({ failWrite: { kind: 'assignRole', nth: 2, result: failure('throttling') } });
    const { planned } = await plan(env, customTo(NORTH, [{ userId: 'u-ann', map: [['r-admin', 'r-sales'], ['r-contrib', 'r-contrib-north']] }]));
    const result = (await run(env, planned))!;
    expect(result.users[0]?.steps.map((x) => x.outcome)).toEqual(['succeeded', 'succeeded', 'failed']);
    // The failed step has since been applied by someone else, but the first role is gone.
    const rec = await reconcileResult(result, async () => ({ businessUnitId: NORTH, directRoleIds: ['r-sales'], rolesComplete: true }));
    const steps = rec.result.users[0]!.steps;
    expect(steps.filter((x) => x.kind === 'assignRole').map((x) => x.outcome)).toEqual(['failed', 'succeeded']);
    expect(rec.result.overall).not.toBe('succeeded');
    expect(rec.retry[0]?.steps.map((x) => x.roleId)).toEqual(['r-contrib-north']);
    // An incomplete read proves nothing: the verified step is left as it was.
    const unknown = await reconcileResult(result, async () => ({ businessUnitId: NORTH, directRoleIds: [], rolesComplete: false }));
    expect(unknown.result.users[0]?.steps[1]?.outcome).toBe('succeeded');
  });
});

describe('export: email addresses in free text are redacted', () => {
  it('removes an address from names, descriptions and messages in both CSV and JSON', async () => {
    const withMail = { ...SYNTHETIC_ACCESS_SNAPSHOT, users: SYNTHETIC_ACCESS_SNAPSHOT.users.map((u) => (u.id === BEN ? { ...u, fullName: 'Ben ben.brooks@corp.example' } : u)) };
    const env = createFakeEnvironment({ snapshot: withMail });
    const { planned } = await plan(env);
    const result = (await run(env, planned))!;
    const csv = resultToCsv(result);
    const json = resultToJson(result);
    for (const text of [csv, json]) {
      expect(text).not.toContain('ben.brooks@corp.example');
      expect(text).toContain('[email removed]');
    }
    expect(redactEmails('Moved to a.b+c@x.example.com, see d@y.org.')).toBe('Moved to [email removed], see [email removed].');
    expect(redactEmails('no address here')).toBe('no address here');
  });
});

describe('operation history: a Business Unit move is recorded', () => {
  it('a verified move and role restore are verified steps of one entry with the target and correlation ids', async () => {
    const led = testLedger();
    const { env, planned } = await plan();
    const result = await run(env, planned, { recorder: led.recorder });
    const [rec] = await led.records();
    expect(await led.records()).toHaveLength(1);
    expect(rec).toMatchObject({ operationId: result?.operationId, environmentId: 'env-1', actor: 'tester', source: 'user' });
    expect(rec?.correlationId).toMatch(/^[0-9a-f]{32}$/);
    expect(rec?.steps.map((s) => [s.kind, s.outcome, s.verified])).toEqual([['moveUser', 'succeeded', true], ['assignRole', 'succeeded', true]]);
    expect(deriveStatus(rec!)).toBe('succeeded');
  });

  it('records the placement before and after on the move step and role states on the role steps (schema v2)', async () => {
    const led = testLedger();
    const { env, planned } = await plan();
    await run(env, planned, { recorder: led.recorder });
    const [rec] = await led.records();
    expect(rec?.schemaVersion).toBe(2);
    expect(rec?.steps[0]).toMatchObject({
      kind: 'moveUser',
      before: { kind: 'userPlacement', businessUnitId: NORTH },
      after: { kind: 'userPlacement', businessUnitId: HQ },
      stateIntegrity: 'ok',
    });
    expect(Array.isArray((rec?.steps[0]?.before as { roleIds: unknown } | undefined)?.roleIds)).toBe(true);
    expect(rec?.steps[1]).toMatchObject({ kind: 'assignRole', before: { kind: 'roleHeld', held: false }, after: { kind: 'roleHeld', held: true } });
  });

  it('a verified step that sent nothing (already satisfied) still records its unchanged state, so the operation stays restorable', async () => {
    const { env, planned } = await plan();
    await run(env, planned); // the user is moved and has the role
    const led = testLedger();
    await run(env, planned, { recorder: led.recorder }); // everything is satisfied: no request, verified no-op steps
    const [rec] = await led.records();
    expect(rec?.steps.map((s) => s.outcome)).toEqual(['succeeded', 'succeeded']);
    for (const st of rec!.steps) {
      expect(st.before).toBeDefined();
      expect(st.after).toEqual(st.before); // unchanged
      expect(st.stateIntegrity).toBe('ok');
    }
  });

  it('an accepted move the read does not show is failed and the role step is skipped, never verified', async () => {
    const led = testLedger();
    const { env, planned } = await plan(createFakeEnvironment({ ignoreWrites: true }));
    await run(env, planned, { recorder: led.recorder });
    const [rec] = await led.records();
    expect(rec?.steps.map((s) => [s.outcome, s.verified])).toEqual([['failed', false], ['skipped', false]]);
    expect(isVerified(rec!)).toBe(false);
  });

  it('a classified refusal keeps its failure class and that no request was sent', async () => {
    const led = testLedger();
    const env = createFakeEnvironment();
    const { planned } = await plan(env);
    const refusing = { ...env.writer, moveUser: async () => refused('identity', 'The environment id could not be verified, and writes require it. No change was sent.') };
    await confirmAndRun({ planned, writer: refusing, reader: env.reader, actor: 'tester', environmentId: 'env-1', recorder: led.recorder });
    const [rec] = await led.records();
    expect(rec?.steps[0]).toMatchObject({ kind: 'moveUser', outcome: 'failed', failure: 'identity' });
  });

  it('an unconfirmed result stays uncertain in the ledger and no rollback is implied', async () => {
    const led = testLedger();
    const env = createFakeEnvironment();
    const { planned } = await plan(env);
    const uncertain = { ...env.writer, moveUser: async () => failure('connection', 'uncertain') };
    await confirmAndRun({ planned, writer: uncertain, reader: env.reader, actor: 'tester', environmentId: 'env-1', recorder: led.recorder });
    const [rec] = await led.records();
    expect(rec?.steps[0]).toMatchObject({ outcome: 'uncertain', verified: false });
    expect(deriveStatus(rec!)).toBe('uncertain');
  });

  it('a ledger that stops working after the intent never changes or hides the write result', async () => {
    const recorder = new OperationRecorder(flakyStore(1));
    const { env, planned } = await plan();
    const result = await run(env, planned, { recorder });
    expect(result?.overall).toBe('succeeded');
    expect(env.writes).toEqual([`moveUser:${BEN}:${HQ}`, `assignRole:${BEN}:r-contrib`]);
    expect(recorder.lastSaveError).toBe('storage unavailable');
  });

  it('when the intent cannot be written nothing is sent and every user is reported as not attempted', async () => {
    const { env, planned } = await plan();
    const result = await run(env, planned, { recorder: new OperationRecorder(flakyStore(0)) });
    expect(env.writes).toEqual([]);
    expect(result?.overall).toBe('failed');
    expect(result?.stoppedReason).toBe(HISTORY_BLOCKED_MESSAGE);
    expect(result?.users[0]?.steps.every((s) => s.outcome === 'skipped' && !s.sent)).toBe(true);
  });

  it('a retry is recorded as a retry of the operation it follows', async () => {
    const led = testLedger();
    const { env, planned } = await plan(createFakeEnvironment({ ignoreWrites: true }));
    const first = await run(env, planned, { recorder: led.recorder });
    const retry = planRetryOf(planned, [{ userId: BEN, userName: 'Ben', steps: [{ key: `moveUser:${BEN}:${HQ}`, kind: 'moveUser', description: 'move' }] } as never]);
    if (!retry) throw new Error('no retry plan');
    await run(env, { ...retry, sourceOperationId: first?.operationId }, { recorder: led.recorder });
    const records = await led.records();
    expect(records).toHaveLength(2);
    expect(records.find((r) => r.operationId !== first?.operationId)).toMatchObject({ source: 'retry', sourceOperationId: first?.operationId });
  });
});

describe('operation history: a step the read decides FAILED never keeps failure class none (BU move)', () => {
  it('an accepted move the read does not show is an execution failure, and the advice does not say "(none)"', async () => {
    const led = testLedger();
    const { env, planned } = await plan(createFakeEnvironment({ ignoreWrites: true }));
    await run(env, planned, { recorder: led.recorder });
    const [rec] = await led.records();
    expect(rec?.steps[0]).toMatchObject({ kind: 'moveUser', outcome: 'failed', failure: 'execution' });
    expect(analyzeOperation(rec!).advice[0]?.reason).not.toContain('(none)');
  });
});
