import { describe, expect, it, vi } from 'vitest';
import { explainUserAccess } from '../../domain/buMove/userAccess';
import type { UserAccess } from '../../domain/buMove/types';
import { SYNTHETIC_ACCESS_SNAPSHOT } from '../../adapters/fixture/accessFixture';
import type { ReadResult } from '../../ports/accessReader';
import type { SecurityDataWriter } from '../../ports/securityDataWriter';
import { confirmAndApplyBulk, planBulkAssignments, summarizeApplied } from './bulk';

// Synthetic only: users of two business units, one logical role with a copy in each unit.
const S = SYNTHETIC_ACCESS_SNAPSHOT;
const held = (): Set<string> => new Set(S.directAssignments.map((a) => `${a.userId}|${a.roleId}`));
const accessOf = (set: ReadonlySet<string>, userId: string): UserAccess =>
  explainUserAccess({ ...S, directAssignments: [...set].map((k) => ({ userId: k.split('|')[0] as string, roleId: k.split('|')[1] as string })) }, userId);
const northRoles = S.roles.filter((r) => r.businessUnitId === 'bu-north');

function fakeEnvironment(failFor: string[] = []) {
  const set = held();
  const calls: string[] = [];
  const writer: SecurityDataWriter = {
    addPrivilege: vi.fn(), removePrivilege: vi.fn(), moveUser: vi.fn(), unassignRole: vi.fn(),
    assignRole: async (_a, userId, roleId) => {
      calls.push(`${userId}|${roleId}`);
      if (failFor.includes(userId)) return { outcome: 'failed', message: 'Dataverse refused the change.', failure: 'permission' };
      set.add(`${userId}|${roleId}`);
      return { outcome: 'notVerified', message: 'Accepted.', failure: 'none' };
    },
  };
  const reader = { loadUserAccess: async (userId: string): Promise<ReadResult<UserAccess>> => ({ status: 'ok', data: accessOf(set, userId) }) };
  return { set, calls, writer, reader };
}

const planFor = (users: string[], roleIds: string[], crossBuAssignment: boolean | null) =>
  planBulkAssignments({ accesses: users.map((u) => accessOf(held(), u)), catalog: northRoles, businessUnits: S.businessUnits, crossBuAssignment, roleIds });

describe('planBulkAssignments', () => {
  it('shows user, role and target business unit per row, and refuses users of other units when assignment across units is off', () => {
    const p = planFor(['u-ben', 'u-cara'], ['r-sales'], false); // Ben is in North (home), Cara in Contoso
    expect(p.rows.map((r) => [r.userName, r.item.roleName, r.item.businessUnitName, r.item.status])).toEqual([
      ['Ben Brooks', 'Sales Manager', 'North', 'planned'],
      ['Cara Cole', 'Sales Manager', 'North', 'refused'],
    ]);
    expect(p.writeCount).toBe(1);
  });

  it('assigns across units for users of different home units when the setting is on', () => {
    const p = planFor(['u-ben', 'u-cara', 'u-ann'], ['r-sales', 'r-contrib-north'], true);
    expect(p.rows.filter((r) => r.item.status === 'planned').map((r) => `${r.userId}|${r.item.roleId}`).sort()).toEqual([
      'u-ann|r-contrib-north', 'u-ann|r-sales', 'u-ben|r-sales', 'u-cara|r-contrib-north', 'u-cara|r-sales',
    ]); // Ben already holds r-contrib-north directly: nothing is sent for it
    expect(p.rows.find((r) => r.userId === 'u-ben' && r.item.roleId === 'r-contrib-north')?.item.status).toBe('alreadyAssigned');
  });

  it('plans a user chosen twice once, and never a disabled user', () => {
    const p = planFor(['u-ben', 'u-ben', 'u-finn'], ['r-sales'], true);
    expect(p.users.map((u) => u.userId)).toEqual(['u-ben', 'u-finn']);
    expect(p.rows.find((r) => r.userId === 'u-finn')?.item.status).toBe('refused');
  });
});

describe('confirmAndApplyBulk', () => {
  const run = (env: ReturnType<typeof fakeEnvironment>, plan: ReturnType<typeof planFor>) =>
    confirmAndApplyBulk({ plan, writer: env.writer, reader: env.reader, actor: 'tester', environmentId: 'env-1' });

  it('approves, applies and verifies each user on its own', async () => {
    const env = fakeEnvironment();
    const out = await run(env, planFor(['u-ben', 'u-cara'], ['r-sales'], true));
    expect(env.calls).toEqual(['u-ben|r-sales', 'u-cara|r-sales']);
    expect(out.allVerified).toBe(true);
    expect(out.outcomes.map((o) => o.kind)).toEqual(['applied', 'applied']);
  });

  it('sends nothing for a user with nothing to write', async () => {
    const env = fakeEnvironment();
    const out = await run(env, planFor(['u-ben'], ['r-contrib-north'], true)); // already held
    expect(env.calls).toEqual([]);
    expect(out.outcomes[0]?.kind).toBe('nothingToWrite');
  });

  it('stops after the first user that does not end verified; the rest are not attempted', async () => {
    const env = fakeEnvironment(['u-ben']);
    const out = await run(env, planFor(['u-ben', 'u-cara'], ['r-sales'], true));
    expect(env.calls).toEqual(['u-ben|r-sales']);
    expect(out.allVerified).toBe(false);
    expect(out.outcomes.map((o) => o.kind)).toEqual(['applied', 'notAttempted']);
  });

  it('treats a write that throws as not verified (the apply service reports it per item) and stops', async () => {
    const env = fakeEnvironment();
    const boom: SecurityDataWriter = { ...env.writer, assignRole: async () => { throw new Error('network'); } };
    const out = await confirmAndApplyBulk({ plan: planFor(['u-ben', 'u-cara'], ['r-sales'], true), writer: boom, reader: env.reader, actor: 'tester', environmentId: 'env-1' });
    expect(out.outcomes.map((o) => o.kind)).toEqual(['applied', 'notAttempted']);
    expect(out.allVerified).toBe(false);
  });
});

describe('confirmAndApplyBulk after a verified no-op and with refused users', () => {
  it('continues with the next user when the first user already holds the roles by the time of confirmation', async () => {
    const env = fakeEnvironment();
    const plan = planFor(['u-ben', 'u-cara'], ['r-sales'], true);
    env.set.add('u-ben|r-sales'); // assigned by someone else between preview and confirmation
    const out = await confirmAndApplyBulk({ plan, writer: env.writer, reader: env.reader, actor: 'tester', environmentId: 'env-1' });
    expect(env.calls).toEqual(['u-cara|r-sales']);
    expect(out.outcomes.map((o) => o.kind)).toEqual(['applied', 'applied']);
    expect(out.allVerified).toBe(true);
  });

  it('keeps a refused user as nothingToWrite with its reason in the plan', async () => {
    const env = fakeEnvironment();
    const plan = planFor(['u-ben', 'u-cara'], ['r-sales'], false);
    const out = await confirmAndApplyBulk({ plan, writer: env.writer, reader: env.reader, actor: 'tester', environmentId: 'env-1' });
    expect(out.outcomes.map((o) => o.kind)).toEqual(['applied', 'nothingToWrite']);
    expect(out.outcomes[1]?.plan.items[0]?.status).toBe('refused');
  });
});

describe('verified no-op needs the final read to confirm it', () => {
  it('stops when the role was removed again between the pre-apply read and the final read', async () => {
    const env = fakeEnvironment();
    const plan = planFor(['u-ben', 'u-cara'], ['r-sales'], true);
    env.set.add('u-ben|r-sales');
    let benReads = 0;
    const reader = {
      loadUserAccess: async (userId: string): Promise<ReadResult<UserAccess>> => {
        if (userId === 'u-ben' && ++benReads === 2) env.set.delete('u-ben|r-sales'); // removed by someone else before the final read
        return { status: 'ok', data: accessOf(env.set, userId) };
      },
    };
    const out = await confirmAndApplyBulk({ plan, writer: env.writer, reader, actor: 'tester', environmentId: 'env-1' });
    expect(env.calls).toEqual([]);
    expect(out.allVerified).toBe(false);
    expect(out.outcomes.map((o) => o.kind)).toEqual(['applied', 'notAttempted']);
  });
});

describe('verified no-op inside a mixed result', () => {
  it('stops when a no-op role was removed before the final read although the written role is verified', async () => {
    const env = fakeEnvironment();
    const mixed = planBulkAssignments({ accesses: [accessOf(held(), 'u-ann'), accessOf(held(), 'u-cara')], catalog: northRoles, businessUnits: S.businessUnits, crossBuAssignment: true, roleIds: ['r-sales', 'r-contrib-north'] });
    env.set.add('u-ann|r-sales');
    let annReads = 0;
    const annReader = {
      loadUserAccess: async (userId: string): Promise<ReadResult<UserAccess>> => {
        if (userId === 'u-ann' && ++annReads === 2) env.set.delete('u-ann|r-sales'); // removed by someone else before the final read
        return { status: 'ok', data: accessOf(env.set, userId) };
      },
    };
    const out = await confirmAndApplyBulk({ plan: mixed, writer: env.writer, reader: annReader, actor: 'tester', environmentId: 'env-1' });
    expect(env.calls).toContain('u-ann|r-contrib-north'); // the written role
    expect(out.allVerified).toBe(false);
    expect(out.outcomes.map((o) => o.kind)).toEqual(['applied', 'notAttempted']);
  });
});

describe('summarizeApplied (what the result table shows)', () => {
  it('names a no-op role that is absent in the final read and never shows it as verified', async () => {
    const env = fakeEnvironment();
    const mixed = planBulkAssignments({ accesses: [accessOf(held(), 'u-ann')], catalog: northRoles, businessUnits: S.businessUnits, crossBuAssignment: true, roleIds: ['r-sales', 'r-contrib-north'] });
    env.set.add('u-ann|r-sales');
    let reads = 0;
    const reader = {
      loadUserAccess: async (userId: string): Promise<ReadResult<UserAccess>> => {
        if (++reads === 2) env.set.delete('u-ann|r-sales');
        return { status: 'ok', data: accessOf(env.set, userId) };
      },
    };
    const out = await confirmAndApplyBulk({ plan: mixed, writer: env.writer, reader, actor: 'tester', environmentId: 'env-1' });
    const first = out.outcomes[0];
    expect(first?.kind).toBe('applied');
    const s = first?.kind === 'applied' ? summarizeApplied(first.applied.result) : null;
    expect(s?.status).toBe('notVerified');
    expect(s?.problems.join(' ')).toContain('Sales Manager (North) was held before but is no longer held');
  });
});
