import type { FailureClass } from '../../domain/operations';
import { normalizeId } from '../../domain/operations';
import type { BuMoveResult, StepResult, UserMoveResult } from './execute';
import { overallOf } from './execute';
import type { ReadUserState, UserState } from './ports';

// Reconciliation and safe-retry candidates of a finished BU move (issue #273; XrmToolBox BuRetryPlanner behaviour). A result that is not
// fully verified (failed, partial, not verified, uncertain, not attempted) is settled by READING each user again: a step is then
// `succeeded` only because the read shows the wanted state, and a step is a retry candidate only when the read PROVES it is not applied.
// Nothing here writes. A retry is a new plan and a new confirmation: the candidates only say which users to plan again.

export interface RetryCandidate {
  readonly userId: string;
  readonly userName: string;
  /** Steps whose wanted state is proven absent by the read. */
  readonly steps: readonly StepResult[];
  /** The earlier failure repeats unless its cause is fixed first (permission, validation, identity). */
  readonly fixCauseFirst: boolean;
  readonly note: string;
}

export interface Reconciliation {
  readonly result: BuMoveResult;
  readonly retry: readonly RetryCandidate[];
  /** Users that could not be read again; nothing is concluded for them. */
  readonly unread: readonly string[];
}

const NEEDS_FIX: readonly FailureClass[] = ['permission', 'validation', 'identity'];

function settle(step: StepResult, state: UserState, target: string): { readonly step: StepResult; readonly proven: 'present' | 'absent' | 'unknown' } {
  if (step.kind === 'moveUser') {
    if (state.businessUnitId === target) {
      return { step: step.outcome === 'succeeded' ? step : { ...step, outcome: 'succeeded', message: 'Confirmed by a later read: the user is in the target business unit.' }, proven: 'present' };
    }
    return { step: step.outcome === 'succeeded' ? { ...step, outcome: 'failed', message: 'A later read no longer shows the user in the target business unit.' } : step.outcome === 'uncertain' || step.outcome === 'notVerified' ? { ...step, outcome: 'failed', message: 'A later read shows the move was not applied.' } : step, proven: 'absent' };
  }
  const roleId = step.roleId ? normalizeId(step.roleId) : '';
  if (state.directRoleIds.includes(roleId)) {
    return { step: step.outcome === 'succeeded' ? step : { ...step, outcome: 'succeeded', message: 'Confirmed by a later read: the user holds the role.' }, proven: 'present' };
  }
  if (!state.rolesComplete) return { step, proven: 'unknown' }; // an incomplete role list does not prove a role is absent
  if (step.outcome === 'succeeded') return { step: { ...step, outcome: 'failed', message: 'A later complete read no longer lists the role.' }, proven: 'absent' };
  return { step: step.outcome === 'uncertain' || step.outcome === 'notVerified' ? { ...step, outcome: 'failed', message: 'A later read shows the role was not assigned.' } : step, proven: 'absent' };
}

export async function reconcileResult(result: BuMoveResult, readState: ReadUserState): Promise<Reconciliation> {
  const target = normalizeId(result.targetBusinessUnitId);
  const users: UserMoveResult[] = [];
  const retry: RetryCandidate[] = [];
  const unread: string[] = [];
  for (const u of result.users) {
    if (u.overall === 'succeeded') {
      users.push(u);
      continue;
    }
    const state = await readState(u.userId).catch(() => null);
    if (!state) {
      unread.push(u.userName);
      users.push(u);
      continue;
    }
    const steps: StepResult[] = [];
    const absent: StepResult[] = [];
    for (const s of u.steps) {
      const r = settle(s, state, target);
      steps.push(r.step);
      if (r.proven === 'absent') absent.push(r.step);
    }
    users.push({ ...u, steps, after: state, overall: overallOf(steps) });
    if (absent.length > 0) {
      const fix = absent.some((s) => NEEDS_FIX.includes(s.failure));
      retry.push({
        userId: u.userId,
        userName: u.userName,
        steps: absent,
        fixCauseFirst: fix,
        note: fix ? 'The earlier failure will repeat unless its cause is fixed first.' : 'A read shows these steps are not applied; planning them again is safe.',
      });
    }
  }
  return { result: { ...result, users, overall: overallOf(users.map((x) => ({ outcome: x.overall }))) }, retry, unread };
}
