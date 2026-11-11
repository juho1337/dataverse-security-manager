import { describe, expect, it, vi } from 'vitest';
import { approvePlan, createWritePlan, plannedWrite, type PlannedWrite } from '../../../domain/operations';
import { APPROVED_DEVELOPER_ENVIRONMENT } from '../config';
import type { IdentityResult } from '../identity';
import { createWriteBoundary, type RawWriteApi } from './boundary';
import { createBusinessUnitMoveWriter } from './buMove';

const ENV = APPROVED_DEVELOPER_ENVIRONMENT;
const USER = '33333333-3333-3333-3333-333333333333';
const BU = '55555555-5555-5555-5555-555555555555';
const OTHER = '44444444-4444-4444-4444-444444444444';
const VERIFIED: IdentityResult = {
  status: 'verified',
  writesAllowed: true,
  environment: { url: ENV.url, organizationId: ENV.organizationId, environmentId: ENV.environmentId, key: ENV.environmentId },
};

function setup(writes: PlannedWrite[], opts: { identity?: IdentityResult; fail?: unknown } = {}) {
  const raw: RawWriteApi = {
    associate: vi.fn(),
    disassociate: vi.fn(),
    execute: vi.fn(async () => ({})),
    update: vi.fn(async () => { if (opts.fail) throw opts.fail; }),
  };
  const boundary = createWriteBoundary({ raw, verifyIdentity: async () => opts.identity ?? VERIFIED, now: () => 1_000 });
  const approval = approvePlan(createWritePlan(writes), ENV.environmentId, 'Owner', 0, { lifetimeMs: 60_000 });
  return { writer: createBusinessUnitMoveWriter({ boundary }), approval, raw };
}

describe('moveUser', () => {
  it('updates only systemuser.businessunitid, with the bind built from the plan', async () => {
    const { writer, approval, raw } = setup([plannedWrite.moveUser(USER, BU, 'Move')]);
    const result = await writer.moveUser(approval, `{${USER.toUpperCase()}}`, BU.toUpperCase());
    expect(result).toMatchObject({ outcome: 'notVerified', failure: 'none' });
    expect(raw.update).toHaveBeenCalledTimes(1);
    expect(raw.update).toHaveBeenCalledWith('systemuser', USER, { 'businessunitid@odata.bind': `/businessunits(${BU})` }, 'primary');
    expect(raw.execute).not.toHaveBeenCalled();
  });

  it('never uses the deprecated SetBusinessSystemUser action', async () => {
    const { writer, approval, raw } = setup([plannedWrite.moveUser(USER, BU, 'Move')]);
    await writer.moveUser(approval, USER, BU);
    expect(raw.execute).not.toHaveBeenCalled();
  });

  it('refuses another user, another Business Unit, or a move that is not in the plan, without sending anything', async () => {
    const { writer, approval, raw } = setup([plannedWrite.moveUser(USER, BU, 'Move')]);
    expect(await writer.moveUser(approval, OTHER, BU)).toMatchObject({ outcome: 'failed', failure: 'validation' });
    expect(await writer.moveUser(approval, USER, OTHER)).toMatchObject({ outcome: 'failed', failure: 'validation' });
    expect(raw.update).not.toHaveBeenCalled();
  });

  it('sends nothing when the identity is not fully verified', async () => {
    const { writer, approval, raw } = setup([plannedWrite.moveUser(USER, BU, 'Move')], { identity: { status: 'environmentIdUnverifiable', writesAllowed: false } });
    expect(await writer.moveUser(approval, USER, BU)).toMatchObject({ outcome: 'failed', failure: 'identity' });
    expect(raw.update).not.toHaveBeenCalled();
  });

  it('classifies failures: permission is failed, a lost connection is uncertain (to be resolved by a re-read)', async () => {
    const w = plannedWrite.moveUser(USER, BU, 'Move');
    const denied = setup([w], { fail: Object.assign(new Error('Forbidden'), { status: 403 }) });
    expect(await denied.writer.moveUser(denied.approval, USER, BU)).toMatchObject({ outcome: 'failed', failure: 'permission' });
    const lost = setup([w], { fail: new Error('Failed to fetch') });
    expect(await lost.writer.moveUser(lost.approval, USER, BU)).toMatchObject({ outcome: 'uncertain', failure: 'connection' });
  });

  it('a batch plan moves each planned user once and nothing else', async () => {
    const U2 = '66666666-6666-6666-6666-666666666666';
    const { writer, approval, raw } = setup([plannedWrite.moveUser(USER, BU, 'A'), plannedWrite.moveUser(U2, BU, 'B')]);
    await writer.moveUser(approval, USER, BU);
    await writer.moveUser(approval, U2, BU);
    expect(raw.update).toHaveBeenCalledTimes(2);
  });
});
