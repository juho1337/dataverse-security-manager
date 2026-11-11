import type { CellValue, DepthId } from '../../domain/privileges';
import type { HeldDepth } from '../../domain/roleEditing';
import type { PrivilegeDepthState, RoleHeldState, UserPlacementState } from '../../domain/history/types';
import type { UserState } from '../buManager/ports';
import { normalizeId } from '../../domain/operations';

// Builders for the minimal states the write paths record (before: read before the write; after: from the verifying re-read). Nothing here
// reads anything; the callers pass what they actually read.

/** The depth a cell or a held depth stands for; `None` when the privilege is not held. */
export function canonicalDepth(value: CellValue | HeldDepth): DepthId {
  if (value === null) return 'None';
  if (typeof value === 'string') return value;
  return value.kind === 'depth' ? value.depth : 'None';
}

export function roleHeldState(userId: string, roleId: string, held: boolean): RoleHeldState {
  return { kind: 'roleHeld', userId: normalizeId(userId), roleId: normalizeId(roleId), held };
}

/** The user's placement from a read; the role list is recorded only when that read was complete. */
export function placementState(userId: string, state: UserState): UserPlacementState {
  return {
    kind: 'userPlacement',
    userId: normalizeId(userId),
    businessUnitId: normalizeId(state.businessUnitId),
    roleIds: state.rolesComplete ? state.directRoleIds.map(normalizeId) : null,
  };
}

export type { PrivilegeDepthState };
