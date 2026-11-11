import type { Role, TeamType, UserAccess, UserSummary } from '../domain/buMove/types';
import type { RoleGrantsData } from '../domain/tablePrivileges';
import type { ReadResult } from './securityDataReader';

// Read-only port of the Access Explorer (issue #269). There are deliberately no write methods; assignment changes get their own port.
// A `partial` result is usable but incomplete: the UI must say so and never read a gap as "no access".

export type { ReadResult } from './securityDataReader';

/** A user found by a search. `businessUnitName` is null when the business unit could not be read. */
export interface UserHit {
  readonly user: UserSummary;
  readonly businessUnitName: string | null;
}

export interface TeamSummary {
  readonly id: string;
  readonly name: string;
  readonly type: TeamType;
  readonly businessUnitId: string;
  readonly businessUnitName: string | null;
}

/** The members and roles of one team. Access teams carry no roles (`roles` is then empty by definition, not by a gap). */
export interface TeamAccess {
  readonly team: TeamSummary;
  readonly roles: readonly { readonly role: Role; readonly businessUnitName: string | null }[];
  readonly members: readonly UserHit[];
  /** Team size is capped; true when more members exist than are listed. */
  readonly membersTruncated: boolean;
  /** False when the team's ROLES were not read completely (a failed role query or an unresolved role). A truncated member list does not count. Absent = complete. */
  readonly rolesComplete?: boolean;
  /** What is missing about the roles when `rolesComplete` is false. */
  readonly roleGaps?: readonly string[];
}

/** A role instance whose grants are wanted, with its root role (null for a root): a Business Unit copy stores no privileges, it has its root's. */
export interface RoleRef {
  readonly id: string;
  readonly rootId: string | null;
}

/** Ids whose display names are wanted (a restore preview names the roles and users instead of showing GUIDs). */
export interface NameRequest {
  readonly users?: readonly string[];
  readonly roles?: readonly string[];
}

/** Display names by lower-case id. An id that could not be read is simply absent. Names are shown, never stored in the history. */
export interface ResolvedNames {
  readonly users: ReadonlyMap<string, string>;
  readonly roles: ReadonlyMap<string, string>;
}

export interface AccessReader {
  /** Users whose name or email contains `query` (disabled and application users included). Results are capped; a cap is reported as partial. */
  searchUsers(query: string): Promise<ReadResult<readonly UserHit[]>>;
  /** Teams whose name contains `query`. */
  searchTeams(query: string): Promise<ReadResult<readonly TeamSummary[]>>;
  /** Direct and team-derived roles of one user with their origin, composed by the domain explainer. Gaps are reported in `warnings`/`partial`. */
  loadUserAccess(userId: string): Promise<ReadResult<UserAccess>>;
  /** Roles and (capped) members of one team. */
  loadTeamAccess(teamId: string): Promise<ReadResult<TeamAccess>>;
  /** The role records of one Business Unit (a role can only be assigned to users of the Business Unit it belongs to). Capped; a cap is reported as partial. */
  listRolesOfBusinessUnit?(businessUnitId: string): Promise<ReadResult<readonly Role[]>>;
  /**
   * The explicit table privileges of the given role instances (every table and operation, with the depth), the privilege catalog that says which
   * operations exist for which table, and the table display names. A gap is reported as `partial`, never as "no grants". Optional: a reader
   * without it has no table privilege analysis.
   */
  loadRoleGrants?(roles: readonly RoleRef[]): Promise<ReadResult<RoleGrantsData>>;
  /** Display names of users and roles by id (at most 50 ids per kind per call). Read only. Optional: without it ids are shown shortened. */
  resolveNames?(request: NameRequest): Promise<ReadResult<ResolvedNames>>;
}

/** Search results are capped at this many rows per kind; one more is requested to detect the cap. */
export const SEARCH_LIMIT = 50;
export const TEAM_MEMBER_LIMIT = 100;
/** Roles listed for one Business Unit are capped at this many. */
export const ROLE_LIST_LIMIT = 500;
