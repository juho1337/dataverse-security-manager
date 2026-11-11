import { describe, expect, it, vi } from 'vitest';
import { approvePlan, createWritePlan, plannedWrite, type PlannedWrite } from '../../../domain/operations';
import { APPROVED_DEVELOPER_ENVIRONMENT } from '../config';
import { HostCallError } from '../errors';
import type { IdentityResult } from '../identity';
import { createWriteBoundary, type AllowedWriteCalls, type RawWriteApi } from './boundary';

const ENV = APPROVED_DEVELOPER_ENVIRONMENT;
const ROLE = '11111111-1111-1111-1111-111111111111';
const OTHER_ROLE = '44444444-4444-4444-4444-444444444444';
const PRIV = '22222222-2222-2222-2222-222222222222';
const USER = '33333333-3333-3333-3333-333333333333';
const BU = '55555555-5555-5555-5555-555555555555';

const VERIFIED: IdentityResult = {
  status: 'verified',
  writesAllowed: true,
  environment: { url: ENV.url, organizationId: ENV.organizationId, environmentId: ENV.environmentId, key: ENV.environmentId },
};

function setup(writes: PlannedWrite[], overrides: { identity?: () => Promise<IdentityResult>; raw?: RawWriteApi; now?: number } = {}) {
  const raw: RawWriteApi = overrides.raw ?? {
    associate: vi.fn(async () => undefined),
    disassociate: vi.fn(async () => undefined),
    execute: vi.fn(async () => ({})),
    update: vi.fn(async () => undefined),
  };
  const verifyIdentity = vi.fn(overrides.identity ?? (async () => VERIFIED));
  const boundary = createWriteBoundary({ raw, verifyIdentity, now: () => overrides.now ?? 1_000 });
  const approval = approvePlan(createWritePlan(writes), ENV.environmentId, 'Owner', 0, { lifetimeMs: 60_000 });
  return { raw, boundary, approval, verifyIdentity };
}

const assign = plannedWrite.assignRole(USER, ROLE, 'Assign');

describe('write boundary: confirmation', () => {
  it('sends nothing for a write outside the confirmed plan', async () => {
    const { boundary, approval, raw } = setup([assign]);
    const other = plannedWrite.unassignRole(USER, ROLE, 'Unassign');
    const result = await boundary.run(approval, other, (c) => c.disassociate('systemuser', USER, 'systemuserroles_association', ROLE));
    expect(result).toMatchObject({ outcome: 'failed', failure: 'validation' });
    expect(raw.disassociate).not.toHaveBeenCalled();
  });

  it('sends nothing after the confirmation expired', async () => {
    const { boundary, approval, raw } = setup([assign], { now: 61_000 });
    const result = await boundary.run(approval, assign, (c) => c.associate('systemuser', USER, 'systemuserroles_association', 'role', ROLE));
    expect(result.failure).toBe('validation');
    expect(raw.associate).not.toHaveBeenCalled();
  });
});

describe('write boundary: identity', () => {
  const refusedIdentity: IdentityResult = {
    status: 'refused', reason: 'urlMismatch', writesAllowed: false, expected: 'a', reported: 'b', message: 'Environment check failed (organization URL): expected a, host reported b. No data was read.',
  };

  it.each<[string, IdentityResult]>([
    ['refused identity', refusedIdentity],
    ['unverifiable environment id (writes require all three checks)', { status: 'environmentIdUnverifiable', writesAllowed: false }],
  ])('blocks the write on %s', async (_name, identity) => {
    const { boundary, approval, raw } = setup([assign], { identity: async () => identity });
    const result = await boundary.run(approval, assign, (c) => c.associate('systemuser', USER, 'systemuserroles_association', 'role', ROLE));
    expect(result).toMatchObject({ outcome: 'failed', failure: 'identity' });
    expect(raw.associate).not.toHaveBeenCalled();
  });

  it('blocks the write when the identity check itself throws', async () => {
    const { boundary, approval, raw } = setup([assign], { identity: async () => { throw new Error('boom'); } });
    const result = await boundary.run(approval, assign, (c) => c.associate('systemuser', USER, 'systemuserroles_association', 'role', ROLE));
    expect(result.failure).toBe('identity');
    expect(raw.associate).not.toHaveBeenCalled();
  });

  it('refuses a confirmation given for a different environment', async () => {
    const { boundary, raw } = setup([assign]);
    const foreign = approvePlan(createWritePlan([assign]), '99999999-9999-9999-9999-999999999999', 'Owner', 0, { lifetimeMs: 60_000 });
    const result = await boundary.run(foreign, assign, (c) => c.associate('systemuser', USER, 'systemuserroles_association', 'role', ROLE));
    expect(result.failure).toBe('validation');
    expect(raw.associate).not.toHaveBeenCalled();
  });

  it('verifies the identity again before every write', async () => {
    const second = plannedWrite.assignRole(USER, OTHER_ROLE, 'Assign 2');
    const { boundary, approval, verifyIdentity } = setup([assign, second]);
    await boundary.run(approval, assign, (c) => c.associate('systemuser', USER, 'systemuserroles_association', 'role', ROLE));
    await boundary.run(approval, second, (c) => c.associate('systemuser', USER, 'systemuserroles_association', 'role', OTHER_ROLE));
    expect(verifyIdentity).toHaveBeenCalledTimes(2);
  });
});

describe('write boundary: allow-list', () => {
  it('accepts the planned association and reports notVerified, never success', async () => {
    const { boundary, approval, raw } = setup([assign]);
    const result = await boundary.run(approval, assign, (c) => c.associate('systemuser', `{${USER.toUpperCase()}}`, 'systemuserroles_association', 'role', ROLE));
    expect(result).toMatchObject({ outcome: 'notVerified', failure: 'none' });
    expect(raw.associate).toHaveBeenCalledWith('systemuser', USER, 'systemuserroles_association', 'role', ROLE, 'primary');
  });

  it.each([
    ['another user', (c: Parameters<Parameters<ReturnType<typeof createWriteBoundary>['run']>[2]>[0]) => c.associate('systemuser', OTHER_ROLE, 'systemuserroles_association', 'role', ROLE)],
    ['another role', (c: Parameters<Parameters<ReturnType<typeof createWriteBoundary>['run']>[2]>[0]) => c.associate('systemuser', USER, 'systemuserroles_association', 'role', OTHER_ROLE)],
    ['another relationship', (c: Parameters<Parameters<ReturnType<typeof createWriteBoundary>['run']>[2]>[0]) => c.associate('systemuser', USER, 'teamroles_association', 'role', ROLE)],
    ['another table', (c: Parameters<Parameters<ReturnType<typeof createWriteBoundary>['run']>[2]>[0]) => c.associate('team', USER, 'systemuserroles_association', 'role', ROLE)],
    ['a different call kind', (c: Parameters<Parameters<ReturnType<typeof createWriteBoundary>['run']>[2]>[0]) => c.disassociate('systemuser', USER, 'systemuserroles_association', ROLE)],
    ['an unrelated action', (c: Parameters<Parameters<ReturnType<typeof createWriteBoundary>['run']>[2]>[0]) => c.execute({ operationName: 'DeleteRole', operationType: 'action', entityName: 'role', entityId: ROLE })],
  ])('blocks %s for an assignRole write', async (_name, call) => {
    const { boundary, approval, raw } = setup([assign]);
    const result = await boundary.run(approval, assign, call);
    expect(result).toMatchObject({ outcome: 'failed', failure: 'validation' });
    expect(raw.associate).not.toHaveBeenCalled();
    expect(raw.disassociate).not.toHaveBeenCalled();
    expect(raw.execute).not.toHaveBeenCalled();
  });

  it('allows the planned privilege action only on the planned role, privilege and depth', async () => {
    const add = plannedWrite.addPrivilege(ROLE, PRIV, 'Local', 'Add');
    const { boundary, approval, raw } = setup([add]);
    const ok = await boundary.run(approval, add, (c) =>
      c.execute({ operationName: 'AddPrivilegesRole', operationType: 'action', entityName: 'role', entityId: ROLE, parameters: { Privileges: [{ PrivilegeId: PRIV, Depth: 'Local', BusinessUnitId: BU }] } }));
    expect(ok.outcome).toBe('notVerified');

    for (const bad of [
      { entityId: OTHER_ROLE, parameters: { Privileges: [{ PrivilegeId: PRIV, Depth: 'Local' }] } },
      { entityId: ROLE, parameters: { Privileges: [{ PrivilegeId: OTHER_ROLE, Depth: 'Local' }] } },
      { entityId: ROLE, parameters: { Privileges: [{ PrivilegeId: PRIV, Depth: 'Global' }] } },
    ]) {
      const r = await boundary.run(approval, add, (c) => c.execute({ operationName: 'AddPrivilegesRole', operationType: 'action', entityName: 'role', ...bad }));
      expect(r.failure).toBe('validation');
    }
    expect(raw.execute).toHaveBeenCalledTimes(1);
  });

  it('allows moveUser only as an Update of systemuser.businessunitid to the planned Business Unit', async () => {
    const move = plannedWrite.moveUser(USER, BU, 'Move');
    const { boundary, approval, raw } = setup([move]);
    const update = raw.update as ReturnType<typeof vi.fn>;
    const call = (entity: string, id: string, record: Record<string, unknown>) => (c: AllowedWriteCalls) => c.update(entity, id, record);
    const good = { 'businessunitid@odata.bind': `/businessunits(${BU})` };
    expect((await boundary.run(approval, move, call('systemuser', USER, good))).outcome).toBe('notVerified');
    // The request that reaches the host is the canonical one built from the plan.
    expect(update).toHaveBeenLastCalledWith('systemuser', USER, { 'businessunitid@odata.bind': `/businessunits(${BU})` }, 'primary');
    // Other spellings of the same bind are normalised.
    expect((await boundary.run(approval, move, call('systemuser', `{${USER.toUpperCase()}}`, { 'businessunitid@odata.bind': `businessunits({${BU.toUpperCase()}})` }))).outcome).toBe('notVerified');
    expect(update).toHaveBeenLastCalledWith('systemuser', USER, { 'businessunitid@odata.bind': `/businessunits(${BU})` }, 'primary');
    const bad: [string, string, Record<string, unknown>][] = [
      ['systemuser', USER, { 'businessunitid@odata.bind': `/businessunits(${OTHER_ROLE})` }],
      ['systemuser', OTHER_ROLE, good],
      ['team', USER, good],
      ['systemuser', USER, { ...good, isdisabled: true }],
      ['systemuser', USER, { isdisabled: true }],
      ['systemuser', USER, { 'businessunitid@odata.bind': `/teams(${BU})` }],
      ['systemuser', USER, { 'businessunitid@odata.bind': BU }],
      ['systemuser', USER, { businessunitid: BU }],
      ['systemuser', USER, { 'businessunitid@odata.bind': [`/businessunits(${BU})`] }],
    ];
    for (const [entity, id, record] of bad) {
      expect((await boundary.run(approval, move, call(entity, id, record))).failure, JSON.stringify([entity, id, record])).toBe('validation');
    }
    expect(update).toHaveBeenCalledTimes(2);
  });

  it('refuses the deprecated SetBusinessSystemUser action for a move, and update for any other write kind', async () => {
    const move = plannedWrite.moveUser(USER, BU, 'Move');
    const m = setup([move]);
    const r = await m.boundary.run(m.approval, move, (c) =>
      c.execute({ operationName: 'SetBusinessSystemUser', operationType: 'action', entityName: 'systemuser', entityId: USER, parameters: {} }));
    expect(r).toMatchObject({ outcome: 'failed', failure: 'validation' });
    expect(m.raw.execute).not.toHaveBeenCalled();
    const assign = plannedWrite.assignRole(USER, ROLE, 'Assign');
    const a = setup([assign]);
    const r2 = await a.boundary.run(a.approval, assign, (c) => c.update('systemuser', USER, { 'businessunitid@odata.bind': `/businessunits(${BU})` }));
    expect(r2).toMatchObject({ outcome: 'failed', failure: 'validation' });
    expect(a.raw.update).not.toHaveBeenCalled();
  });

  it('rejects extra or conflicting privilege entries, not just the approved one', async () => {
    const add = plannedWrite.addPrivilege(ROLE, PRIV, 'Local', 'Add');
    const { boundary, approval, raw } = setup([add]);
    const req = (parameters: unknown) => (c: AllowedWriteCalls) =>
      c.execute({ operationName: 'AddPrivilegesRole', operationType: 'action', entityName: 'role', entityId: ROLE, parameters: parameters as Record<string, unknown> });
    const entry = { PrivilegeId: PRIV, Depth: 'Local', BusinessUnitId: BU };
    for (const bad of [
      { Privileges: [entry, { PrivilegeId: OTHER_ROLE, Depth: 'Global', BusinessUnitId: BU }] },
      { Privileges: [entry, entry] },
      { Privileges: [{ ...entry, Extra: 1 }] },
      { Privileges: [{ PrivilegeId: PRIV, Depth: 'Local' }] },
      { Privileges: [{ ...entry, BusinessUnitId: 'not-a-guid' }] },
      { Privileges: [entry], Other: true },
      { Privileges: entry },
    ]) {
      expect((await boundary.run(approval, add, req(bad))).failure).toBe('validation');
    }
    expect(raw.execute).not.toHaveBeenCalled();
    // The numeric depth code (Local = 1) is the same depth; a different code is not.
    expect((await boundary.run(approval, add, req({ Privileges: [{ ...entry, Depth: 1 }] }))).outcome).toBe('notVerified');
    expect((await boundary.run(approval, add, req({ Privileges: [{ ...entry, Depth: 3 }] }))).failure).toBe('validation');
  });

  it('validates the remove-privilege action exactly (parameter Privilege, a privilege reference)', async () => {
    const rm = plannedWrite.removePrivilege(ROLE, PRIV, 'Remove');
    const { boundary, approval, raw } = setup([rm]);
    const ref = (id: string) => ({ '@odata.type': 'Microsoft.Dynamics.CRM.privilege', privilegeid: id });
    const req = (parameters: Record<string, unknown>) => (c: AllowedWriteCalls) =>
      c.execute({ operationName: 'RemovePrivilegeRole', operationType: 'action', entityName: 'role', entityId: ROLE, parameters });
    for (const bad of [
      { Privilege: ref(OTHER_ROLE) },
      { Privilege: ref(PRIV), More: 1 },
      { PrivilegeId: PRIV },
      { Privilege: PRIV },
      { Privilege: { ...ref(PRIV), '@odata.type': 'Microsoft.Dynamics.CRM.role' } },
      { Privilege: { ...ref(PRIV), extra: 1 } },
    ]) {
      expect((await boundary.run(approval, rm, req(bad))).failure).toBe('validation');
    }
    expect((await boundary.run(approval, rm, req({ Privilege: ref(PRIV) }))).outcome).toBe('notVerified');
    expect(raw.execute).toHaveBeenCalledTimes(1);
  });
});

describe('write boundary: beforeDispatch', () => {
  const assign = plannedWrite.assignRole(USER, ROLE, 'Assign');
  const mk = (beforeDispatch: () => Promise<void> | void) => {
    const raw: RawWriteApi = { associate: vi.fn(async () => undefined) };
    const boundary = createWriteBoundary({ raw, verifyIdentity: async () => VERIFIED, now: () => 1_000, beforeDispatch });
    const approval = approvePlan(createWritePlan([assign]), ENV.environmentId, 'Owner', 0, { lifetimeMs: 60_000 });
    return { raw, boundary, approval };
  };

  it('runs right before the call and lets it through when it passes', async () => {
    const order: string[] = [];
    const m = mk(() => { order.push('guard'); });
    (m.raw.associate as ReturnType<typeof vi.fn>).mockImplementation(async () => { order.push('send'); });
    const r = await m.boundary.run(m.approval, assign, (c) => c.associate('systemuser', USER, 'systemuserroles_association', 'role', ROLE));
    expect(r.outcome).toBe('notVerified');
    expect(order).toEqual(['guard', 'send']);
  });

  it('refuses, with nothing sent and nothing reported as possibly applied, when it throws (sync or async)', async () => {
    for (const guard of [() => { throw new Error('x'); }, async () => { throw new Error('y'); }]) {
      const m = mk(guard);
      const r = await m.boundary.run(m.approval, assign, (c) => c.associate('systemuser', USER, 'systemuserroles_association', 'role', ROLE));
      expect(r).toMatchObject({ outcome: 'failed', failure: 'validation' });
      expect(r.message).toMatch(/not sent|Nothing was sent/);
      expect(m.raw.associate).not.toHaveBeenCalled();
    }
  });

  it('still allows exactly one host call while the guard is pending', async () => {
    let release: () => void = () => undefined;
    const m = mk(() => new Promise<void>((resolve) => { release = resolve; }));
    const calls = (c: Parameters<Parameters<typeof m.boundary.run>[2]>[0]) => {
      const first = c.associate('systemuser', USER, 'systemuserroles_association', 'role', ROLE);
      const second = c.associate('systemuser', USER, 'systemuserroles_association', 'role', ROLE).catch(() => 'refused');
      return Promise.all([first, second]).finally(() => undefined);
    };
    const pending = m.boundary.run(m.approval, assign, async (c) => { const p = calls(c); await Promise.resolve(); release(); await p; });
    const r = await pending;
    expect(m.raw.associate).toHaveBeenCalledTimes(1);
    expect(r.outcome).toBeDefined();
  });
});

describe('write boundary: content binding and dispatch tracking', () => {
  it('refuses a write that keeps an approved key but changes its contents', async () => {
    const { boundary, approval, raw } = setup([assign]);
    const tampered = { ...assign, roleId: OTHER_ROLE } as PlannedWrite;
    const result = await boundary.run(approval, tampered, (c) => c.associate('systemuser', USER, 'systemuserroles_association', 'role', OTHER_ROLE));
    expect(result).toMatchObject({ outcome: 'failed', failure: 'validation' });
    expect(raw.associate).not.toHaveBeenCalled();
    const retyped = { ...assign, kind: 'unassignRole' } as PlannedWrite;
    expect((await boundary.run(approval, retyped, (c) => c.disassociate('systemuser', USER, 'systemuserroles_association', ROLE))).failure).toBe('validation');
    expect(raw.disassociate).not.toHaveBeenCalled();
  });

  it('refuses a confirmation whose plan was altered after approval', async () => {
    const { boundary, approval, raw } = setup([assign]);
    const swapped = { ...plannedWrite.assignRole(USER, OTHER_ROLE, 'Assign'), key: assign.key } as PlannedWrite;
    const forged = { ...approval, plan: { ...approval.plan, writes: [swapped] } };
    const result = await boundary.run(forged, swapped, (c) => c.associate('systemuser', USER, 'systemuserroles_association', 'role', OTHER_ROLE));
    expect(result.failure).toBe('validation');
    expect(raw.associate).not.toHaveBeenCalled();
  });

  it('keeps the outcome uncertain when a blocked call follows a call that was sent', async () => {
    const { boundary, approval, raw } = setup([assign]);
    const result = await boundary.run(approval, assign, async (c) => {
      await c.associate('systemuser', USER, 'systemuserroles_association', 'role', ROLE);
      await c.disassociate('systemuser', USER, 'systemuserroles_association', ROLE);
    });
    expect(result.outcome).toBe('uncertain');
    expect(result.message).not.toMatch(/Nothing was sent/);
    expect(raw.associate).toHaveBeenCalledTimes(1);
    expect(raw.disassociate).not.toHaveBeenCalled();
  });

  it('allows exactly one host call per planned write', async () => {
    const { boundary, approval, raw } = setup([assign]);
    const result = await boundary.run(approval, assign, async (c) => {
      await c.associate('systemuser', USER, 'systemuserroles_association', 'role', ROLE);
      await c.associate('systemuser', USER, 'systemuserroles_association', 'role', ROLE);
    });
    expect(result.outcome).toBe('uncertain');
    expect(raw.associate).toHaveBeenCalledTimes(1);
  });

  it('does not report success when the executor made no host call', async () => {
    const { boundary, approval } = setup([assign]);
    expect(await boundary.run(approval, assign, async () => undefined)).toMatchObject({ outcome: 'failed', failure: 'validation' });
  });
});

describe('write boundary: failures', () => {
  const failing = (error: unknown): RawWriteApi => ({ associate: async () => { throw error; } });
  const run = (error: unknown) => {
    const { boundary, approval } = setup([assign], { raw: failing(error) });
    return boundary.run(approval, assign, (c) => c.associate('systemuser', USER, 'systemuserroles_association', 'role', ROLE));
  };

  it('classifies permission and throttling as failed (nothing applied)', async () => {
    expect(await run(Object.assign(new Error('Forbidden'), { status: 403 }))).toMatchObject({ outcome: 'failed', failure: 'permission' });
    expect(await run(Object.assign(new Error('Too many'), { status: 429 }))).toMatchObject({ outcome: 'failed', failure: 'throttling' });
  });

  it('classifies network and unknown errors as uncertain, to be resolved by a re-read', async () => {
    expect(await run(new Error('Failed to fetch'))).toMatchObject({ outcome: 'uncertain', failure: 'connection' });
    expect(await run(new Error('weird'))).toMatchObject({ outcome: 'uncertain', failure: 'execution' });
  });

  it('does not leak service text or tokens into the result', async () => {
    const result = await run(new HostCallError({ kind: 'unknown', message: 'Bearer abc.def secret Contoso payroll role' }));
    expect(JSON.stringify(result)).not.toMatch(/Bearer|Contoso|payroll/);
  });

  it('reports a missing host method as a boundary violation, not a crash', async () => {
    const { boundary, approval } = setup([assign], { raw: {} });
    const result = await boundary.run(approval, assign, (c) => c.associate('systemuser', USER, 'systemuserroles_association', 'role', ROLE));
    expect(result.failure).toBe('validation');
  });
});
