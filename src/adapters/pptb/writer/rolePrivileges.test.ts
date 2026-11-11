import { describe, expect, it, vi } from 'vitest';
import { approvePlan, createWritePlan, plannedWrite, type ApprovedPlan, type GrantDepth, type PlannedWrite } from '../../../domain/operations';
import { APPROVED_DEVELOPER_ENVIRONMENT } from '../config';
import type { IdentityResult } from '../identity';
import { createWriteBoundary, type RawWriteApi, type WriteExecuteRequest } from './boundary';
import { createRolePrivilegeWriter } from './rolePrivileges';

const ENV = APPROVED_DEVELOPER_ENVIRONMENT;
const ROLE = '11111111-1111-1111-1111-111111111111';
const PRIV = '22222222-2222-2222-2222-222222222222';
const BU = '55555555-5555-5555-5555-555555555555';
const VERIFIED: IdentityResult = {
  status: 'verified',
  writesAllowed: true,
  environment: { url: ENV.url, organizationId: ENV.organizationId, environmentId: ENV.environmentId, key: ENV.environmentId },
};

function setup(writes: PlannedWrite[], opts: { bu?: string | null | 'throw'; identity?: IdentityResult; execute?: RawWriteApi['execute'] } = {}) {
  const requests: WriteExecuteRequest[] = [];
  const raw: RawWriteApi = {
    execute: opts.execute ?? (async (request) => { requests.push(request); return {}; }),
  };
  const boundary = createWriteBoundary({ raw, verifyIdentity: async () => opts.identity ?? VERIFIED, now: () => 1_000 });
  const resolve = vi.fn(async () => {
    if (opts.bu === 'throw') throw new Error('read failed');
    return opts.bu === undefined ? BU : opts.bu;
  });
  const writer = createRolePrivilegeWriter({ boundary, resolveRoleBusinessUnit: resolve });
  const approval: ApprovedPlan = approvePlan(createWritePlan(writes), ENV.environmentId, 'Owner', 0, { lifetimeMs: 60_000 });
  return { writer, approval, requests, resolve };
}

describe('addPrivilege', () => {
  it.each<GrantDepth>(['Basic', 'Local', 'Deep', 'Global'])('sends AddPrivilegesRole with depth %s for the planned role and privilege', async (depth) => {
    const w = plannedWrite.addPrivilege(ROLE, PRIV, depth, 'Add');
    const { writer, approval, requests } = setup([w]);
    const result = await writer.addPrivilege(approval, ROLE, PRIV, depth);
    expect(result).toMatchObject({ outcome: 'notVerified', failure: 'none' });
    expect(requests).toEqual([
      {
        operationName: 'AddPrivilegesRole', operationType: 'action', entityName: 'role', entityId: ROLE,
        parameters: { Privileges: [{ PrivilegeId: PRIV, Depth: depth, BusinessUnitId: BU }] },
      },
    ]);
  });

  it('normalises braces and case of the ids', async () => {
    const w = plannedWrite.addPrivilege(ROLE, PRIV, 'Local', 'Add');
    const { writer, approval, requests } = setup([w], { bu: `{${BU.toUpperCase()}}` });
    await writer.addPrivilege(approval, `{${ROLE.toUpperCase()}}`, PRIV.toUpperCase(), 'Local');
    expect(requests[0]?.entityId).toBe(ROLE);
    expect((requests[0]?.parameters as { Privileges: { BusinessUnitId: string }[] }).Privileges[0]?.BusinessUnitId).toBe(BU);
  });

  it('sends nothing when the role Business Unit cannot be read', async () => {
    const w = plannedWrite.addPrivilege(ROLE, PRIV, 'Local', 'Add');
    for (const bu of [null, 'throw'] as const) {
      const { writer, approval, requests } = setup([w], { bu });
      const result = await writer.addPrivilege(approval, ROLE, PRIV, 'Local');
      expect(result).toMatchObject({ outcome: 'failed', failure: 'validation' });
      expect(result.message).toMatch(/Nothing was sent/);
      expect(requests).toEqual([]);
    }
  });

  it('refuses a change that is not part of the confirmed plan, without reading or sending anything', async () => {
    const w = plannedWrite.addPrivilege(ROLE, PRIV, 'Local', 'Add');
    const { writer, approval, requests, resolve } = setup([w]);
    for (const depth of ['Global', 'Basic'] as const) {
      expect(await writer.addPrivilege(approval, ROLE, PRIV, depth)).toMatchObject({ outcome: 'failed', failure: 'validation' });
    }
    expect(await writer.addPrivilege(approval, '99999999-9999-9999-9999-999999999999', PRIV, 'Local')).toMatchObject({ failure: 'validation' });
    expect(requests).toEqual([]);
    expect(resolve).not.toHaveBeenCalled();
  });

  it('sends nothing when the identity is not fully verified', async () => {
    const w = plannedWrite.addPrivilege(ROLE, PRIV, 'Local', 'Add');
    const { writer, approval, requests } = setup([w], { identity: { status: 'environmentIdUnverifiable', writesAllowed: false } });
    expect(await writer.addPrivilege(approval, ROLE, PRIV, 'Local')).toMatchObject({ outcome: 'failed', failure: 'identity' });
    expect(requests).toEqual([]);
  });

  it('maps host failures to classified results: permission is failed, a lost connection is uncertain', async () => {
    const w = plannedWrite.addPrivilege(ROLE, PRIV, 'Local', 'Add');
    const denied = setup([w], { execute: async () => { throw Object.assign(new Error('Forbidden'), { status: 403 }); } });
    expect(await denied.writer.addPrivilege(denied.approval, ROLE, PRIV, 'Local')).toMatchObject({ outcome: 'failed', failure: 'permission' });
    const lost = setup([w], { execute: async () => { throw new Error('Failed to fetch'); } });
    expect(await lost.writer.addPrivilege(lost.approval, ROLE, PRIV, 'Local')).toMatchObject({ outcome: 'uncertain', failure: 'connection' });
  });
});

describe('removePrivilege', () => {
  it('sends RemovePrivilegeRole with the privilege reference for the planned role', async () => {
    const w = plannedWrite.removePrivilege(ROLE, PRIV, 'Remove');
    const { writer, approval, requests, resolve } = setup([w]);
    const result = await writer.removePrivilege(approval, ROLE, PRIV);
    expect(result).toMatchObject({ outcome: 'notVerified', failure: 'none' });
    expect(requests).toEqual([
      {
        operationName: 'RemovePrivilegeRole', operationType: 'action', entityName: 'role', entityId: ROLE,
        parameters: { Privilege: { '@odata.type': 'Microsoft.Dynamics.CRM.privilege', privilegeid: PRIV } },
      },
    ]);
    expect(resolve).not.toHaveBeenCalled();
  });

  it('refuses a removal that is not in the plan, and never turns an add into a removal', async () => {
    const add = plannedWrite.addPrivilege(ROLE, PRIV, 'Local', 'Add');
    const { writer, approval, requests } = setup([add]);
    expect(await writer.removePrivilege(approval, ROLE, PRIV)).toMatchObject({ outcome: 'failed', failure: 'validation' });
    expect(requests).toEqual([]);
  });

  it('keeps the apply order contract: a plan with an add and a remove for different privileges sends each exactly once', async () => {
    const OTHER = '33333333-3333-3333-3333-333333333333';
    const plan = [plannedWrite.addPrivilege(ROLE, PRIV, 'Basic', 'Add'), plannedWrite.removePrivilege(ROLE, OTHER, 'Remove')];
    const { writer, approval, requests } = setup(plan);
    await writer.addPrivilege(approval, ROLE, PRIV, 'Basic');
    await writer.removePrivilege(approval, ROLE, OTHER);
    expect(requests.map((r) => r.operationName)).toEqual(['AddPrivilegesRole', 'RemovePrivilegeRole']);
  });
});
