import { deriveStatus, newestFirst, scrubSensitive } from './record';
import type { OperationRecord } from './types';

// JSON and CSV exports of one operation or of the whole history. Only ledger fields are exported (ids, timestamps, plain language,
// outcomes); the ledger never holds tokens or record contents, and text is scrubbed again on the way out.

export const EXPORT_FORMAT_VERSION = 1;

function iso(ms: number | undefined): string {
  return ms === undefined || !Number.isFinite(ms) || Math.abs(ms) > 8.64e15 ? '' : new Date(ms).toISOString();
}

function exportOperation(op: OperationRecord) {
  return {
    operationId: op.operationId,
    correlationId: op.correlationId,
    ...(op.serverCorrelationId ? { serverCorrelationId: op.serverCorrelationId } : {}),
    environmentId: op.environmentId,
    actor: op.actor,
    source: op.source,
    ...(op.sourceOperationId ? { sourceOperationId: op.sourceOperationId } : {}),
    planHash: op.planHash,
    status: deriveStatus(op),
    verified: deriveStatus(op) === 'succeeded',
    startedAt: iso(op.startedAtMs),
    ...(op.endedAtMs !== undefined ? { endedAt: iso(op.endedAtMs) } : {}),
    steps: op.steps.map((s) => ({
      index: s.index,
      key: s.key,
      kind: s.kind,
      description: scrubSensitive(s.description),
      outcome: s.outcome,
      verified: s.verified,
      failureClass: s.failure,
      message: scrubSensitive(s.message),
      ...(s.technical ? { technical: scrubSensitive(s.technical) } : {}),
      ...(s.serverCorrelationId ? { serverCorrelationId: s.serverCorrelationId } : {}),
      ...(s.startedAtMs !== undefined ? { startedAt: iso(s.startedAtMs) } : {}),
      ...(s.endedAtMs !== undefined ? { endedAt: iso(s.endedAtMs) } : {}),
    })),
  };
}

export function operationToJson(op: OperationRecord, exportedAtMs: number): string {
  return JSON.stringify({ format: 'dsm-operation', version: EXPORT_FORMAT_VERSION, exportedAt: iso(exportedAtMs), operation: exportOperation(op) }, null, 2);
}

export function historyToJson(ops: readonly OperationRecord[], exportedAtMs: number): string {
  return JSON.stringify(
    { format: 'dsm-operation-history', version: EXPORT_FORMAT_VERSION, exportedAt: iso(exportedAtMs), operations: newestFirst(ops).map(exportOperation) },
    null,
    2,
  );
}

const FORMULA_START = /^[=+\-@\t\r]/;

/** One CSV cell: formula-looking text gets a leading apostrophe (spreadsheet formula injection), then RFC 4180 quoting. */
export function csvCell(value: string | number | boolean | undefined): string {
  let text = value === undefined ? '' : String(value);
  if (FORMULA_START.test(text)) text = `'${text}`;
  return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

export const CSV_COLUMNS = [
  'operationId',
  'correlationId',
  'serverCorrelationId',
  'environmentId',
  'actor',
  'operationStatus',
  'operationStarted',
  'operationEnded',
  'stepIndex',
  'stepKey',
  'kind',
  'intendedChange',
  'stepOutcome',
  'verified',
  'failureClass',
  'message',
  'technical',
  'stepServerCorrelationId',
  'stepStarted',
  'stepEnded',
] as const;

function rowsOf(op: OperationRecord): string[] {
  const head = [op.operationId, op.correlationId, op.serverCorrelationId, op.environmentId, op.actor, deriveStatus(op), iso(op.startedAtMs), iso(op.endedAtMs)];
  if (op.steps.length === 0) return [[...head, ...new Array<string>(CSV_COLUMNS.length - head.length).fill('')].map(csvCell).join(',')];
  return op.steps.map((s) =>
    [
      ...head,
      s.index,
      s.key,
      s.kind,
      scrubSensitive(s.description),
      s.outcome,
      s.verified,
      s.failure,
      scrubSensitive(s.message),
      s.technical ? scrubSensitive(s.technical) : '',
      s.serverCorrelationId,
      iso(s.startedAtMs),
      iso(s.endedAtMs),
    ]
      .map(csvCell)
      .join(','),
  );
}

/** RFC 4180: CRLF line ends, header row, one row per step. */
export function toCsv(ops: readonly OperationRecord[]): string {
  const lines = [CSV_COLUMNS.join(','), ...newestFirst(ops).flatMap(rowsOf)];
  return lines.join('\r\n') + '\r\n';
}
