import { describe, expect, it } from 'vitest';
import { approvePlan, createWritePlan, plannedWrite, refused, type OperationResult } from '../operations';
import { csvCell, historyToJson, operationToJson, toCsv } from './export';
import { parseOperationRecords } from './parse';
import { analyzeOperation, NO_AUTOMATIC_ROLLBACK } from './reconcile';
import {
  beginOperation,
  deriveStatus,
  endOperation,
  markStepStarted,
  newCorrelationId,
  newestFirst,
  reconcileAbandoned,
  recordStepResult,
  scrubSensitive,
} from './record';

const ROLE = '11111111-1111-1111-1111-111111111111';
const USER = '22222222-2222-2222-2222-222222222222';
const ENV = '33333333-3333-3333-3333-333333333333';

function approval(descriptions: readonly string[] = ['Give role A Read on Project', 'Assign role A to Ann']) {
  const writes = [
    plannedWrite.addPrivilege(ROLE, 'aaaaaaaa-0000-0000-0000-000000000001', 'Basic', descriptions[0] ?? 'x'),
    plannedWrite.assignRole(USER, ROLE, descriptions[1] ?? 'y'),
  ];
  return approvePlan(createWritePlan(writes), ENV, 'ann@contoso.test', 1000, { operationId: 'op1' });
}

const ok: OperationResult = { outcome: 'succeeded', message: 'Done.', failure: 'none' };

function begin() {
  return beginOperation(approval(), 1000, { correlationId: 'corr-1' });
}

describe('record', () => {
  it('starts with every confirmed write pending and the ledger fields set', () => {
    const op = begin();
    expect(op).toMatchObject({ operationId: 'op1', correlationId: 'corr-1', environmentId: ENV, actor: 'ann@contoso.test', source: 'user' });
    expect(op.steps.map((s) => s.outcome)).toEqual(['pending', 'pending']);
    expect(deriveStatus(op)).toBe('inProgress');
  });

  it('generates distinct random correlation ids', () => {
    expect(newCorrelationId()).toMatch(/^[0-9a-f]{32}$/);
    expect(newCorrelationId()).not.toBe(newCorrelationId());
  });

  it('keeps an optional server correlation id', () => {
    const op = beginOperation(approval(), 1, { serverCorrelationId: ' req-9 ' });
    expect(op.serverCorrelationId).toBe('req-9');
  });

  it('never records succeeded without a verifying re-read', () => {
    let op = begin();
    const key = op.steps[0]!.key;
    op = recordStepResult(op, key, ok, 2000);
    expect(op.steps[0]).toMatchObject({ outcome: 'notVerified', verified: false });
    expect(op.steps[0]!.message).toContain('no re-read confirmed');
    op = recordStepResult(op, key, ok, 2100, { verified: true });
    expect(op.steps[0]).toMatchObject({ outcome: 'succeeded', verified: true });
  });

  it('is succeeded only when every step is verified', () => {
    let op = begin();
    for (const s of op.steps) op = recordStepResult(op, s.key, ok, 2, { verified: true });
    expect(deriveStatus(endOperation(op, 3))).toBe('succeeded');
    const k2 = op.steps[1]!.key;
    op = recordStepResult(op, k2, ok, 2);
    expect(deriveStatus(endOperation(op, 3))).toBe('notVerified');
  });

  it('derives partial, uncertain and failed distinctly', () => {
    const [a, b] = begin().steps.map((s) => s.key) as [string, string];
    let op = recordStepResult(begin(), a, ok, 2, { verified: true });
    op = recordStepResult(op, b, refused('permission', 'No rights.'), 3);
    expect(deriveStatus(endOperation(op, 4))).toBe('partiallyApplied');

    op = recordStepResult(begin(), a, { outcome: 'uncertain', message: 'Timed out.', failure: 'timeout' }, 2);
    op = recordStepResult(op, b, { outcome: 'skipped', message: 'Not attempted.', failure: 'none' }, 3);
    expect(deriveStatus(endOperation(op, 4))).toBe('uncertain');

    op = recordStepResult(begin(), a, refused('execution', 'x'), 2);
    op = recordStepResult(op, b, { outcome: 'skipped', message: 'Not attempted.', failure: 'none' }, 3);
    expect(deriveStatus(endOperation(op, 4))).toBe('failed');
  });

  it('turns a sent step without a result into uncertain when the operation ends', () => {
    let op = markStepStarted(begin(), begin().steps[0]!.key, 5);
    op = endOperation(op, 9);
    expect(op.steps[0]).toMatchObject({ outcome: 'uncertain', failure: 'history' });
    expect(op.steps[1]).toMatchObject({ outcome: 'uncertain', failure: 'none' });
    expect(op.steps[1]!.message).toContain('never attempted');
  });

  it('rejects a step that is not in the operation', () => {
    expect(() => recordStepResult(begin(), 'nope', ok, 1)).toThrow();
  });

  it('scrubs tokens from descriptions, messages and technical text', () => {
    expect(scrubSensitive('call with Bearer abc.def-123 and token=xyz789 ok')).not.toMatch(/abc\.def|xyz789/);
    expect(scrubSensitive('eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.sig')).toBe('[redacted]');
    const op = recordStepResult(begin(), begin().steps[0]!.key, { outcome: 'failed', message: 'password=hunter2', failure: 'execution', technical: 'Authorization: Bearer secrettoken' }, 2);
    expect(JSON.stringify(op)).not.toMatch(/hunter2|secrettoken/);
  });

  it('orders newest first', () => {
    const a = beginOperation(approvePlan(createWritePlan([plannedWrite.assignRole(USER, ROLE, 'a')]), ENV, 'x', 1, { operationId: 'a' }), 100);
    const b = beginOperation(approvePlan(createWritePlan([plannedWrite.assignRole(USER, ROLE, 'a')]), ENV, 'x', 1, { operationId: 'b' }), 200);
    expect(newestFirst([a, b]).map((o) => o.operationId)).toEqual(['b', 'a']);
  });
});

describe('reconcile', () => {
  it('lists failed/uncertain/notVerified steps as retry candidates, and says what must not be retried', () => {
    const [a, b] = begin().steps.map((s) => s.key) as [string, string];
    let op = recordStepResult(begin(), a, { outcome: 'uncertain', message: 'Timed out.', failure: 'timeout' }, 2);
    op = recordStepResult(op, b, refused('permission', 'No rights.'), 3);
    const r = analyzeOperation(endOperation(op, 4));
    expect(r.retryCandidates.map((c) => [c.stepKey, c.requiresRereadFirst])).toEqual([[a, true]]);
    expect(r.notRetryable.map((n) => n.stepKey)).toEqual([b]);
    expect(r.rollbackStatement).toBe(NO_AUTOMATIC_ROLLBACK);
    expect(r.recovery.available).toBe(false);
  });

  it('offers a transient failure as a plain retry and verified steps as nothing', () => {
    const [a, b] = begin().steps.map((s) => s.key) as [string, string];
    let op = recordStepResult(begin(), a, ok, 2, { verified: true });
    op = recordStepResult(op, b, refused('throttling', 'Busy.'), 3);
    const r = analyzeOperation(endOperation(op, 4));
    expect(r.retryCandidates).toHaveLength(1);
    expect(r.retryCandidates[0]).toMatchObject({ stepKey: b, requiresRereadFirst: false, environmentId: ENV });
    expect(r.advice[0]?.action).toBe('none');
  });

  it('treats an accepted-but-unverified step as read-again-then-retry, and a running operation as in progress', () => {
    const [a] = begin().steps.map((s) => s.key) as [string];
    const op = recordStepResult(begin(), a, ok, 2);
    expect(analyzeOperation(op).advice[1]?.action).toBe('inProgress');
    expect(analyzeOperation(endOperation(op, 3)).advice[0]?.action).toBe('rereadThenRetry');
  });
});

describe('export', () => {
  function finished() {
    const [a, b] = begin().steps.map((s) => s.key) as [string, string];
    let op = recordStepResult(begin(), a, ok, 2, { verified: true });
    op = recordStepResult(op, b, refused('execution', 'Failed, Dataverse said "no"', '0x80040220'), 3);
    return endOperation(op, 4);
  }

  it('neutralises formula injection and quotes per RFC 4180', () => {
    for (const bad of ['=1+1', '+SUM(A1)', '-2', '@x', '\tx', '\rx']) {
      expect(csvCell(bad).replace(/^"/, '')).toMatch(/^'/);
    }
    expect(csvCell('a,b')).toBe('"a,b"');
    expect(csvCell('say "hi"')).toBe('"say ""hi"""');
    expect(csvCell('line1\nline2')).toBe('"line1\nline2"');
    expect(csvCell('safe')).toBe('safe');
    expect(csvCell(undefined)).toBe('');
  });

  it('writes a header, one row per step and CRLF line ends', () => {
    const csv = toCsv([finished()]);
    const lines = csv.split('\r\n');
    expect(lines[0]).toContain('operationId,correlationId');
    expect(lines).toHaveLength(4);
    expect(lines[2]).toContain('"Failed, Dataverse said ""no"""');
    expect(lines[1]).toContain(',succeeded,true,');
  });

  it('neutralises a formula in a description inside the CSV', () => {
    const op = beginOperation(approvePlan(createWritePlan([plannedWrite.assignRole(USER, ROLE, '=HYPERLINK("x")')]), ENV, '+actor', 1, { operationId: 'o' }), 1);
    const csv = toCsv([op]);
    expect(csv).toContain(`"'=HYPERLINK(""x"")"`);
    expect(csv).toContain(`'+actor`);
  });

  it('exports JSON for one operation and for the history without tokens', () => {
    const op = finished();
    const one = JSON.parse(operationToJson(op, 5000)) as { operation: { status: string; verified: boolean; steps: unknown[] } };
    expect(one.operation).toMatchObject({ status: 'partiallyApplied', verified: false });
    expect(one.operation.steps).toHaveLength(2);
    const all = JSON.parse(historyToJson([op], 5000)) as { operations: unknown[]; format: string };
    expect(all.format).toBe('dsm-operation-history');
    expect(all.operations).toHaveLength(1);
    const leaky = recordStepResult(op, op.steps[0]!.key, { outcome: 'failed', message: 'Bearer abc123', failure: 'execution' }, 9);
    expect(historyToJson([leaky], 1) + toCsv([leaky])).not.toContain('abc123');
  });
});

describe('interrupted operations', () => {
  it('shows an unended operation that this session does not run as uncertain with a re-read, not as still running', () => {
    const started = markStepStarted(begin(), begin().steps[0]!.key, 1500);
    const [abandoned] = reconcileAbandoned([started], () => false);
    expect(abandoned!.endedAtMs).toBe(1500);
    expect(deriveStatus(abandoned!)).toBe('uncertain');
    expect(analyzeOperation(abandoned!).retryCandidates.length).toBe(2);
    expect(analyzeOperation(abandoned!).advice.every((a) => a.action !== 'inProgress')).toBe(true);
  });

  it('leaves an operation this session is still running alone', () => {
    const [same] = reconcileAbandoned([begin()], (id) => id === 'op1');
    expect(deriveStatus(same!)).toBe('inProgress');
  });
});

describe('parse timestamps', () => {
  it('drops records whose timestamps are outside the Date range instead of letting them crash rendering', () => {
    const good = JSON.parse(JSON.stringify(endOperation(begin(), 5))) as Record<string, unknown>;
    const bad1 = { ...good, startedAtMs: 1e100 };
    const bad2 = { ...good, endedAtMs: -1e100 };
    const bad3 = { ...good, steps: [{ ...(good.steps as Array<Record<string, unknown>>)[0], startedAtMs: 9e15 }] };
    const { records, dropped } = parseOperationRecords([good, bad1, bad2, bad3]);
    expect(records).toHaveLength(1);
    expect(dropped).toBe(3);
  });
});

describe('superseded steps are not offered for retry', () => {
  function assignThenUnassign() {
    const writes = [plannedWrite.assignRole(USER, ROLE, 'Assign role A to Ann'), plannedWrite.unassignRole(USER, ROLE, 'Remove role A from Ann')];
    const op = beginOperation(approvePlan(createWritePlan(writes), ENV, 'ann@contoso.test', 1000, { operationId: 'sup' }), 1000);
    return { op, keys: op.steps.map((s) => s.key) as [string, string] };
  }

  it('an assignment that failed by throttling is not a retry when a later removal of the same role was verified', () => {
    const { op, keys } = assignThenUnassign();
    let rec = recordStepResult(op, keys[0], refused('throttling', 'Busy.'), 2);
    rec = recordStepResult(rec, keys[1], ok, 3, { verified: true });
    const r = analyzeOperation(endOperation(rec, 4));
    expect(r.retryCandidates).toEqual([]);
    expect(r.advice[0]?.action).toBe('review');
    expect(r.notRetryable.map((n) => [n.stepKey, n.reason])).toEqual([[keys[0], expect.stringContaining('superseded')]]);
  });

  it('when the later step is uncertain the pair is unproven: read again, no blind retry', () => {
    const { op, keys } = assignThenUnassign();
    let rec = recordStepResult(op, keys[0], refused('throttling', 'Busy.'), 2);
    rec = recordStepResult(rec, keys[1], { outcome: 'uncertain', message: 'No answer.', failure: 'connection' }, 3);
    const r = analyzeOperation(endOperation(rec, 4));
    expect(r.advice[0]?.action).toBe('reread');
    expect(r.retryCandidates.map((c) => c.stepKey)).not.toContain(keys[0]);
    expect(r.notRetryable.find((n) => n.stepKey === keys[0])?.reason).toMatch(/not verified/);
  });

  it('steps on different targets are unaffected', () => {
    const other = '44444444-4444-4444-4444-444444444444';
    const writes = [plannedWrite.assignRole(USER, ROLE, 'a'), plannedWrite.unassignRole(USER, other, 'b')];
    const op = beginOperation(approvePlan(createWritePlan(writes), ENV, 'x', 1, { operationId: 'diff' }), 1);
    const keys = op.steps.map((s) => s.key) as [string, string];
    let rec = recordStepResult(op, keys[0], refused('throttling', 'Busy.'), 2);
    rec = recordStepResult(rec, keys[1], ok, 3, { verified: true });
    expect(analyzeOperation(endOperation(rec, 4)).retryCandidates.map((c) => c.stepKey)).toEqual([keys[0]]);
  });
});

describe('parse step indices', () => {
  it('drops a record whose step indices do not match their positions, so advice cannot attach to the wrong step', () => {
    const good = JSON.parse(JSON.stringify(endOperation(begin(), 5))) as Record<string, unknown>;
    const steps = good.steps as Array<Record<string, unknown>>;
    const bad = { ...good, steps: steps.map((st, i) => ({ ...st, index: steps.length - 1 - i })) };
    const { records, dropped } = parseOperationRecords([good, bad]);
    expect(records).toHaveLength(1);
    expect(dropped).toBe(steps.length > 1 ? 1 : 0);
  });
});

describe('parse', () => {
  it('round-trips records, drops damaged ones and unknown fields, and never trusts verified without succeeded', () => {
    const op = endOperation(begin(), 5);
    const stored = JSON.parse(JSON.stringify(op)) as Record<string, unknown>;
    stored.accessToken = 'secret';
    (stored.steps as Array<Record<string, unknown>>)[0]!.verified = true; // outcome is uncertain, not succeeded
    const { records, dropped } = parseOperationRecords([stored, { nonsense: 1 }, 'x']);
    expect(dropped).toBe(2);
    expect(records).toHaveLength(1);
    expect(JSON.stringify(records[0])).not.toContain('accessToken');
    expect(records[0]!.steps[0]!.verified).toBe(false);
    expect(parseOperationRecords(undefined)).toEqual({ records: [], dropped: 0 });
    expect(parseOperationRecords({}).dropped).toBe(1);
  });
});
