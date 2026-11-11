import type { FailureClass, WriteKind } from '../operations';
import { deriveStatus, newestFirst, scrubSensitive } from './record';
import type { OperationRecord, OperationStatus, StepRecord, TargetState } from './types';

// Ticket-ready plain text for one or many recorded operations (Jira, e-mail, support tickets). Pure and deterministic: the clock and the
// time zone are injected. It reports ONLY what the ledger holds: nothing about the state before a change is invented, and an operation
// that did not finish is never reported as done. Text is scrubbed (tokens) and e-mail addresses are removed; there are no record contents.

/** State captured before/after a change, when a write path recorded it. Absent for every operation recorded before that existed. */
export interface CapturedChange {
  readonly before?: string;
  readonly after?: string;
}

export interface ReportOptions {
  /** Generation time (ms since the epoch). */
  readonly now: number;
  /** IANA zone of the viewer for the local time; the runtime zone when absent, UTC when it is not a valid zone. */
  readonly timeZone?: string;
  /**
   * Optional source of captured before/after text for a step. Nothing is printed as "before" unless this returns it; otherwise the report
   * says "Before: not recorded".
   */
  readonly captured?: (op: OperationRecord, step: StepRecord) => CapturedChange | undefined;
}

const RULE = '-'.repeat(72);
const DOUBLE_RULE = '='.repeat(72);
const EMAIL = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;
const MAX_TEXT = 300;

/** One line of free text: tokens scrubbed, e-mail addresses removed, control characters and line breaks collapsed, length capped. */
export function cleanLine(text: string | undefined): string {
  if (text === undefined) return '';
  const flat = sanitizeLine(text);
  return flat.length > MAX_TEXT ? `${flat.slice(0, MAX_TEXT - 3)}...` : flat;
}

/** The same sanitizing without the length cap: for structured text built from ids and fixed words (a recorded state), where cutting it would lose data. */
export function sanitizeLine(text: string): string {
  return scrubSensitive(text)
    .replace(EMAIL, '[email removed]')
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u001f\u007f]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

const pad = (n: number): string => String(n).padStart(2, '0');
const validMs = (ms: number | undefined): ms is number => ms !== undefined && Number.isFinite(ms) && Math.abs(ms) <= 8.64e15;

/** 2026-11-03 19:40:12 UTC */
export function utcText(ms: number | undefined): string {
  if (!validMs(ms)) return 'unknown';
  return `${new Date(ms).toISOString().slice(0, 19).replace('T', ' ')} UTC`;
}

function resolveZone(timeZone: string | undefined): string {
  try {
    const zone = timeZone ?? new Intl.DateTimeFormat().resolvedOptions().timeZone;
    new Intl.DateTimeFormat('en-US', { timeZone: zone });
    return zone || 'UTC';
  } catch {
    return 'UTC';
  }
}

/** Offset of `zone` from UTC at `ms`, in minutes (positive east of Greenwich). */
function offsetMinutes(ms: number, zone: string): number {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: zone,
    hourCycle: 'h23',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  }).formatToParts(new Date(ms));
  const get = (type: string): number => Number(parts.find((p) => p.type === type)?.value ?? '0');
  const asUtc = Date.UTC(get('year'), get('month') - 1, get('day'), get('hour'), get('minute'), get('second'));
  return Math.round((asUtc - Math.floor(ms / 1000) * 1000) / 60000);
}

/** 2026-11-03 21:40:12 UTC+02:00 (Europe/Helsinki) */
export function localText(ms: number | undefined, timeZone: string | undefined): string {
  if (!validMs(ms)) return 'unknown';
  const zone = resolveZone(timeZone);
  const off = offsetMinutes(ms, zone);
  const local = new Date(ms + off * 60000).toISOString().slice(0, 19).replace('T', ' ');
  const sign = off < 0 ? '-' : '+';
  const abs = Math.abs(off);
  return `${local} UTC${sign}${pad(Math.floor(abs / 60))}:${pad(abs % 60)} (${zone})`;
}

/** Local time and UTC together, so the reader of a ticket never has to guess the zone. */
function both(ms: number | undefined, timeZone: string | undefined): string {
  return validMs(ms) ? `${localText(ms, timeZone)} / ${utcText(ms)}` : 'not recorded';
}

const KIND_LABEL: Readonly<Record<WriteKind, string>> = {
  addPrivilege: 'Role privilege change',
  removePrivilege: 'Role privilege removal',
  assignRole: 'Role assignment',
  unassignRole: 'Role removal',
  moveUser: 'Business Unit move',
};

function actionOf(op: OperationRecord): string {
  const kinds = [...new Set(op.steps.map((s) => KIND_LABEL[s.kind] ?? s.kind))];
  const base = kinds.length === 0 ? 'Operation without steps' : kinds.join(' + ');
  if (op.source === 'retry') return `${base} (retry${op.sourceOperationId ? ` of ${cleanLine(op.sourceOperationId)}` : ''})`;
  if (op.source === 'recovery') return `${base} (recovery${op.sourceOperationId ? ` of ${cleanLine(op.sourceOperationId)}` : ''})`;
  return base;
}

const STATUS_TAG: Readonly<Record<OperationStatus, string>> = {
  succeeded: 'VERIFIED',
  failed: 'FAILED',
  uncertain: 'UNCERTAIN',
  notVerified: 'NOT VERIFIED',
  partiallyApplied: 'PARTIALLY APPLIED',
  skipped: 'NO WRITE',
  inProgress: 'NOT FINISHED',
};

const STATUS_RESULT: Readonly<Record<OperationStatus, string>> = {
  succeeded: 'Every step was confirmed by a re-read.',
  failed: 'The operation failed. See the step outcomes below.',
  uncertain: 'It may or may not have been applied. Read the objects again before relying on it.',
  notVerified: 'Dataverse accepted the change, but no re-read confirmed the end state.',
  partiallyApplied: 'Only part of the operation took effect. See the step outcomes below.',
  skipped: 'Nothing was sent to Dataverse.',
  inProgress: 'No end was recorded for this operation. Do not treat it as done.',
};

function stepTag(s: StepRecord): string {
  switch (s.outcome) {
    case 'succeeded': return s.verified ? 'VERIFIED' : 'NOT VERIFIED';
    case 'notVerified': return 'NOT VERIFIED';
    case 'failed': return 'FAILED';
    case 'uncertain': return 'UNCERTAIN';
    case 'partiallyApplied': return 'PARTIAL';
    case 'skipped': return 'NO WRITE';
    // A step whose request was sent but whose result is not recorded may well have been applied: it is never called "not attempted".
    case 'pending': return s.startedAtMs !== undefined ? 'REQUEST SENT, NO RESULT RECORDED' : 'NOT ATTEMPTED';
  }
}

const FAILURE_TEXT: Readonly<Record<FailureClass, string>> = {
  none: '',
  validation: 'the change was refused before it was sent',
  permission: 'permission denied',
  throttling: 'Dataverse was throttling requests',
  connection: 'connection problem',
  timeout: 'the request timed out',
  execution: 'Dataverse reported an error',
  identity: 'the environment or connection check failed',
  history: 'the history could not be written',
};

function problemLine(s: StepRecord): string | null {
  const message = cleanLine(s.message);
  const cls = FAILURE_TEXT[s.failure] ?? '';
  switch (s.outcome) {
    case 'failed':
    case 'uncertain':
    case 'partiallyApplied':
    case 'skipped':
      return `Problem: ${[cls, message].filter(Boolean).join('. ')}`.replace(/\.*$/, '.');
    case 'notVerified':
    case 'pending':
      return message ? `Note: ${message}` : null;
    case 'succeeded':
      return s.verified ? null : message ? `Note: ${message}` : null;
  }
}

/** A recorded target state in words, with full ids (a report is for a ticket and must be exact). */
export function describeRecordedState(state: TargetState): string {
  if (state.kind === 'privilegeDepth') return `${state.privilege} on ${state.table} (role ${state.roleId}): ${state.depth === 'None' ? 'not held' : state.depth}`;
  if (state.kind === 'roleHeld') return `role ${state.roleId} ${state.held ? 'held' : 'not held'} by user ${state.userId}`;
  const roles = state.roleIds === null ? 'direct roles not read completely' : state.roleIds.length === 0 ? 'no direct roles' : `direct roles ${[...state.roleIds].sort().join(', ')}`;
  return `user ${state.userId} in Business Unit ${state.businessUnitId}, ${roles}`;
}

function stepLines(op: OperationRecord, s: StepRecord, options: ReportOptions): string[] {
  const lines = [`  ${s.index + 1}. [${stepTag(s)}] ${cleanLine(s.description)}`];
  // The states the ledger recorded (schema v2) are printed by default; a caller can still supply its own text.
  const captured = options.captured?.(op, s);
  // A recorded state is complete (every role id of a placement); only a caller-supplied free text is capped.
  const before = captured?.before !== undefined ? cleanLine(captured.before) : s.before ? sanitizeLine(describeRecordedState(s.before)) : '';
  const after = captured?.after !== undefined ? cleanLine(captured.after) : s.after ? sanitizeLine(describeRecordedState(s.after)) : '';
  if (before && after) lines.push(`     Before -> after: ${before} -> ${after}`);
  else if (before) lines.push(`     Before: ${before}`, '     After: not recorded');
  else lines.push('     Before: not recorded');
  lines.push(`     Re-read: ${s.outcome === 'succeeded' && s.verified ? 'confirmed the intended end state' : 'did not confirm the end state'}`);
  const problem = problemLine(s);
  if (problem) lines.push(`     ${problem}`);
  if (s.serverCorrelationId) lines.push(`     Service request id: ${cleanLine(s.serverCorrelationId)}`);
  return lines;
}

function operationLines(op: OperationRecord, index: number, total: number, options: ReportOptions): string[] {
  const status = deriveStatus(op);
  const lines = [
    RULE,
    `[${index}/${total}] ${STATUS_TAG[status]} - ${actionOf(op)}`,
    `Started: ${both(op.startedAtMs, options.timeZone)}`,
    `Ended: ${op.endedAtMs === undefined ? 'not recorded (the operation did not finish)' : both(op.endedAtMs, options.timeZone)}`,
    `Environment: ${cleanLine(op.environmentId)}`,
    `Confirmed by: ${cleanLine(op.actor) || 'not recorded'}`,
    `Operation id: ${cleanLine(op.operationId)}`,
    `Correlation id: ${cleanLine(op.correlationId)}`,
  ];
  if (op.serverCorrelationId) lines.push(`Service request id: ${cleanLine(op.serverCorrelationId)}`);
  lines.push(`Result: ${STATUS_RESULT[status]}`, `Steps (${op.steps.length}):`);
  if (op.steps.length === 0) lines.push('  none recorded');
  for (const s of op.steps) lines.push(...stepLines(op, s, options));
  return lines;
}

interface Counts {
  verified: number;
  failed: number;
  uncertain: number;
  notVerified: number;
  noWrite: number;
  partial: number;
  notFinished: number;
}

const emptyCounts = (): Counts => ({ verified: 0, failed: 0, uncertain: 0, notVerified: 0, noWrite: 0, partial: 0, notFinished: 0 });

function countText(c: Counts): string {
  const parts = [`${c.verified} verified`, `${c.failed} failed`, `${c.uncertain} uncertain`, `${c.notVerified} not verified`, `${c.noWrite} no write`];
  if (c.partial > 0) parts.push(`${c.partial} partially applied`);
  if (c.notFinished > 0) parts.push(`${c.notFinished} not finished`);
  return parts.join(', ');
}

function bump(c: Counts, tag: string): void {
  switch (tag) {
    case 'VERIFIED': c.verified++; break;
    case 'FAILED': c.failed++; break;
    case 'UNCERTAIN': c.uncertain++; break;
    case 'NOT VERIFIED': c.notVerified++; break;
    case 'NO WRITE': c.noWrite++; break;
    case 'PARTIALLY APPLIED':
    case 'PARTIAL': c.partial++; break;
    default: c.notFinished++;
  }
}

/** Short environment label for file names: the first 8 characters of the id when all records share one, `multi` otherwise. */
export function environmentShort(records: readonly OperationRecord[]): string {
  const ids = [...new Set(records.map((r) => r.environmentId))];
  return ids.length === 1 ? (ids[0] ?? '').replace(/[^A-Za-z0-9]/g, '').slice(0, 8) || 'env' : ids.length === 0 ? 'none' : 'multi';
}

/** The report for the given operations, newest first. Plain text, LF line ends, ASCII punctuation in everything this function writes itself. */
export function formatOperationsReport(records: readonly OperationRecord[], options: ReportOptions): string {
  const ops = newestFirst(records);
  const envs = [...new Set(ops.map((o) => cleanLine(o.environmentId)))];
  const header = [
    'DATAVERSE SECURITY MANAGER - OPERATIONS REPORT',
    `Generated: ${both(options.now, options.timeZone)}`,
    `Environment: ${envs.length === 0 ? 'none' : envs.length === 1 ? envs[0] : `multiple (${envs.join(', ')})`}`,
    `Operations in this report: ${ops.length}`,
  ];
  if (ops.length === 0) return [...header, '', 'No operations selected.', ''].join('\n');

  const opCounts = emptyCounts();
  const stepCounts = emptyCounts();
  for (const o of ops) {
    bump(opCounts, STATUS_TAG[deriveStatus(o)]);
    for (const s of o.steps) bump(stepCounts, stepTag(s));
  }
  const body = ops.flatMap((o, i) => ['', ...operationLines(o, i + 1, ops.length, options)]);
  const stepTotal = ops.reduce((n, o) => n + o.steps.length, 0);
  return [
    ...header,
    `Summary: ${countText(opCounts)}`,
    ...body,
    '',
    DOUBLE_RULE,
    'SUMMARY',
    `Operations: ${ops.length} - ${countText(opCounts)}`,
    `Steps: ${stepTotal} - ${countText(stepCounts)}`,
    'A step counts as verified only when a re-read confirmed it. There is no automatic rollback.',
    '',
  ].join('\n');
}
