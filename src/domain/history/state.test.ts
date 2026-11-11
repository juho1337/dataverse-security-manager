import { describe, expect, it } from 'vitest';
import { approvePlan, createWritePlan, plannedWrite } from '../operations';
import { parseOperationRecord, parseOperationRecords } from './parse';
import { beginOperation, endOperation, recordStepResult } from './record';
import { sameState, stateChecksum, targetKeyOfState, targetKeyOfStep } from './state';
import type { OperationRecord, PrivilegeDepthState, RoleHeldState, UserPlacementState } from './types';

const ROLE = '11111111-1111-1111-1111-111111111111';
const PRIV = '22222222-2222-2222-2222-222222222222';
const USER = '33333333-3333-3333-3333-333333333333';
const BU = '55555555-5555-5555-5555-555555555555';
const ENV = '00000000-0000-4000-8000-000000000002';

const depth = (d: PrivilegeDepthState['depth']): PrivilegeDepthState => ({ kind: 'privilegeDepth', table: 'account', roleId: ROLE, privilegeId: PRIV, privilege: 'Write', depth: d });
const held = (h: boolean): RoleHeldState => ({ kind: 'roleHeld', userId: USER, roleId: ROLE, held: h });
const placement = (bu: string, roleIds: string[] | null): UserPlacementState => ({ kind: 'userPlacement', userId: USER, businessUnitId: bu, roleIds });

/** A finished v2 operation with one verified add-privilege step that carries both states. */
function record(): OperationRecord {
  const plan = createWritePlan([plannedWrite.addPrivilege(ROLE, PRIV, 'Basic', 'Add Write')]);
  const approval = approvePlan(plan, ENV, 'Owner', 1_000, { operationId: 'op-1' });
  const begun = beginOperation(approval, 1_000);
  const done = recordStepResult(begun, plan.writes[0]!.key, { outcome: 'succeeded', message: 'ok', failure: 'none' }, 2_000, { verified: true, before: depth('None'), after: depth('Basic') });
  return endOperation(done, 2_500);
}

const json = (r: unknown): unknown => JSON.parse(JSON.stringify(r));

describe('schema v2 states', () => {
  it('a new operation is schema v2 and a verified step keeps its before and after with a checksum', () => {
    const r = record();
    expect(r.schemaVersion).toBe(2);
    expect(r.steps[0]).toMatchObject({ before: depth('None'), after: depth('Basic'), stateIntegrity: 'ok' });
    expect(r.steps[0]?.stateChecksum).toBe(stateChecksum(r.steps[0]!.key, depth('None'), depth('Basic')));
  });

  it('round-trips through the allow-list parser, keeping the states', () => {
    const parsed = parseOperationRecord(json(record()));
    expect(parsed?.schemaVersion).toBe(2);
    expect(parsed?.steps[0]).toMatchObject({ before: depth('None'), after: depth('Basic'), stateIntegrity: 'ok' });
  });

  it('a state about another target than the step is ignored when recording', () => {
    const plan = createWritePlan([plannedWrite.assignRole(USER, ROLE, 'Assign')]);
    const begun = beginOperation(approvePlan(plan, ENV, 'Owner', 1_000), 1_000);
    const r = recordStepResult(begun, plan.writes[0]!.key, { outcome: 'succeeded', message: 'ok', failure: 'none' }, 2_000, { verified: true, before: depth('None') });
    expect(r.steps[0]?.before).toBeUndefined();
    expect(r.steps[0]?.stateChecksum).toBeUndefined();
  });

  it('a legacy v1 record parses, has no states, and ignores any states the file claims', () => {
    const v1 = { ...(json(record()) as Record<string, unknown>), schemaVersion: 1 };
    const parsed = parseOperationRecord(v1);
    expect(parsed?.schemaVersion).toBe(1);
    expect(parsed?.steps[0]?.before).toBeUndefined();
    expect(parsed?.steps[0]?.after).toBeUndefined();
  });

  it('states whose checksum does not match are dropped and flagged, the history stays readable', () => {
    const raw = json(record()) as { steps: Array<Record<string, unknown>> };
    (raw.steps[0]!.after as Record<string, unknown>).depth = 'Global'; // edited after the fact
    const parsed = parseOperationRecord(raw);
    expect(parsed).not.toBeNull();
    expect(parsed?.steps[0]).toMatchObject({ stateIntegrity: 'failed' });
    expect(parsed?.steps[0]?.before).toBeUndefined();
    expect(parsed?.steps[0]?.after).toBeUndefined();
  });

  it('states without any checksum are not trusted either', () => {
    const raw = json(record()) as { steps: Array<Record<string, unknown>> };
    delete raw.steps[0]!.stateChecksum;
    expect(parseOperationRecord(raw)?.steps[0]).toMatchObject({ stateIntegrity: 'failed' });
  });

  it('rejects a malformed state and a state about another target (the whole record is dropped, the rest of the history is kept)', () => {
    const good = json(record());
    const malformed = json(record()) as { steps: Array<Record<string, unknown>> };
    malformed.steps[0]!.before = { kind: 'privilegeDepth', table: 'account; drop', roleId: ROLE, privilegeId: PRIV, privilege: 'Write', depth: 'None' };
    const wrongTarget = json(record()) as { steps: Array<Record<string, unknown>> };
    wrongTarget.steps[0]!.before = held(false);
    const { records, dropped } = parseOperationRecords([good, malformed, wrongTarget]);
    expect(records).toHaveLength(1);
    expect(dropped).toBe(2);
  });

  it('keeps the earlier safeguards: step index equals position, timestamps in range, tokens scrubbed', () => {
    const badIndex = json(record()) as { steps: Array<Record<string, unknown>> };
    badIndex.steps[0]!.index = 3;
    const badTime = json(record()) as Record<string, unknown>;
    badTime.startedAtMs = 1e100;
    const token = json(record()) as { steps: Array<Record<string, unknown>> };
    token.steps[0]!.message = 'failed with token=abc123secret';
    const { records, dropped } = parseOperationRecords([badIndex, badTime, token]);
    expect(dropped).toBe(2);
    expect(records[0]?.steps[0]?.message).not.toContain('abc123secret');
  });

  it('a restore record names the operations it reverses and survives the parser', () => {
    const r = { ...(json(record()) as Record<string, unknown>), source: 'restore', sourceOperationIds: ['op-a', 'op-b'] };
    const parsed = parseOperationRecord(r);
    expect(parsed).toMatchObject({ source: 'restore', sourceOperationIds: ['op-a', 'op-b'] });
    expect(parseOperationRecord({ ...r, sourceOperationIds: [1] })).toBeNull();
  });
});

describe('state helpers', () => {
  it('equality ignores id case, braces and role order; kinds and values still differ', () => {
    expect(sameState(placement(BU, ['b', 'a']), placement(`{${BU.toUpperCase()}}`, ['a', 'b']))).toBe(true);
    expect(sameState(placement(BU, ['a']), placement(BU, null))).toBe(false);
    expect(sameState(depth('Basic'), depth('Local'))).toBe(false);
    expect(sameState(held(true), held(false))).toBe(false);
  });

  it('each step kind maps to the target of its state', () => {
    expect(targetKeyOfStep({ kind: 'addPrivilege', key: `addPrivilege:${ROLE}:${PRIV}:Local` })).toBe(targetKeyOfState(depth('None')));
    expect(targetKeyOfStep({ kind: 'removePrivilege', key: `removePrivilege:${ROLE}:${PRIV}` })).toBe(targetKeyOfState(depth('Basic')));
    expect(targetKeyOfStep({ kind: 'assignRole', key: `assignRole:${USER}:${ROLE}` })).toBe(targetKeyOfState(held(true)));
    expect(targetKeyOfStep({ kind: 'moveUser', key: `moveUser:${USER}:${BU}` })).toBe(targetKeyOfState(placement(BU, [])));
    expect(targetKeyOfStep({ kind: 'moveUser', key: 'garbage' })).toBeNull();
  });
});
