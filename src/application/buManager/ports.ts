import type { BusinessUnit, RolePrivilege, SecuritySnapshot } from '../../domain/buMove/types';
import type { AccessReader, UserHit } from '../../ports/accessReader';
import type { ReadResult } from '../../ports/securityDataReader';

// Read-only port of the BU Manager (issues #271, #273). Search and per-user access reuse the Access Explorer port (so the same host guard,
// identity check and paging apply); the BU-specific reads are added here. There are deliberately no write methods: writes go through
// the SecurityDataWriter behind the write boundary, only with a confirmed plan.

/** Everything the pure planner needs for the selected users and one target business unit. */
export interface PlanningData {
  readonly snapshot: SecuritySnapshot;
  readonly privileges: readonly RolePrivilege[];
  /** False when privilege rows could not be read completely: matches are then compared on incomplete data and need confirmation. */
  readonly privilegesComplete: boolean;
}

export interface BuManagerReader extends Pick<AccessReader, 'searchUsers' | 'loadUserAccess'> {
  /** Every business unit with its parent and enabled state. A partial result still lists what was read; a gap is never "no business unit". */
  listBusinessUnits(): Promise<ReadResult<readonly BusinessUnit[]>>;
  /** Users whose primary email equals one of the addresses (case-insensitive). Used to resolve an imported list. */
  findUsersByEmail(emails: readonly string[]): Promise<ReadResult<readonly UserHit[]>>;
  /** A fresh read of the data the planner needs for these users and this target (always read again, never cached across plans). */
  loadPlanningData(userIds: readonly string[], targetBusinessUnitId: string, extraRoleIds?: readonly string[]): Promise<ReadResult<PlanningData>>;
  // `extraRoleIds`: roles a person chose freely (custom strategy). Their privileges are read too, so the comparison never treats an unread role as one without privileges.
}

/** What a fresh read says about one user: used to verify a move and every role assignment. */
export interface UserState {
  readonly businessUnitId: string;
  readonly directRoleIds: readonly string[];
  /** False when the role list may be incomplete: a role that is not listed is then not proof that it is absent. */
  readonly rolesComplete: boolean;
}

/** Fresh read of one user's Business Unit and direct roles; null when it could not be read. */
export type ReadUserState = (userId: string) => Promise<UserState | null>;

export function userStateReader(reader: Pick<AccessReader, 'loadUserAccess'>): ReadUserState {
  return async (userId) => {
    try {
      const r = await reader.loadUserAccess(userId);
      if (r.status === 'error') return null;
      const businessUnitId = r.data.user.businessUnitId.toLowerCase();
      if (businessUnitId === '') return null;
      return { businessUnitId, directRoleIds: r.data.directRoles.map((g) => g.role.id.toLowerCase()), rolesComplete: r.status === 'ok' };
    } catch {
      return null;
    }
  };
}
