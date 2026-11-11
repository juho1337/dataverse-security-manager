import type { FailureClass, WriteKind } from '../operations';
import { deriveStatus } from './record';
import type { OperationRecord, OperationStatus, StepRecord } from './types';

// Reconciliation and safe-retry candidates, derived from a recorded operation.
// Display only: nothing here sends anything. There is NO automatic rollback; Dataverse has no atomic undo and each step is separate.

/**
 * Every write kind of this tool sets a target state (a privilege at a depth, a role assigned or not, a user in a business unit), so
 * repeating it when it already took effect changes nothing. Kept as an explicit table so a future non-idempotent kind must be decided.
 */
const IDEMPOTENT: Readonly<Record<WriteKind, boolean>> = {
  addPrivilege: true,
  removePrivilege: true,
  assignRole: true,
  unassignRole: true,
  moveUser: true,
};

export function isIdempotent(kind: WriteKind): boolean {
  return IDEMPOTENT[kind];
}

/** Failures that a repeat cannot fix: the cause (input, rights, identity) has to be fixed first. */
const NEEDS_FIX_FIRST: readonly FailureClass[] = ['validation', 'permission', 'identity'];

export type StepAction =
  /** Verified; nothing to do. */
  | 'none'
  /** Read the object again to learn whether the step took effect. */
  | 'reread'
  /** Read again first, then repeat only what is still missing. */
  | 'rereadThenRetry'
  /** Safe to repeat as a new confirmed operation. */
  | 'retry'
  /** A person has to look: fix the cause, or plan again. Not offered as a retry. */
  | 'review'
  | 'inProgress';

export interface StepAdvice {
  readonly stepKey: string;
  readonly index: number;
  readonly action: StepAction;
  readonly reason: string;
}

export interface RetryCandidate {
  readonly stepKey: string;
  readonly index: number;
  readonly kind: WriteKind;
  readonly description: string;
  readonly environmentId: string;
  /** The object must be re-read before the retry is planned (the step may already have taken effect). */
  readonly requiresRereadFirst: boolean;
  readonly reason: string;
}

export interface NotRetryable {
  readonly stepKey: string;
  readonly index: number;
  readonly reason: string;
}

export interface RecoveryAssessment {
  /** No operation offers recovery in this milestone: recording the state before a change is not implemented, so there is no verified compensating operation. */
  readonly available: false;
  readonly reason: string;
}

export const NO_AUTOMATIC_ROLLBACK =
  'There is no automatic rollback. Each step is separate and verified separately; undoing a change means planning and confirming a new operation.';

export interface OperationAnalysis {
  readonly status: OperationStatus;
  readonly advice: readonly StepAdvice[];
  readonly retryCandidates: readonly RetryCandidate[];
  readonly notRetryable: readonly NotRetryable[];
  readonly recovery: RecoveryAssessment;
  readonly rollbackStatement: string;
}

function adviceFor(op: OperationRecord, step: StepRecord): StepAdvice {
  const base = { stepKey: step.key, index: step.index };
  const ended = op.endedAtMs !== undefined;
  switch (step.outcome) {
    case 'succeeded':
      return step.verified
        ? { ...base, action: 'none', reason: 'Verified by a re-read.' }
        : { ...base, action: 'reread', reason: 'Recorded as succeeded without a verifying re-read; read the object again.' };
    case 'pending':
      return ended
        ? { ...base, action: 'rereadThenRetry', reason: 'No result was recorded; it may or may not have been applied.' }
        : { ...base, action: 'inProgress', reason: 'The operation has not ended yet.' };
    case 'notVerified':
      return { ...base, action: 'rereadThenRetry', reason: 'Dataverse accepted it, but nothing confirmed the end state. Read the object again.' };
    case 'uncertain':
      return { ...base, action: 'rereadThenRetry', reason: 'It may or may not have been applied. Read the object again before repeating it.' };
    case 'partiallyApplied':
      return { ...base, action: 'rereadThenRetry', reason: 'Only part of it was applied. Read the object again and repeat what is missing.' };
    case 'skipped':
      return { ...base, action: 'review', reason: 'Nothing was sent for this step. Plan the change again if it is still wanted.' };
    case 'failed':
      return NEEDS_FIX_FIRST.includes(step.failure)
        ? { ...base, action: 'review', reason: `A repeat will fail the same way (${step.failure}). Fix the cause first, then plan the change again.` }
        : { ...base, action: 'retry', reason: `Failed (${step.failure}); the step did not take effect and repeating it is safe.` };
  }
}

/**
 * The thing a step changes, taken from its plan key (`kind:id:id[:depth]`): which role a user holds, a role's privilege, a user's
 * Business Unit. Two steps with the same target are successive changes of one state, so the earlier one is not a statement of intent
 * once a later one exists. A key this does not recognise has no target (it is never treated as superseded).
 */
function targetOf(step: StepRecord): string | null {
  const parts = step.key.split(':');
  switch (step.kind) {
    case 'assignRole':
    case 'unassignRole':
      return parts.length >= 3 ? `user-role:${parts[1]}:${parts[2]}` : null;
    case 'addPrivilege':
    case 'removePrivilege':
      return parts.length >= 3 ? `role-privilege:${parts[1]}:${parts[2]}` : null;
    case 'moveUser':
      return parts.length >= 2 ? `user-bu:${parts[1]}` : null;
  }
}

/**
 * A step that a LATER step on the same target supersedes is never offered for repeat: repeating it could undo the later change (an
 * assignment that failed, then a verified removal of the same role, must not be offered as a retry). When the later step is not
 * verified the pair is unproven, so the only advice is to read the object again.
 */
function applySuperseded(op: OperationRecord, advice: StepAdvice[]): StepAdvice[] {
  return advice.map((a, position) => {
    if (a.action !== 'retry' && a.action !== 'rereadThenRetry') return a;
    const step = op.steps[position];
    const target = step ? targetOf(step) : null;
    if (!step || target === null) return a;
    const later = op.steps.slice(position + 1).filter((s) => targetOf(s) === target);
    if (later.length === 0) return a;
    const base = { stepKey: a.stepKey, index: a.index };
    return later.every((s) => s.outcome === 'succeeded' && s.verified)
      ? { ...base, action: 'review', reason: 'A later step of this operation changed the same target and was verified, so this step was superseded and is not repeated.' }
      : { ...base, action: 'reread', reason: 'A later step of this operation changes the same target and is not verified. Read the object again; do not repeat this step.' };
  });
}

/** Which steps may be repeated and which may not. Pure; the retry itself (a new confirmed operation) is a later increment. */
export function analyzeOperation(op: OperationRecord): OperationAnalysis {
  const advice = applySuperseded(op, op.steps.map((s) => adviceFor(op, s)));
  const retryCandidates: RetryCandidate[] = [];
  const notRetryable: NotRetryable[] = [];
  for (const [position, step] of op.steps.entries()) {
    const a = advice[position];
    if (!a || a.action === 'none' || a.action === 'inProgress') continue;
    const retryable = a.action === 'retry' || a.action === 'rereadThenRetry';
    if (retryable && !isIdempotent(step.kind)) {
      notRetryable.push({ stepKey: step.key, index: step.index, reason: 'This kind of change is not safe to repeat.' });
    } else if (retryable) {
      retryCandidates.push({
        stepKey: step.key,
        index: step.index,
        kind: step.kind,
        description: step.description,
        environmentId: op.environmentId,
        requiresRereadFirst: a.action === 'rereadThenRetry',
        reason: a.reason,
      });
    } else {
      notRetryable.push({ stepKey: step.key, index: step.index, reason: a.reason });
    }
  }
  return {
    status: deriveStatus(op),
    advice,
    retryCandidates,
    notRetryable,
    recovery: {
      available: false,
      reason:
        'Recovery needs a verified compensating operation and the state from before the change. This record has no before state, so none is offered.',
    },
    rollbackStatement: NO_AUTOMATIC_ROLLBACK,
  };
}
