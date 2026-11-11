import { describe, expect, it } from 'vitest';
import { approvalRefusal, approvePlan, createWritePlan, plannedWrite } from './operations';

const ROLE = '11111111-1111-1111-1111-111111111111';
const PRIV = '22222222-2222-2222-2222-222222222222';
const USER = '33333333-3333-3333-3333-333333333333';
const ENV = '00000000-0000-4000-8000-000000000002';

const assign = plannedWrite.assignRole(USER, ROLE, 'Assign');
const add = plannedWrite.addPrivilege(ROLE, PRIV, 'Local', 'Add');

describe('write plan', () => {
  it('rejects an empty plan and duplicate writes', () => {
    expect(() => createWritePlan([])).toThrow();
    expect(() => createWritePlan([assign, assign])).toThrow();
  });

  it('hash changes when a write is added, removed, changed or reordered', () => {
    const base = createWritePlan([assign, add]).hash;
    expect(createWritePlan([assign]).hash).not.toBe(base);
    expect(createWritePlan([add, assign]).hash).not.toBe(base);
    expect(createWritePlan([assign, plannedWrite.addPrivilege(ROLE, PRIV, 'Deep', 'Add')]).hash).not.toBe(base);
    expect(createWritePlan([assign, add]).hash).toBe(base);
  });

  it('normalizes ids so braces and case do not create a different write', () => {
    expect(plannedWrite.assignRole(`{${USER.toUpperCase()}}`, ROLE, 'x').key).toBe(assign.key);
  });
});

describe('approval', () => {
  const plan = createWritePlan([assign]);
  const approval = approvePlan(plan, ENV, 'Owner', 1_000, { lifetimeMs: 10_000 });

  it('covers its own writes in the confirmed environment', () => {
    expect(approvalRefusal(approval, assign, ENV, 2_000)).toBeNull();
    expect(approvalRefusal(approval, assign, `{${ENV.toUpperCase()}}`, 2_000)).toBeNull();
  });

  it('refuses expired, other-environment and unconfirmed writes', () => {
    expect(approvalRefusal(approval, assign, ENV, 11_001)).toMatch(/expired/);
    expect(approvalRefusal(approval, assign, '99999999-9999-9999-9999-999999999999', 2_000)).toMatch(/different environment/);
    expect(approvalRefusal(approval, add, ENV, 2_000)).toMatch(/not part of the confirmed plan/);
  });

  it('requires an environment and an approver, and names the operation', () => {
    expect(() => approvePlan(plan, ' ', 'Owner', 0)).toThrow();
    expect(() => approvePlan(plan, ENV, ' ', 0)).toThrow();
    expect(approval.operationId).toMatch(/^[0-9a-f]{12}$/);
  });
});
