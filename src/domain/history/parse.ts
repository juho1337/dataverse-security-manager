import type { FailureClass, WriteKind } from '../operations';
import { scrubSensitive } from './record';
import { parseState, stateChecksum, stateFitsStep } from './state';
import type { OperationRecord, StepOutcome, StepRecord, TargetState } from './types';

// Reads records back from storage. Allow-list: every field is validated and rebuilt, so unknown fields (anything that
// should not be in the ledger) are dropped, and a damaged record is counted and skipped instead of hiding the rest.

const KINDS: readonly string[] = ['addPrivilege', 'removePrivilege', 'assignRole', 'unassignRole', 'moveUser'];
const OUTCOMES: readonly string[] = ['succeeded', 'failed', 'skipped', 'partiallyApplied', 'notVerified', 'uncertain', 'pending'];
const FAILURES: readonly string[] = ['none', 'validation', 'permission', 'throttling', 'connection', 'timeout', 'execution', 'identity', 'history'];
const SOURCES: readonly string[] = ['user', 'recovery', 'retry', 'restore'];
const MAX_SOURCE_OPERATIONS = 1000;

type Raw = Record<string, unknown>;
const isObj = (v: unknown): v is Raw => typeof v === 'object' && v !== null && !Array.isArray(v);
const str = (v: unknown): v is string => typeof v === 'string';
const num = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
/** A timestamp inside the JavaScript Date range, so formatting it can never throw. */
const time = (v: unknown): v is number => num(v) && Math.abs(v) <= 8.64e15;

function parseStep(v: unknown, schemaVersion: 1 | 2): StepRecord | null {
  if (!isObj(v)) return null;
  const { index, key, kind, description, outcome, verified, failure, message, technical, serverCorrelationId, startedAtMs, endedAtMs, before, after, stateChecksum: checksum } = v;
  if (!num(index) || !str(key) || !str(kind) || !KINDS.includes(kind) || !str(description) || !str(outcome) || !OUTCOMES.includes(outcome)) return null;
  if (!str(failure) || !FAILURES.includes(failure) || !str(message)) return null;
  // A present but out-of-range timestamp means a damaged entry: the whole record is dropped, not rendered.
  if ((startedAtMs !== undefined && !time(startedAtMs)) || (endedAtMs !== undefined && !time(endedAtMs))) return null;
  // Outcome honesty also on the way in: `verified` only counts on a succeeded step.
  const isVerified = verified === true && outcome === 'succeeded';

  // Schema v2 states. A legacy (v1) record has none, whatever the file says. A state that is not a valid state, or is about another target than
  // the step names, makes the entry inconsistent and the whole record is dropped; states whose checksum does not match are dropped and flagged
  // (the history stays readable, the step is just not restorable).
  let beforeState: TargetState | undefined;
  let afterState: TargetState | undefined;
  let integrity: 'ok' | 'failed' | undefined;
  const hasStates = schemaVersion === 2 && (before !== undefined || after !== undefined);
  if (hasStates) {
    const b = before === undefined ? undefined : parseState(before);
    const a = after === undefined ? undefined : parseState(after);
    if (b === null || a === null) return null;
    const step = { kind: kind as WriteKind, key };
    if ((b && !stateFitsStep(step, b)) || (a && !stateFitsStep(step, a))) return null;
    if (str(checksum) && checksum === stateChecksum(key, b, a)) {
      beforeState = b;
      afterState = a;
      integrity = 'ok';
    } else {
      integrity = 'failed';
    }
  }
  return {
    index,
    key,
    kind: kind as WriteKind,
    description: scrubSensitive(description),
    outcome: outcome as StepOutcome,
    verified: isVerified,
    failure: failure as FailureClass,
    message: scrubSensitive(message),
    ...(str(technical) ? { technical: scrubSensitive(technical) } : {}),
    ...(str(serverCorrelationId) ? { serverCorrelationId: scrubSensitive(serverCorrelationId) } : {}),
    ...(time(startedAtMs) ? { startedAtMs } : {}),
    ...(time(endedAtMs) ? { endedAtMs } : {}),
    ...(beforeState ? { before: beforeState } : {}),
    ...(afterState ? { after: afterState } : {}),
    ...(integrity === 'ok' && str(checksum) ? { stateChecksum: checksum } : {}),
    ...(integrity ? { stateIntegrity: integrity } : {}),
  };
}

export function parseOperationRecord(v: unknown): OperationRecord | null {
  if (!isObj(v) || (v.schemaVersion !== 1 && v.schemaVersion !== 2) || !Array.isArray(v.steps)) return null;
  const schemaVersion: 1 | 2 = v.schemaVersion;
  const { operationId, correlationId, serverCorrelationId, environmentId, actor, planHash, source, sourceOperationId, sourceOperationIds, startedAtMs, endedAtMs } = v;
  if (!str(operationId) || !str(correlationId) || !str(environmentId) || !str(actor) || !str(planHash) || !time(startedAtMs)) return null;
  if (endedAtMs !== undefined && !time(endedAtMs)) return null;
  if (!str(source) || !SOURCES.includes(source)) return null;
  let sourceIds: string[] | undefined;
  if (sourceOperationIds !== undefined) {
    if (!Array.isArray(sourceOperationIds) || sourceOperationIds.length > MAX_SOURCE_OPERATIONS || !sourceOperationIds.every(str)) return null;
    sourceIds = sourceOperationIds as string[];
  }
  const steps: StepRecord[] = [];
  for (const raw of v.steps) {
    const s = parseStep(raw, schemaVersion);
    if (!s || s.index !== steps.length) return null; // a step's index must equal its position
    steps.push(s);
  }
  return {
    schemaVersion,
    operationId,
    correlationId,
    ...(str(serverCorrelationId) ? { serverCorrelationId: scrubSensitive(serverCorrelationId) } : {}),
    environmentId,
    actor: scrubSensitive(actor),
    planHash,
    source: source as OperationRecord['source'],
    ...(str(sourceOperationId) ? { sourceOperationId } : {}),
    ...(sourceIds && sourceIds.length > 0 ? { sourceOperationIds: sourceIds } : {}),
    startedAtMs,
    ...(time(endedAtMs) ? { endedAtMs } : {}),
    steps,
  };
}

export interface ParsedHistory {
  readonly records: readonly OperationRecord[];
  /** Entries that could not be read and were skipped. */
  readonly dropped: number;
}

export function parseOperationRecords(value: unknown): ParsedHistory {
  if (value === undefined || value === null) return { records: [], dropped: 0 };
  if (!Array.isArray(value)) return { records: [], dropped: 1 };
  const records: OperationRecord[] = [];
  let dropped = 0;
  for (const raw of value) {
    const r = parseOperationRecord(raw);
    if (r) records.push(r);
    else dropped++;
  }
  return { records, dropped };
}
