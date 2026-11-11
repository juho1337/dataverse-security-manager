import { describe, expect, it, vi } from 'vitest';
import { approvePlan, createWritePlan, plannedWrite, type PlannedWrite } from '../../../domain/operations';
import { APPROVED_DEVELOPER_ENVIRONMENT } from '../config';
import type { IdentityResult } from '../identity';
import { createWriteBoundary, type RawWriteApi } from './boundary';
import { createRoleAssignmentWriter } from './assignments';

const ENV = APPROVED_DEVELOPER_ENVIRONMENT;
const USER = '33333333-3333-3333-3333-333333333333';
const ROLE = '11111111-1111-1111-1111-111111111111';
const OTHER = '44444444-4444-4444-4444-444444444444';
const VERIFIED: IdentityResult = {
  status: 'verified',
  writesAllowed: true,
  environment: { url: ENV.url, organizationId: ENV.organizationId, environmentId: ENV.environmentId, key: ENV.environmentId },
};

function setup(writes: PlannedWrite[], opts: { identity?: IdentityResult; fail?: unknown } = {}) {
  const raw: RawWriteApi = {
    associate: vi.fn(async () => { if (opts.fail) throw opts.fail; }),
    disassociate: vi.fn(async () => { if (opts.fail) throw opts.fail; }),
    execute: vi.fn(async () => ({})),
  };
  const boundary = createWriteBoundary({ raw, verifyIdentity: async () => opts.identity ?? VERIFIED, now: () => 1_000 });
  const approval = approvePlan(createWritePlan(writes), ENV.environmentId, 'Owner', 0, { lifetimeMs: 60_000 });
  return { writer: createRoleAssignmentWriter({ boundary }), approval, raw };
}

describe('assignRole', () => {
  it('associates exactly the planned user and role through the user-role relationship', async () => {
    const { writer, approval, raw } = setup([plannedWrite.assignRole(USER, ROLE, 'Assign')]);
    const result = await writer.assignRole(approval, `{${USER.toUpperCase()}}`, ROLE);
    expect(result).toMatchObject({ outcome: 'notVerified', failure: 'none' });
    expect(raw.associate).toHaveBeenCalledTimes(1);
    expect(raw.associate).toHaveBeenCalledWith('systemuser', USER, 'systemuserroles_association', 'role', ROLE, 'primary');
    expect(raw.disassociate).not.toHaveBeenCalled();
  });

  it('refuses another user, another role, or an unassign presented as an assign, without sending anything', async () => {
    const { writer, approval, raw } = setup([plannedWrite.assignRole(USER, ROLE, 'Assign')]);
    expect(await writer.assignRole(approval, OTHER, ROLE)).toMatchObject({ outcome: 'failed', failure: 'validation' });
    expect(await writer.assignRole(approval, USER, OTHER)).toMatchObject({ outcome: 'failed', failure: 'validation' });
    expect(await writer.unassignRole(approval, USER, ROLE)).toMatchObject({ outcome: 'failed', failure: 'validation' });
    expect(raw.associate).not.toHaveBeenCalled();
    expect(raw.disassociate).not.toHaveBeenCalled();
  });

  it('sends nothing when the identity is not fully verified', async () => {
    const { writer, approval, raw } = setup([plannedWrite.assignRole(USER, ROLE, 'Assign')], { identity: { status: 'environmentIdUnverifiable', writesAllowed: false } });
    expect(await writer.assignRole(approval, USER, ROLE)).toMatchObject({ outcome: 'failed', failure: 'identity' });
    expect(raw.associate).not.toHaveBeenCalled();
  });

  it('classifies failures: permission is failed, a lost connection is uncertain, throttling is failed', async () => {
    const w = plannedWrite.assignRole(USER, ROLE, 'Assign');
    const denied = setup([w], { fail: Object.assign(new Error('Forbidden'), { status: 403 }) });
    expect(await denied.writer.assignRole(denied.approval, USER, ROLE)).toMatchObject({ outcome: 'failed', failure: 'permission' });
    const lost = setup([w], { fail: new Error('Failed to fetch') });
    expect(await lost.writer.assignRole(lost.approval, USER, ROLE)).toMatchObject({ outcome: 'uncertain', failure: 'connection' });
    const slow = setup([w], { fail: Object.assign(new Error('Too many requests'), { status: 429 }) });
    expect(await slow.writer.assignRole(slow.approval, USER, ROLE)).toMatchObject({ outcome: 'failed', failure: 'throttling' });
  });
});

describe('unassignRole', () => {
  it('disassociates exactly the planned user and role', async () => {
    const { writer, approval, raw } = setup([plannedWrite.unassignRole(USER, ROLE, 'Unassign')]);
    const result = await writer.unassignRole(approval, USER, ROLE);
    expect(result).toMatchObject({ outcome: 'notVerified', failure: 'none' });
    expect(raw.disassociate).toHaveBeenCalledWith('systemuser', USER, 'systemuserroles_association', ROLE, 'primary');
    expect(raw.associate).not.toHaveBeenCalled();
  });

  it('refuses an assign presented as an unassign and a role outside the plan', async () => {
    const { writer, approval, raw } = setup([plannedWrite.assignRole(USER, ROLE, 'Assign')]);
    expect(await writer.unassignRole(approval, USER, ROLE)).toMatchObject({ outcome: 'failed', failure: 'validation' });
    expect(raw.disassociate).not.toHaveBeenCalled();
  });

  it('a batch plan sends each planned write once and nothing else', async () => {
    const plan = [plannedWrite.assignRole(USER, ROLE, 'A'), plannedWrite.assignRole(USER, OTHER, 'B'), plannedWrite.unassignRole(USER, '55555555-5555-5555-5555-555555555555', 'C')];
    const { writer, approval, raw } = setup(plan);
    await writer.assignRole(approval, USER, ROLE);
    await writer.assignRole(approval, USER, OTHER);
    await writer.unassignRole(approval, USER, '55555555-5555-5555-5555-555555555555');
    expect(raw.associate).toHaveBeenCalledTimes(2);
    expect(raw.disassociate).toHaveBeenCalledTimes(1);
  });
});
