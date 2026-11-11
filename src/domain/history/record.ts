import type { ApprovedPlan, OperationResult, Outcome } from '../operations';
import { stateChecksum, stateFitsStep } from './state';
import type { OperationRecord, OperationStatus, StepRecord, TargetState } from './types';

// Building and updating an operation record. All functions are pure and return new records.

/** Random correlation id (128 bits, hex). Says nothing about people or data. */
export function newCorrelationId(): string {
  const bytes = new Uint8Array(16);
  globalThis.crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}

const REDACTED = '[redacted]';

/**
 * Defence in depth: the contract says descriptions, messages and technical text carry no secrets, but anything that looks like a
 * bearer token, a JWT or a `token=`/`secret=`/`password=` pair is removed before it reaches the ledger or an export.
 */
export function scrubSensitive(text: string): string {
  return text
    .replace(/\bBearer\s+[A-Za-z0-9._~+/=-]+/gi, `Bearer ${REDACTED}`)
    .replace(/\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}(?:\.[A-Za-z0-9_-]*)?/g, REDACTED)
    .replace(/\b(access_token|refresh_token|id_token|client_secret|authorization|password|secret|token)(\s*[=:]\s*)[^\s,;&"']+/gi, `$1$2${REDACTED}`);
}

export interface BeginOptions {
  readonly correlationId?: string;
  readonly serverCorrelationId?: string;
}

/** The ledger entry written before anything is sent: every confirmed write is a pending step. */
export function beginOperation(approval: ApprovedPlan, nowMs: number, options: BeginOptions = {}): OperationRecord {
  const steps: StepRecord[] = approval.plan.writes.map((w, index) => ({
    index,
    key: w.key,
    kind: w.kind,
    description: scrubSensitive(w.description),
    outcome: 'pending',
    verified: false,
    failure: 'none',
    message: 'Not attempted yet.',
  }));
  const serverCorrelationId = options.serverCorrelationId?.trim();
  return {
    schemaVersion: 2,
    operationId: approval.operationId,
    correlationId: options.correlationId ?? newCorrelationId(),
    ...(serverCorrelationId ? { serverCorrelationId: scrubSensitive(serverCorrelationId) } : {}),
    environmentId: approval.environmentId,
    actor: scrubSensitive(approval.approvedBy),
    planHash: approval.planHash,
    source: approval.context.source,
    ...(approval.context.sourceOperationId ? { sourceOperationId: approval.context.sourceOperationId } : {}),
    ...(approval.context.sourceOperationIds && approval.context.sourceOperationIds.length > 0 ? { sourceOperationIds: [...approval.context.sourceOperationIds] } : {}),
    startedAtMs: nowMs,
    steps,
  };
}

function replaceStep(op: OperationRecord, key: string, update: (s: StepRecord) => StepRecord): OperationRecord {
  if (!op.steps.some((s) => s.key === key)) throw new Error('This step is not part of the recorded operation.');
  return { ...op, steps: op.steps.map((s) => (s.key === key ? update(s) : s)) };
}

/** The step is about to be sent. */
export function markStepStarted(op: OperationRecord, key: string, nowMs: number): OperationRecord {
  return replaceStep(op, key, (s) => ({ ...s, startedAtMs: nowMs, message: 'Sent; no result recorded yet.' }));
}

export interface StepResultOptions {
  /** True only when a re-read confirmed the end state. Without it `succeeded` is recorded as `notVerified`. */
  readonly verified?: boolean;
  readonly serverCorrelationId?: string;
  /** State READ before the write (never inferred). A state that is not about this step's target is ignored. */
  readonly before?: TargetState;
  /** State found by the verifying re-read. */
  readonly after?: TargetState;
}

/** Outcome honesty: `succeeded` is kept only when the caller says a re-read confirmed it. */
export function recordStepResult(
  op: OperationRecord,
  key: string,
  result: OperationResult,
  nowMs: number,
  options: StepResultOptions = {},
): OperationRecord {
  const confirmed = result.outcome === 'succeeded' && options.verified === true;
  const outcome: Outcome = result.outcome === 'succeeded' && !confirmed ? 'notVerified' : result.outcome;
  const message =
    result.outcome === 'succeeded' && !confirmed ? `Accepted, but no re-read confirmed it. ${result.message}`.trim() : result.message;
  const server = options.serverCorrelationId?.trim();
  return replaceStep(op, key, (s) => {
    const { technical: _old, serverCorrelationId: _oldServer, before: _b, after: _a, stateChecksum: _c, stateIntegrity: _i, ...rest } = s;
    void _old;
    void _oldServer;
    void _b;
    void _a;
    void _c;
    void _i;
    const before = options.before && stateFitsStep(s, options.before) ? options.before : undefined;
    const after = options.after && stateFitsStep(s, options.after) ? options.after : undefined;
    return {
      ...rest,
      ...(before ? { before } : {}),
      ...(after ? { after } : {}),
      ...(before || after ? { stateChecksum: stateChecksum(s.key, before, after), stateIntegrity: 'ok' as const } : {}),
      outcome,
      verified: confirmed,
      failure: result.failure,
      message: scrubSensitive(message),
      ...(result.technical ? { technical: scrubSensitive(result.technical) } : {}),
      ...(server ? { serverCorrelationId: scrubSensitive(server) } : {}),
      endedAtMs: nowMs,
    };
  });
}

/** Closes the operation. A step still pending was possibly sent and has no result: it becomes `uncertain`, never success or failure. */
export function endOperation(op: OperationRecord, nowMs: number): OperationRecord {
  return {
    ...op,
    endedAtMs: nowMs,
    steps: op.steps.map((s) =>
      s.outcome === 'pending'
        ? {
            ...s,
            outcome: 'uncertain' as const,
            verified: false,
            failure: s.startedAtMs === undefined ? ('none' as const) : ('history' as const),
            message:
              s.startedAtMs === undefined
                ? 'This step was never attempted.'
                : 'No result was recorded for this step; it may or may not have been applied.',
          }
        : s,
    ),
  };
}

/**
 * An operation that never got an end line and is not being run by this session was interrupted (the tool closed, the host
 * restarted). Its unfinished steps may have been sent, so they become `uncertain` and are offered for a re-read. The time of the
 * last recorded activity is used as its end.
 */
export function reconcileAbandoned(ops: readonly OperationRecord[], isActive: (operationId: string) => boolean): OperationRecord[] {
  return ops.map((op) => {
    if (op.endedAtMs !== undefined || isActive(op.operationId)) return op;
    const last = Math.max(op.startedAtMs, ...op.steps.map((s) => s.endedAtMs ?? s.startedAtMs ?? 0));
    return endOperation(op, last);
  });
}

/** What the whole operation is, from its steps. `succeeded` needs every step verified. */
export function deriveStatus(op: OperationRecord): OperationStatus {
  if (op.endedAtMs === undefined && op.steps.some((s) => s.outcome === 'pending')) return 'inProgress';
  const outcomes = op.steps.map((s) => (s.outcome === 'pending' ? ('uncertain' as const) : s.outcome));
  if (outcomes.length === 0) return 'skipped';
  if (outcomes.every((o, i) => o === 'succeeded' && op.steps[i]?.verified === true)) return 'succeeded';
  if (outcomes.every((o) => o === 'skipped')) return 'skipped';
  if (outcomes.every((o) => o === 'succeeded' || o === 'notVerified')) return 'notVerified';
  const applied = outcomes.some((o) => o === 'succeeded' || o === 'notVerified' || o === 'partiallyApplied');
  if (applied) return 'partiallyApplied';
  if (outcomes.some((o) => o === 'uncertain')) return 'uncertain';
  return 'failed';
}

/** Verified means every step was confirmed by a re-read. Anything else is shown as unverified. */
export function isVerified(op: OperationRecord): boolean {
  return deriveStatus(op) === 'succeeded';
}

/** Newest first; ties by operation id so the order is stable. */
export function newestFirst(ops: readonly OperationRecord[]): OperationRecord[] {
  return [...ops].sort((a, b) => b.startedAtMs - a.startedAtMs || (a.operationId < b.operationId ? 1 : a.operationId > b.operationId ? -1 : 0));
}
