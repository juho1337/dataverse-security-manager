import type { Role, RoleGrant, UserAccess } from '../../domain/buMove/types';
import { createWritePlan, normalizeId, plannedWrite, type PlannedWrite, type WritePlan } from '../../domain/operations';

// Planner of direct role assignment and removal for one user (issue #270). Pure: it decides from a user's access (as read) and the roles on
// offer, never from assumptions, and never sends anything. Idempotent: a role the user already holds directly is "already assigned" and a
// role they do not hold directly is "not assigned"; neither produces a write. A role can only be assigned to a user of the Business Unit the
// role belongs to (roles are Business-Unit-specific instances), so a role from another unit is refused, naming the right instance when known.

export type AssignmentAction = 'assign' | 'unassign';

export interface AssignmentRequest {
  readonly action: AssignmentAction;
  readonly roleId: string;
}

export type PlanItemStatus = 'planned' | 'alreadyAssigned' | 'notAssigned' | 'refused';

export interface PlanItem {
  readonly action: AssignmentAction;
  readonly roleId: string;
  readonly roleName: string;
  readonly businessUnitName: string;
  readonly status: PlanItemStatus;
  /** Plain language: why this item is, or is not, going to be written. */
  readonly reason: string;
  /** The user also holds this role through a team (a direct assignment is separate from that). */
  readonly alsoViaTeam: boolean;
  readonly write?: PlannedWrite;
}

export interface AssignmentPlan {
  readonly userId: string;
  readonly userName: string;
  readonly items: readonly PlanItem[];
  /** Null when nothing needs to be written. */
  readonly plan: WritePlan | null;
  /** Things to read before confirming (not blockers). */
  readonly warnings: readonly string[];
}

export interface PlanInput {
  readonly access: UserAccess;
  /** The roles that may be offered for assignment (the user's Business Unit). Roles the user already holds are known from `access`. */
  readonly catalog: readonly Role[];
  readonly requests: readonly AssignmentRequest[];
}

export function planAssignments(input: PlanInput): AssignmentPlan {
  const { access, catalog, requests } = input;
  const userId = normalizeId(access.user.id);
  const direct = new Map<string, RoleGrant>(access.directRoles.map((g) => [normalizeId(g.role.id), g]));
  const viaTeam = new Set(access.teamRoles.map((g) => normalizeId(g.role.id)));
  const known = new Map<string, Role>();
  for (const r of catalog) known.set(normalizeId(r.id), r);
  for (const g of [...access.directRoles, ...access.teamRoles]) known.set(normalizeId(g.role.id), g.role);
  const userBu = normalizeId(access.user.businessUnitId);
  const buName = (role: Role | undefined): string => {
    if (!role) return 'an unknown business unit';
    const g = direct.get(normalizeId(role.id));
    if (g) return g.roleBusinessUnitName;
    return normalizeId(role.businessUnitId) === userBu ? access.businessUnitName : 'another business unit';
  };

  // One entry per role; the same request twice is one, opposite requests for the same role conflict and neither is sent.
  const byRole = new Map<string, AssignmentAction[]>();
  for (const r of requests) {
    const id = normalizeId(r.roleId);
    const list = byRole.get(id) ?? [];
    if (!list.includes(r.action)) list.push(r.action);
    byRole.set(id, list);
  }

  const items: PlanItem[] = [];
  for (const [roleId, actions] of byRole) {
    const role = known.get(roleId);
    const base = { roleId, roleName: role?.name ?? '(unknown role)', businessUnitName: buName(role), alsoViaTeam: viaTeam.has(roleId) };
    const refuse = (action: AssignmentAction, reason: string): PlanItem => ({ ...base, action, status: 'refused', reason });
    if (actions.length > 1) {
      items.push(refuse('assign', 'Both adding and removing this role were requested; neither is sent. Choose one.'));
      continue;
    }
    const action = actions[0] as AssignmentAction;
    if (!access.isComplete) {
      items.push(refuse(action, 'The user’s access could not be read completely, so it is not safe to tell whether this role is already assigned. Reload and try again.'));
      continue;
    }
    if (action === 'assign') {
      if (!role) items.push(refuse(action, 'This role is not in the list of roles that can be assigned to this user.'));
      else if (access.user.isDisabled) items.push(refuse(action, 'The user is disabled; roles are not assigned to disabled users.'));
      else if (direct.has(roleId)) items.push({ ...base, action, status: 'alreadyAssigned', reason: 'The user already holds this role directly. Nothing is sent.' });
      else if (normalizeId(role.businessUnitId) !== userBu) {
        const right = role.parentRootRoleId
          ? catalog.find((c) => normalizeId(c.businessUnitId) === userBu && (c.parentRootRoleId ?? c.id) === role.parentRootRoleId)
          : undefined;
        items.push(refuse(action, `A role can only be assigned to users of the business unit it belongs to (${access.businessUnitName}).${right ? ` Use the copy of "${right.name}" in ${access.businessUnitName} instead.` : ''}`));
      } else {
        const write = plannedWrite.assignRole(userId, roleId, `Assign role "${role.name}" (${access.businessUnitName}) to ${access.user.fullName}`);
        items.push({ ...base, action, status: 'planned', reason: base.alsoViaTeam ? 'Assigned directly; the user also holds this role through a team.' : 'Will be assigned directly.', write });
      }
    } else if (!direct.has(roleId)) {
      items.push({
        ...base,
        action,
        status: 'notAssigned',
        reason: base.alsoViaTeam ? 'This role comes through a team, not directly. Removing a team-derived role is not done here. Nothing is sent.' : 'The user does not hold this role directly. Nothing is sent.',
      });
    } else {
      const write = plannedWrite.unassignRole(userId, roleId, `Remove role "${base.roleName}" (${base.businessUnitName}) from ${access.user.fullName}`);
      items.push({ ...base, action, status: 'planned', reason: base.alsoViaTeam ? 'Removed directly; the user keeps this role through a team.' : 'Will be removed.', write });
    }
  }

  // Additions first, then removals, so a replacement never leaves a gap.
  const planned = items.filter((i) => i.status === 'planned' && i.write);
  const ordered = [...planned.filter((i) => i.action === 'assign'), ...planned.filter((i) => i.action === 'unassign')];
  const rest = items.filter((i) => !(i.status === 'planned' && i.write));
  const writes = ordered.map((i) => i.write as PlannedWrite);

  const warnings: string[] = [];
  const removals = ordered.filter((i) => i.action === 'unassign');
  if (removals.length > 0) {
    warnings.push('Removing a role removes the privileges it gave, unless another role or a team also gives them.');
    const remaining = access.directRoles.length - removals.length + ordered.filter((i) => i.action === 'assign').length;
    if (remaining <= 0 && access.teamRoles.length === 0) warnings.push('After this the user would hold no roles at all and could not use the environment.');
  }
  return { userId, userName: access.user.fullName, items: [...ordered, ...rest], plan: writes.length > 0 ? createWritePlan(writes) : null, warnings };
}
