import type { ApprovedPlan, FailureClass, OperationResult, Outcome } from '../../domain/operations';
import { normalizeId } from '../../domain/operations';
import type { BuMovePlan, UserMovePlan } from '../../domain/buMove/types';
import type { SecurityDataWriter } from '../../ports/securityDataWriter';
import type { ReadUserState, UserState } from './ports';
import { writesForPlan } from './writePlan';

// Executes a CONFIRMED Business Unit move (issue #273). Port of the XrmToolBox BuMoveExecutor behaviour:
//  - the plan must be exactly the confirmed plan, otherwise nothing is sent;
//  - each user is read first (a step that is already satisfied is not sent again: no duplicate assignment, no second move);
//  - an accepted request is never success: the move is `succeeded` only when a fresh read shows the target Business Unit, and each role
//    assignment only when a fresh read lists the role;
//  - roles are restored only after the move is confirmed, and only what the confirmed plan lists;
//  - a failed step stops that user; an uncertain step, a lost connection or a failed identity check stops the whole run (nothing after it is
//    sent until it is reconciled by a read).
// The only write path is the SecurityDataWriter port (confirmation, fresh identity check and exact request are checked by the boundary).

export interface StepResult {
  readonly key: string;
  readonly kind: 'moveUser' | 'assignRole';
  readonly description: string;
  readonly roleId?: string;
  readonly outcome: Outcome;
  readonly message: string;
  readonly failure: FailureClass;
  /** Whether a request was actually sent for this step (false when it was already satisfied or not attempted). */
  readonly sent: boolean;
}

export interface UserMoveResult {
  readonly userId: string;
  readonly userName: string;
  readonly steps: readonly StepResult[];
  readonly overall: Outcome;
  /** Business Unit and roles seen by the first and the last read; null when no read succeeded. */
  readonly before: UserState | null;
  readonly after: UserState | null;
  /** Direct roles the user held before and no longer holds after, which the confirmed plan did not remove. Informational, from reads. */
  readonly rolesLost: readonly string[];
}

export interface BuMoveResult {
  readonly operationId: string;
  readonly planHash: string;
  readonly environmentId: string;
  readonly targetBusinessUnitId: string;
  readonly targetBusinessUnitName: string;
  readonly users: readonly UserMoveResult[];
  readonly overall: Outcome;
  /** Why the run stopped before every user was processed; null when it ran through. */
  readonly stoppedReason: string | null;
  readonly startedAtMs: number;
  readonly endedAtMs: number;
}

export interface ExecuteBuMoveOptions {
  readonly plan: BuMovePlan;
  readonly approval: ApprovedPlan;
  readonly writer: SecurityDataWriter;
  readonly readState: ReadUserState;
  /** A retry: only these step keys are sent (the confirmed plan lists exactly them). */
  readonly only?: ReadonlySet<string>;
  readonly now?: () => number;
  readonly isCancelled?: () => boolean;
  readonly onProgress?: (text: string) => void;
  /** When set nothing is sent and every user is reported as not attempted with this reason (for example: the history could not be written). */
  readonly abortReason?: string;
}

/** A failed write with one of these classes means the next write would fail too: the whole run stops. */
const STOPPING: readonly FailureClass[] = ['identity', 'connection', 'timeout'];

export function overallOf(steps: readonly { readonly outcome: Outcome }[]): Outcome {
  if (steps.length === 0) return 'skipped';
  if (steps.every((s) => s.outcome === 'succeeded')) return 'succeeded';
  if (steps.every((s) => s.outcome === 'skipped')) return 'skipped';
  if (steps.every((s) => s.outcome === 'failed' || s.outcome === 'skipped')) return 'failed';
  if (steps.every((s) => s.outcome === 'succeeded' || s.outcome === 'notVerified')) return 'notVerified';
  if (steps.some((s) => s.outcome === 'uncertain')) return 'uncertain';
  return 'partiallyApplied';
}

const UNEXPECTED: OperationResult = {
  outcome: 'uncertain',
  message: 'The write ended with an unexpected error; whether it was applied is not known until it is read again.',
  failure: 'execution',
};

/** A refusal before dispatch (the write boundary said no) sent nothing; any other result means a request left. */
const wasSent = (w: OperationResult): boolean => w.dispatched !== false;

async function send(call: () => Promise<OperationResult>): Promise<OperationResult> {
  try {
    return await call();
  } catch {
    return UNEXPECTED; // the port promises results, not exceptions
  }
}

const skipped = (key: string, kind: StepResult['kind'], description: string, message: string, roleId?: string): StepResult => ({
  key, kind, description, outcome: 'skipped', message, failure: 'none', sent: false, ...(roleId ? { roleId } : {}),
});

function lostRoles(before: UserState | null, after: UserState | null, planned: ReadonlySet<string>): string[] {
  if (!before || !after || !after.rolesComplete) return [];
  const now = new Set(after.directRoleIds);
  return before.directRoleIds.filter((r) => !now.has(r) && !planned.has(r));
}

/**
 * A complete read that no longer lists a role (or the target business unit) an EARLIER step verified contradicts that success (a plug-in or
 * another administrator changed it): the step becomes failed, so the overall result is not success and the result UI offers reconciliation.
 */
function invalidateContradicted(steps: StepResult[], state: UserState, target: string): void {
  if (!state.rolesComplete) return; // an incomplete read proves nothing
  steps.forEach((s, i) => {
    // The move is revalidated too: a later complete read that shows the user outside the target business unit contradicts it.
    if (s.kind === 'moveUser' && s.outcome === 'succeeded' && state.businessUnitId !== target) {
      steps[i] = { ...s, outcome: 'failed', message: 'A later complete read no longer shows the user in the target business unit.' };
    }
    if (s.kind === 'assignRole' && s.outcome === 'succeeded' && s.roleId && !state.directRoleIds.includes(normalizeId(s.roleId))) {
      steps[i] = { ...s, outcome: 'failed', message: 'A later complete read no longer lists the role.' };
    }
  });
}

interface AssignStep {
  readonly key: string;
  readonly roleId: string;
  readonly description: string;
}

interface UserRun {
  readonly result: UserMoveResult;
  /** Set when the whole run must stop after this user. */
  readonly stop: string | null;
}

async function runUser(user: UserMovePlan, plan: BuMovePlan, o: ExecuteBuMoveOptions, assigns: readonly AssignStep[]): Promise<UserRun> {
  const { approval, writer, readState } = o;
  const target = normalizeId(plan.targetBusinessUnitId);
  const moveKey = `moveUser:${normalizeId(user.user.id)}:${target}`;
  const moveDesc = `Move ${user.user.fullName} to ${plan.targetBusinessUnitName}`;
  const steps: StepResult[] = [];

  // A retry of roles only has no move step: the user is already in the target (checked by the read below).
  const withMove = o.only === undefined || o.only.has(moveKey);

  const finish = (before: UserState | null, after: UserState | null, userNote: string, stop: string | null): UserRun => {
    const done = new Set(steps.map((s) => s.key));
    // Anything not reached is reported, never left out.
    if (withMove && !done.has(moveKey)) steps.push(skipped(moveKey, 'moveUser', moveDesc, userNote));
    for (const a of assigns) if (!done.has(a.key)) steps.push(skipped(a.key, 'assignRole', a.description, userNote, a.roleId));
    const planned = new Set(assigns.map((a) => a.roleId));
    return { result: { userId: user.user.id, userName: user.user.fullName, steps, overall: overallOf(steps), before, after, rolesLost: lostRoles(before, after, planned) }, stop };
  };

  o.onProgress?.(`Reading ${user.user.fullName}`);
  const before = await readState(user.user.id);
  if (!before) {
    const note = 'The current state of this user could not be read, so nothing was sent for them. The run was stopped.';
    return finish(null, null, note, note);
  }

  // ---- move
  let after: UserState = before;
  if (!withMove) {
    if (before.businessUnitId !== target) {
      const note = 'This user is not in the target business unit, so their roles were not assigned. Reconcile and plan the move again.';
      return finish(before, before, note, null);
    }
  } else if (before.businessUnitId === target) {
    steps.push({ key: moveKey, kind: 'moveUser', description: moveDesc, outcome: 'succeeded', message: 'Already in the target business unit when read; nothing was sent.', failure: 'none', sent: false });
  } else {
    if (o.isCancelled?.()) return finish(before, before, 'Cancelled before this user was moved.', 'Cancelled.');
    o.onProgress?.(`Moving ${user.user.fullName}`);
    const w = await send(() => writer.moveUser(approval, user.user.id, plan.targetBusinessUnitId));
    if (w.outcome === 'failed') {
      steps.push({ key: moveKey, kind: 'moveUser', description: moveDesc, outcome: 'failed', message: w.message, failure: w.failure, sent: wasSent(w) });
      const stop = STOPPING.includes(w.failure) ? `${w.message} The run was stopped.` : null;
      return finish(before, before, 'The move failed; roles were not restored.', stop);
    }
    const read = await readState(user.user.id);
    if (!read) {
      steps.push({ key: moveKey, kind: 'moveUser', description: moveDesc, outcome: w.outcome === 'uncertain' ? 'uncertain' : 'notVerified', message: `${w.message} Not verified: the user could not be read again.`, failure: w.failure, sent: true });
      const stop = 'The move could not be confirmed by a read; the run was stopped. Reconcile before doing anything else.';
      return finish(before, null, stop, stop);
    }
    after = read;
    if (after.businessUnitId === target) {
      steps.push({ key: moveKey, kind: 'moveUser', description: moveDesc, outcome: 'succeeded', message: 'Confirmed by a re-read: the user is in the target business unit.', failure: 'none', sent: true });
    } else {
      const uncertain = w.outcome === 'uncertain';
      steps.push({
        key: moveKey, kind: 'moveUser', description: moveDesc, outcome: uncertain ? 'uncertain' : 'failed', failure: w.failure, sent: true,
        message: uncertain ? `${w.message} The re-read does not show the target business unit yet.` : 'The request was accepted but the re-read does not show the target business unit.',
      });
      const stop = uncertain ? 'The move has an uncertain result; the run was stopped. Reconcile by reading the user again.' : null;
      return finish(before, after, 'The move is not confirmed; roles were not restored.', stop);
    }
  }

  // ---- restore roles (only after the move is confirmed)
  for (const a of assigns) {
    if (o.isCancelled?.()) return finish(before, after, 'Cancelled before this role was assigned.', 'Cancelled.');
    if (after.directRoleIds.includes(a.roleId)) {
      steps.push({ key: a.key, kind: 'assignRole', description: a.description, roleId: a.roleId, outcome: 'succeeded', message: 'The user already holds this role when read; nothing was sent (no duplicate assignment).', failure: 'none', sent: false });
      continue;
    }
    o.onProgress?.(`Assigning a role to ${user.user.fullName}`);
    const w = await send(() => writer.assignRole(approval, user.user.id, a.roleId));
    if (w.outcome === 'failed') {
      steps.push({ key: a.key, kind: 'assignRole', description: a.description, roleId: a.roleId, outcome: 'failed', message: w.message, failure: w.failure, sent: wasSent(w) });
      const stop = STOPPING.includes(w.failure) ? `${w.message} The run was stopped.` : null;
      return finish(before, after, 'A role assignment failed; the remaining roles of this user were not assigned.', stop);
    }
    const read = await readState(user.user.id);
    if (!read) {
      steps.push({ key: a.key, kind: 'assignRole', description: a.description, roleId: a.roleId, outcome: w.outcome === 'uncertain' ? 'uncertain' : 'notVerified', message: `${w.message} Not verified: the user could not be read again.`, failure: w.failure, sent: true });
      const stop = 'A role assignment could not be confirmed by a read; the run was stopped. Reconcile before doing anything else.';
      return finish(before, after, stop, stop);
    }
    after = read;
    invalidateContradicted(steps, after, target);
    if (after.directRoleIds.includes(a.roleId)) {
      steps.push({ key: a.key, kind: 'assignRole', description: a.description, roleId: a.roleId, outcome: 'succeeded', message: 'Confirmed by a re-read: the user holds the role.', failure: 'none', sent: true });
      continue;
    }
    // Not listed: a proven absence only when the role list is complete and the write was not uncertain.
    const uncertain = w.outcome === 'uncertain';
    const unproven = !after.rolesComplete;
    steps.push({
      key: a.key, kind: 'assignRole', description: a.description, roleId: a.roleId, failure: w.failure, sent: true,
      outcome: uncertain ? 'uncertain' : unproven ? 'notVerified' : 'failed',
      message: uncertain || unproven ? `${w.message} The re-read does not list the role, but its result may be incomplete.` : 'The request was accepted but the re-read does not list the role.',
    });
    if (uncertain || unproven) {
      // Neither applied nor proven absent: nothing further is sent until a read settles it.
      const stop = `A role assignment ${uncertain ? 'has an uncertain result' : 'could not be verified by a complete read'}; the run was stopped. Reconcile by reading the user again.`;
      return finish(before, after, stop, stop);
    }
    // A definitively failed assignment: the remaining steps of this user are not sent (they are reported as not attempted).
    return finish(before, after, 'A role assignment failed; the remaining roles of this user were not assigned.', null);
  }
  return finish(before, after, 'Not attempted.', null);
}

export async function executeBuMove(o: ExecuteBuMoveOptions): Promise<BuMoveResult> {
  const { plan, approval } = o;
  const now = o.now ?? Date.now;
  const startedAtMs = now();
  const writes = writesForPlan(plan, o.only);
  const base = {
    operationId: approval.operationId,
    planHash: approval.planHash,
    environmentId: approval.environmentId,
    targetBusinessUnitId: plan.targetBusinessUnitId,
    targetBusinessUnitName: plan.targetBusinessUnitName,
    startedAtMs,
  };
  const moveKeyOf = (u: UserMovePlan) => `moveUser:${normalizeId(u.user.id)}:${normalizeId(plan.targetBusinessUnitId)}`;
  // A user the run did not reach keeps ALL their planned writes as not-attempted steps (every assignment; a move only when the plan has one),
  // so reconciliation and a retry still cover every outstanding step.
  const notReached = (u: UserMovePlan, reason: string): UserMoveResult => {
    const uid = normalizeId(u.user.id);
    const planned = writes.plan?.writes.filter((w): w is Extract<typeof w, { kind: 'assignRole' | 'moveUser' }> => (w.kind === 'assignRole' || w.kind === 'moveUser') && normalizeId(w.userId) === uid) ?? [];
    const steps: StepResult[] = planned.length > 0
      ? planned.map((w) => skipped(w.key, w.kind === 'assignRole' ? 'assignRole' : 'moveUser', w.description, reason, w.kind === 'assignRole' ? w.roleId : undefined))
      : [skipped(moveKeyOf(u), 'moveUser', `Move ${u.user.fullName}`, reason)];
    return { userId: u.user.id, userName: u.user.fullName, steps, overall: 'skipped', before: null, after: null, rolesLost: [] };
  };

  if (o.abortReason) {
    return { ...base, users: writes.included.map((u) => notReached(u, o.abortReason ?? '')), overall: 'failed', stoppedReason: o.abortReason, endedAtMs: now() };
  }
  // The plan being applied must be exactly the confirmed one; writing part of it could leave a user moved without their roles.
  if (!writes.plan || writes.plan.hash !== approval.planHash) {
    const reason = 'The plan no longer matches the plan you confirmed. Nothing was sent; review and confirm again.';
    return { ...base, users: writes.included.map((u) => notReached(u, reason)), overall: 'failed', stoppedReason: reason, endedAtMs: now() };
  }

  const results: UserMoveResult[] = [];
  let stoppedReason: string | null = null;
  for (const user of writes.included) {
    if (stoppedReason) break;
    const uid = normalizeId(user.user.id);
    const assigns: AssignStep[] = writes.plan.writes
      .filter((w): w is Extract<typeof w, { kind: 'assignRole' }> => w.kind === 'assignRole' && w.userId === uid)
      .map((w) => ({ key: w.key, roleId: w.roleId, description: w.description }));
    const run = await runUser(user, plan, o, assigns);
    results.push(run.result);
    stoppedReason = run.stop;
  }
  // Users the run never reached are listed as not attempted, so the report accounts for everyone in the plan.
  const reached = new Set(results.map((r) => r.userId));
  for (const u of writes.included) if (!reached.has(u.user.id)) results.push(notReached(u, stoppedReason ?? 'Not attempted.'));
  return { ...base, users: results, overall: overallOf(results.map((r) => ({ outcome: r.overall }))), stoppedReason, endedAtMs: now() };
}
