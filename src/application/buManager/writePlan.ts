import { createWritePlan, plannedWrite, type PlannedWrite, type WritePlan } from '../../domain/operations';
import { hasBlockedRoles, type BuMovePlan, type UserMovePlan } from '../../domain/buMove/types';

// The writes a previewed BU move will send once confirmed (issue #273): per executable user, one `moveUser`, then one `assignRole` per role
// the plan restores. Roles that survive the move (`skipRetained`), team-derived roles and anything blocked are never written. Pure.

export interface ExcludedUser {
  readonly userId: string;
  readonly name: string;
  readonly reason: string;
}

export interface BuMoveWrites {
  /** Null when nothing can be sent. */
  readonly plan: WritePlan | null;
  readonly included: readonly UserMovePlan[];
  readonly excluded: readonly ExcludedUser[];
}

function exclusion(u: UserMovePlan): string | null {
  if (u.status === 'alreadyInTargetBusinessUnit') return 'Already in the target business unit.';
  if (u.status === 'disabled') return 'Disabled users are not moved.';
  if (u.status === 'unknownUser') return 'The user could not be found.';
  if (hasBlockedRoles(u)) return 'A role to restore is blocked (needs a choice or a confirmation). Resolve it in the preview.';
  return null;
}

/**
 * @param only A retry: restrict the writes to these step keys (steps a read proved are not applied). The plan is the original plan of the
 * move, so its decisions (which roles to restore) are the ones the person reviewed; the executor still reads each user first.
 */
export function writesForPlan(plan: BuMovePlan, only?: ReadonlySet<string>): BuMoveWrites {
  const writes: PlannedWrite[] = [];
  const included: UserMovePlan[] = [];
  const excluded: ExcludedUser[] = [];
  const seen = new Set<string>();
  for (const u of plan.users) {
    const reason = exclusion(u);
    if (reason !== null) {
      excluded.push({ userId: u.user.id, name: u.user.fullName, reason });
      continue;
    }
    const userWrites: PlannedWrite[] = [];
    const move = plannedWrite.moveUser(u.user.id, plan.targetBusinessUnitId, `Move ${u.user.fullName} to ${plan.targetBusinessUnitName}`);
    if (only === undefined || only.has(move.key)) userWrites.push(move);
    for (const d of u.decisions) {
      if (d.outcome !== 'restore' || d.chosen === null) continue;
      const assign = plannedWrite.assignRole(u.user.id, d.chosen.role.id, `Assign role ${d.chosen.role.name} (${d.chosen.businessUnitName}) to ${u.user.fullName}`);
      if (only !== undefined && !only.has(assign.key)) continue;
      userWrites.push(assign);
    }
    const fresh = userWrites.filter((w) => !seen.has(w.key)); // two source roles mapped to one target role: assigned once
    if (fresh.length === 0) continue;
    for (const w of fresh) seen.add(w.key);
    included.push(u);
    writes.push(...fresh);
  }
  return { plan: writes.length === 0 ? null : createWritePlan(writes), included, excluded };
}
