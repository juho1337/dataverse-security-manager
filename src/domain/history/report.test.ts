import { describe, expect, it } from 'vitest';
import { approvePlan, createWritePlan, plannedWrite, refused } from '../operations';
import { beginOperation, endOperation, markStepStarted, reconcileAbandoned, recordStepResult } from './record';
import { cleanLine, environmentShort, formatOperationsReport, localText, utcText } from './report';
import type { OperationRecord } from './types';

const ROLE = '11111111-1111-1111-1111-111111111111';
const ROLE2 = '44444444-4444-4444-4444-444444444444';
const USER = '22222222-2222-2222-2222-222222222222';
const BU = '55555555-5555-5555-5555-555555555555';
const ENV = '33333333-3333-3333-3333-333333333333';
const T0 = Date.UTC(2026, 10, 3, 19, 40, 12); // 2026-11-03 19:40:12 UTC = 21:40:12 in Helsinki (UTC+2, no DST in November)
const NOW = Date.UTC(2026, 10, 3, 20, 0, 0);

function start(id: string, writes: Parameters<typeof createWritePlan>[0], at = T0, actor = 'Tool user (confirmed in the PPTB UI)', env = ENV) {
  return beginOperation(approvePlan(createWritePlan(writes), env, actor, 1, { operationId: id }), at, { correlationId: `corr-${id}` });
}

const verifiedOp = (): OperationRecord => {
  let o = start('op-ok', [plannedWrite.assignRole(USER, ROLE, 'Assign role Writer to user Ben')]);
  o = recordStepResult(o, o.steps[0]!.key, { outcome: 'succeeded', message: 'Confirmed.', failure: 'none' }, T0 + 1000, { verified: true });
  return endOperation(o, T0 + 2000);
};

const failedOp = (): OperationRecord => {
  let o = start('op-fail', [plannedWrite.addPrivilege(ROLE, 'aaaaaaaa-0000-0000-0000-000000000001', 'Basic', 'Add Write on Account at User')], T0 + 60_000);
  o = recordStepResult(o, o.steps[0]!.key, refused('permission', 'The account lacks a privilege for this change.', 'permission 403'), T0 + 61_000);
  return endOperation(o, T0 + 62_000);
};

describe('formatOperationsReport', () => {
  it('reports one verified operation in plain text with local time, UTC, ids and an honest before-state', () => {
    const text = formatOperationsReport([verifiedOp()], { now: NOW, timeZone: 'Europe/Helsinki' });
    expect(text).toContain('DATAVERSE SECURITY MANAGER - OPERATIONS REPORT');
    expect(text).toContain('Generated: 2026-11-03 22:00:00 UTC+02:00 (Europe/Helsinki) / 2026-11-03 20:00:00 UTC');
    expect(text).toContain(`Environment: ${ENV}`);
    expect(text).toContain('Summary: 1 verified, 0 failed, 0 uncertain, 0 not verified, 0 no write');
    expect(text).toContain('[1/1] VERIFIED - Role assignment');
    expect(text).toContain('Started: 2026-11-03 21:40:12 UTC+02:00 (Europe/Helsinki) / 2026-11-03 19:40:12 UTC');
    expect(text).toContain('Confirmed by: Tool user (confirmed in the PPTB UI)');
    expect(text).toContain('Operation id: op-ok');
    expect(text).toContain('Correlation id: corr-op-ok');
    expect(text).toContain('1. [VERIFIED] Assign role Writer to user Ben');
    expect(text).toContain('Before: not recorded');
    expect(text).toContain('Re-read: confirmed the intended end state');
    expect(text).not.toContain('{');
  });

  it('prints the before and after states the ledger recorded (schema v2) without a hook, and still says not recorded when there are none', () => {
    let o = start('op-v2', [plannedWrite.assignRole(USER, ROLE, 'Assign role Writer to user Ben')]);
    o = recordStepResult(o, o.steps[0]!.key, { outcome: 'succeeded', message: 'Confirmed.', failure: 'none' }, T0 + 1000, {
      verified: true,
      before: { kind: 'roleHeld', userId: USER, roleId: ROLE, held: false },
      after: { kind: 'roleHeld', userId: USER, roleId: ROLE, held: true },
    });
    const text = formatOperationsReport([endOperation(o, T0 + 2000)], { now: NOW, timeZone: 'UTC' });
    expect(text).toContain(`Before -> after: role ${ROLE} not held by user ${USER} -> role ${ROLE} held by user ${USER}`);
    expect(text).not.toContain('Before: not recorded');
    expect(formatOperationsReport([verifiedOp()], { now: NOW, timeZone: 'UTC' })).toContain('Before: not recorded');
  });

  it('prints every role of a recorded placement: two states that differ only in a late role never look alike', () => {
    const roles = (last: string) => [1, 2, 3, 4, 5, 6].map((n) => `${n}0000000-0000-0000-0000-000000000000`).concat(last);
    let o = start('op-bu', [plannedWrite.moveUser(USER, BU, 'Move user')]);
    o = recordStepResult(o, o.steps[0]!.key, { outcome: 'succeeded', message: 'Confirmed.', failure: 'none' }, T0 + 1000, {
      verified: true,
      before: { kind: 'userPlacement', userId: USER, businessUnitId: BU, roleIds: roles('aaaaaaaa-0000-0000-0000-000000000001') },
      after: { kind: 'userPlacement', userId: USER, businessUnitId: BU, roleIds: roles('bbbbbbbb-0000-0000-0000-000000000002') },
    });
    const text = formatOperationsReport([endOperation(o, T0 + 2000)], { now: NOW, timeZone: 'UTC' });
    expect(text).toContain('aaaaaaaa-0000-0000-0000-000000000001');
    expect(text).toContain('bbbbbbbb-0000-0000-0000-000000000002');
    expect(text).not.toContain('...');
  });

  it('never invents a before state: it prints one only when the captured hook supplies it', () => {
    const op = verifiedOp();
    const without = formatOperationsReport([op], { now: NOW, timeZone: 'UTC' });
    expect(without).not.toContain('->  ');
    expect(without).toContain('Before: not recorded');
    const both = formatOperationsReport([op], { now: NOW, timeZone: 'UTC', captured: () => ({ before: 'No role', after: 'Role Writer' }) });
    expect(both).toContain('Before -> after: No role -> Role Writer');
    expect(both).not.toContain('Before: not recorded');
    const onlyBefore = formatOperationsReport([op], { now: NOW, timeZone: 'UTC', captured: () => ({ before: 'No role' }) });
    expect(onlyBefore).toContain('Before: No role');
    expect(onlyBefore).toContain('After: not recorded');
  });

  it('reports several operations newest first with a classified, readable problem and a final summary', () => {
    const text = formatOperationsReport([verifiedOp(), failedOp()], { now: NOW, timeZone: 'UTC' });
    expect(text.indexOf('[1/2] FAILED')).toBeGreaterThan(-1);
    expect(text.indexOf('[2/2] VERIFIED')).toBeGreaterThan(text.indexOf('[1/2] FAILED'));
    expect(text).toContain('Problem: permission denied. The account lacks a privilege for this change.');
    expect(text).toContain('Summary: 1 verified, 1 failed, 0 uncertain, 0 not verified, 0 no write');
    expect(text).toContain('Operations: 2 - 1 verified, 1 failed');
    expect(text).toContain('Steps: 2 - 1 verified, 1 failed');
    expect(text).not.toContain('permission 403'); // raw technical text stays out of the readable report
  });

  it('reports an uncertain, a not-verified and a no-write operation distinctly', () => {
    let u = start('op-unc', [plannedWrite.moveUser(USER, BU, 'Move user Ben to Business Unit North')]);
    u = recordStepResult(u, u.steps[0]!.key, { outcome: 'uncertain', message: 'The connection failed.', failure: 'connection' }, T0 + 1);
    u = endOperation(u, T0 + 2);
    let n = start('op-nv', [plannedWrite.assignRole(USER, ROLE2, 'Assign role Reader')]);
    n = recordStepResult(n, n.steps[0]!.key, { outcome: 'notVerified', message: 'The request was accepted.', failure: 'none' }, T0 + 1);
    n = endOperation(n, T0 + 2);
    let s = start('op-skip', [plannedWrite.assignRole(USER, ROLE, 'Assign role Writer')]);
    s = recordStepResult(s, s.steps[0]!.key, refused('validation', 'No write was attempted.'), T0 + 1);
    s = { ...s, steps: s.steps.map((x) => ({ ...x, outcome: 'skipped' as const })) };
    s = endOperation(s, T0 + 2);
    const text = formatOperationsReport([u, n, s], { now: NOW, timeZone: 'UTC' });
    expect(text).toContain('UNCERTAIN - Business Unit move');
    expect(text).toContain('It may or may not have been applied. Read the objects again before relying on it.');
    expect(text).toContain('Problem: connection problem. The connection failed.');
    expect(text).toContain('NOT VERIFIED - Role assignment');
    expect(text).toContain('Note: The request was accepted.');
    expect(text).toContain('NO WRITE - Role assignment');
    expect(text).toContain('Nothing was sent to Dataverse.');
    expect(text).toContain('Summary: 0 verified, 0 failed, 1 uncertain, 1 not verified, 1 no write');
  });

  it('reports an operation that never finished as not finished, never as done', () => {
    let o = start('op-cut', [plannedWrite.assignRole(USER, ROLE, 'Assign role Writer')]);
    o = markStepStarted(o, o.steps[0]!.key, T0 + 1);
    const raw = formatOperationsReport([o], { now: NOW, timeZone: 'UTC' });
    expect(raw).toContain('NOT FINISHED - Role assignment');
    expect(raw).toContain('Ended: not recorded (the operation did not finish)');
    expect(raw).toContain('Do not treat it as done.');
    expect(raw).toContain('[REQUEST SENT, NO RESULT RECORDED]'); // sent, so it may have been applied: not "not attempted"
    expect(raw).not.toContain('NOT ATTEMPTED');
    expect(raw).not.toMatch(/VERIFIED - /);
    const unsent = formatOperationsReport([start('op-wait', [plannedWrite.assignRole(USER, ROLE, 'Assign role Writer')])], { now: NOW, timeZone: 'UTC' });
    expect(unsent).toContain('[NOT ATTEMPTED]'); // no start was recorded
    // After the app reconciles an abandoned operation it is uncertain, which is also not success.
    const reconciled = formatOperationsReport(reconcileAbandoned([o], () => false), { now: NOW, timeZone: 'UTC' });
    expect(reconciled).toContain('UNCERTAIN - Role assignment');
    expect(reconciled).not.toMatch(/\] VERIFIED - /);
  });

  it('describes a retry and keeps the link to the operation it follows', () => {
    const approval = approvePlan(createWritePlan([plannedWrite.assignRole(USER, ROLE, 'Assign role Writer')]), ENV, 'Tool user', 1, {
      operationId: 'op-retry',
      context: { source: 'retry', sourceOperationId: 'op-first' },
    });
    const text = formatOperationsReport([beginOperation(approval, T0)], { now: NOW, timeZone: 'UTC' });
    expect(text).toContain('Role assignment (retry of op-first)');
  });

  it('removes e-mail addresses and tokens from every free-text field, including the actor', () => {
    let o = start('op-pii', [plannedWrite.assignRole(USER, ROLE, 'Assign role Writer to Ann Smith <ann.smith@contoso.test>')], T0, 'ann.smith@contoso.test');
    o = recordStepResult(o, o.steps[0]!.key, refused('execution', 'Failed for bob@contoso.test; Bearer abc.def.ghi and token=xyz leaked'), T0 + 1);
    const text = formatOperationsReport([endOperation(o, T0 + 2)], { now: NOW, timeZone: 'UTC' });
    expect(text).not.toContain('contoso.test');
    expect(text).not.toContain('abc.def.ghi');
    expect(text).not.toContain('xyz');
    expect(text).toContain('[email removed]');
    expect(text).toContain('Confirmed by: [email removed]');
  });

  it('keeps every line plain: no markdown tables, no JSON, line breaks inside text are flattened, long text is capped', () => {
    const o = start('op-long', [plannedWrite.assignRole(USER, ROLE, `Line one\nLine two\t${'x'.repeat(500)}`)]);
    const text = formatOperationsReport([o], { now: NOW, timeZone: 'UTC' });
    expect(text).not.toContain('|');
    expect(text).not.toMatch(/^\s*\{/m);
    expect(text).not.toMatch(/"\w+":/);
    const stepLine = text.split('\n').find((l) => l.startsWith('  1. '))!;
    expect(stepLine).toContain('Line one Line two');
    expect(stepLine.length).toBeLessThan(340);
    expect(stepLine.endsWith('...')).toBe(true);
    // everything this module writes itself is ASCII
    expect(/^[\x20-\x7e\n]*$/.test(text)).toBe(true);
  });

  it('names several environments, and says so for none', () => {
    const a = endOperation(start('a', [plannedWrite.assignRole(USER, ROLE, 'A')], T0, 'u', 'env-aaaa1111'), T0 + 1);
    const b = endOperation(start('b', [plannedWrite.assignRole(USER, ROLE, 'B')], T0 + 5, 'u', 'env-bbbb2222'), T0 + 6);
    expect(formatOperationsReport([a, b], { now: NOW, timeZone: 'UTC' })).toContain('Environment: multiple (env-bbbb2222, env-aaaa1111)');
    expect(environmentShort([a])).toBe('envaaaa1');
    expect(environmentShort([a, b])).toBe('multi');
    expect(environmentShort([])).toBe('none');
    const empty = formatOperationsReport([], { now: NOW, timeZone: 'UTC' });
    expect(empty).toContain('No operations selected.');
    expect(empty).toContain('Environment: none');
  });

  it('renders the time zone offset correctly (east, west, half hour, invalid zone falls back to UTC)', () => {
    expect(localText(T0, 'Europe/Helsinki')).toBe('2026-11-03 21:40:12 UTC+02:00 (Europe/Helsinki)');
    expect(localText(T0, 'America/New_York')).toBe('2026-11-03 14:40:12 UTC-05:00 (America/New_York)');
    expect(localText(T0, 'Asia/Kolkata')).toBe('2026-11-04 01:10:12 UTC+05:30 (Asia/Kolkata)');
    expect(localText(T0, 'Not/AZone')).toBe('2026-11-03 19:40:12 UTC+00:00 (UTC)');
    expect(localText(Number.NaN, 'UTC')).toBe('unknown');
    expect(utcText(1e100)).toBe('unknown');
  });

  it('is deterministic: the same input gives the same text', () => {
    const ops = [verifiedOp(), failedOp()];
    expect(formatOperationsReport(ops, { now: NOW, timeZone: 'Europe/Helsinki' })).toBe(formatOperationsReport([...ops].reverse(), { now: NOW, timeZone: 'Europe/Helsinki' }));
  });

  it('produces a stable, ticket-ready layout (snapshot)', () => {
    const text = formatOperationsReport([failedOp()], { now: NOW, timeZone: 'Europe/Helsinki' });
    expect(text).toBe(
      [
        'DATAVERSE SECURITY MANAGER - OPERATIONS REPORT',
        'Generated: 2026-11-03 22:00:00 UTC+02:00 (Europe/Helsinki) / 2026-11-03 20:00:00 UTC',
        'Environment: 33333333-3333-3333-3333-333333333333',
        'Operations in this report: 1',
        'Summary: 0 verified, 1 failed, 0 uncertain, 0 not verified, 0 no write',
        '',
        '-'.repeat(72),
        '[1/1] FAILED - Role privilege change',
        'Started: 2026-11-03 21:41:12 UTC+02:00 (Europe/Helsinki) / 2026-11-03 19:41:12 UTC',
        'Ended: 2026-11-03 21:41:14 UTC+02:00 (Europe/Helsinki) / 2026-11-03 19:41:14 UTC',
        'Environment: 33333333-3333-3333-3333-333333333333',
        'Confirmed by: Tool user (confirmed in the PPTB UI)',
        'Operation id: op-fail',
        'Correlation id: corr-op-fail',
        'Result: The operation failed. See the step outcomes below.',
        'Steps (1):',
        '  1. [FAILED] Add Write on Account at User',
        '     Before: not recorded',
        '     Re-read: did not confirm the end state',
        '     Problem: permission denied. The account lacks a privilege for this change.',
        '',
        '='.repeat(72),
        'SUMMARY',
        'Operations: 1 - 0 verified, 1 failed, 0 uncertain, 0 not verified, 0 no write',
        'Steps: 1 - 0 verified, 1 failed, 0 uncertain, 0 not verified, 0 no write',
        'A step counts as verified only when a re-read confirmed it. There is no automatic rollback.',
        '',
      ].join('\n'),
    );
  });
});

describe('cleanLine', () => {
  it('flattens whitespace, removes control characters, scrubs tokens and e-mail addresses', () => {
    expect(cleanLine('a\r\nb\u0007  c')).toBe('a b c');
    expect(cleanLine('mail me at x.y@z.org please')).toBe('mail me at [email removed] please');
    expect(cleanLine(undefined)).toBe('');
  });
});
