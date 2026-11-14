import type { BusinessUnit, Role, Tri, UserAccess } from '../../domain/buMove/types';
import type { AccessReader } from '../../ports/accessReader';
import type { SecurityDataWriter } from '../../ports/securityDataWriter';
import type { OperationRecorder } from '../operations/recorder';
import { planAssignments, type AssignmentPlan, type PlanItem } from './planner';
import { confirmAndApplyAssignments, type AppliedAssignments } from './service';

// Bulk assignment: the same roles (concrete role records of ONE target Business Unit) for several users. It is only a loop over the
// single-user planner and apply service, so every rule (already assigned, disabled users, cross-unit gating, per-user approval, re-read
// verification, history entry) is the same as for one user. Nothing is sent for a user whose plan has no write.

export interface BulkPlanInput {
  /** One complete read of each selected user (the planner refuses a user whose access was read only in part). */
  readonly accesses: readonly UserAccess[];
  /** The role records of the target Business Unit (and any others the ids may refer to). */
  readonly catalog: readonly Role[];
  readonly businessUnits: readonly BusinessUnit[];
  readonly crossBuAssignment: Tri;
  /** Concrete roleids to assign. */
  readonly roleIds: readonly string[];
}

export interface BulkRow {
  readonly userId: string;
  readonly userName: string;
  readonly homeBusinessUnitName: string;
  readonly item: PlanItem;
}

export interface BulkPlan {
  readonly users: readonly AssignmentPlan[];
  /** One row per user and role: who, which role, which unit, and whether and why it is sent. */
  readonly rows: readonly BulkRow[];
  readonly writeCount: number;
  readonly warnings: readonly string[];
}

export function planBulkAssignments(input: BulkPlanInput): BulkPlan {
  const requests = input.roleIds.map((roleId) => ({ action: 'assign' as const, roleId }));
  const users: AssignmentPlan[] = [];
  const rows: BulkRow[] = [];
  const seen = new Set<string>();
  for (const access of input.accesses) {
    const key = access.user.id.toLowerCase();
    if (seen.has(key)) continue; // a user chosen twice is one user
    seen.add(key);
    const plan = planAssignments({ access, catalog: input.catalog, businessUnits: input.businessUnits, crossBuAssignment: input.crossBuAssignment, requests });
    users.push(plan);
    for (const item of plan.items) rows.push({ userId: plan.userId, userName: plan.userName, homeBusinessUnitName: access.businessUnitName, item });
  }
  const writeCount = users.reduce((n, u) => n + (u.plan?.writes.length ?? 0), 0);
  const warnings: string[] = [];
  if (writeCount > 0) warnings.push('Each user is approved, applied and verified on its own. If one user does not end verified, the remaining users are not attempted.');
  return { users, rows, writeCount, warnings };
}

export type BulkUserOutcome =
  | { readonly kind: 'applied'; readonly plan: AssignmentPlan; readonly applied: AppliedAssignments }
  | { readonly kind: 'nothingToWrite'; readonly plan: AssignmentPlan }
  /** The apply call itself threw: what was applied is not known until the user's roles are read again. */
  | { readonly kind: 'unknown'; readonly plan: AssignmentPlan }
  | { readonly kind: 'notAttempted'; readonly plan: AssignmentPlan };

export type AppliedStatus = 'verified' | 'alreadyInPlace' | 'notVerified';

/**
 * The outcome of one applied user from the FINAL state: roles that needed no change must still be held in the final read, and the apply result
 * must be fully verified (or an all-no-op result that is). `problems` names every assignment that is absent or could not be confirmed.
 */
export function summarizeApplied(result: AppliedAssignments['result']): { readonly status: AppliedStatus; readonly problems: readonly string[] } {
  const problems = result.items
    .filter((i) => i.noChange === true && i.heldAfter !== true)
    .map((i) => `${i.item.roleName} (${i.item.businessUnitName}) ${i.heldAfter === false ? 'was held before but is no longer held in the final read' : 'could not be confirmed in the final read'}.`);
  const allNoOp = result.items.every((i) => i.noChange === true);
  const ok = problems.length === 0 && (result.overall === 'succeeded' || (result.overall === 'skipped' && result.verified && allNoOp));
  return { status: !ok ? 'notVerified' : result.overall === 'skipped' ? 'alreadyInPlace' : 'verified', problems };
}

export interface BulkApplied {
  readonly outcomes: readonly BulkUserOutcome[];
  /** True only when every user with a write ended fully verified. */
  readonly allVerified: boolean;
}

export interface ConfirmedBulk {
  readonly plan: BulkPlan;
  readonly writer: SecurityDataWriter;
  readonly reader: Pick<AccessReader, 'loadUserAccess'>;
  readonly actor: string;
  readonly environmentId: string;
  readonly recorder?: OperationRecorder;
  readonly onProgress?: (text: string) => void;
}

/** Called ONLY after a person confirmed the bulk preview. Sequential; stops after the first user that does not end fully verified. */
export async function confirmAndApplyBulk(options: ConfirmedBulk): Promise<BulkApplied> {
  const outcomes: BulkUserOutcome[] = [];
  let stopped = false;
  let allVerified = true;
  for (const plan of options.plan.users) {
    if (!plan.plan) {
      outcomes.push({ kind: 'nothingToWrite', plan });
      continue;
    }
    if (stopped) {
      outcomes.push({ kind: 'notAttempted', plan });
      allVerified = false;
      continue;
    }
    options.onProgress?.(`Applying roles for ${plan.userName}…`);
    try {
      const applied = await confirmAndApplyAssignments({
        plan,
        writer: options.writer,
        reader: options.reader,
        actor: options.actor,
        environmentId: options.environmentId,
        ...(options.recorder ? { recorder: options.recorder } : {}),
      });
      if (!applied) {
        outcomes.push({ kind: 'nothingToWrite', plan });
        continue;
      }
      outcomes.push({ kind: 'applied', plan, applied });
      // A verified no-op (another administrator already assigned the roles between preview and confirmation) is a success for continuation, but only when the FINAL read still shows every requested role held (noChange describes the read before applying).
      // Judged from the final state, no-op items included (see summarizeApplied).
      if (summarizeApplied(applied.result).status === 'notVerified') {
        stopped = true;
        allVerified = false;
      }
    } catch {
      outcomes.push({ kind: 'unknown', plan });
      stopped = true;
      allVerified = false;
    }
  }
  return { outcomes, allVerified };
}
