import type { GrantDepth } from '../operations';
import type { PrivilegeId } from '../privileges';

// Vocabulary of the Business Unit move planner (issue #272). A port of the XrmToolBox Core models (Models/*, BuMove/BuMoveModels).
// Pure data: roles are identified by id; names are display only. Lineage links Business Unit copies of one root role.

export interface BusinessUnit {
  readonly id: string;
  readonly name: string;
  readonly parentId: string | null;
  readonly isDisabled: boolean;
}

export interface Role {
  readonly id: string;
  readonly name: string;
  readonly businessUnitId: string;
  readonly parentRoleId: string | null;
  readonly parentRootRoleId: string | null;
  readonly isManaged: boolean;
}

/** One table privilege a role holds. Only table privileges are modelled; miscellaneous privileges are not read. */
export interface RolePrivilege {
  readonly roleId: string;
  readonly entity: string;
  readonly operation: PrivilegeId;
  readonly depth: GrantDepth;
}

export interface UserSummary {
  readonly id: string;
  readonly fullName: string;
  readonly email: string;
  readonly businessUnitId: string;
  readonly isDisabled: boolean;
  readonly isApplicationUser: boolean;
}

export type TeamType = 'Owner' | 'Access' | 'Default' | 'Other';

export interface Team {
  readonly id: string;
  readonly name: string;
  readonly businessUnitId: string;
  readonly type: TeamType;
  readonly roleIds: readonly string[];
}

export interface RoleAssignment {
  readonly userId: string;
  readonly roleId: string;
}

export interface TeamMembership {
  readonly userId: string;
  readonly teamId: string;
}

/** Tri-state: null = the setting could not be read. */
export type Tri = boolean | null;

export interface SecuritySettings {
  readonly enableOwnershipAcrossBusinessUnits: Tri;
  readonly doNotRemoveRolesOnChangeBusinessUnit: Tri;
  readonly alwaysMoveRecordToOwnerBusinessUnit: Tri;
  readonly notes: readonly string[];
}

/** A read of the environment's security data. `warnings` are data gaps (rows that could not be read). */
export interface SecuritySnapshot {
  readonly businessUnits: readonly BusinessUnit[];
  readonly roles: readonly Role[];
  readonly users: readonly UserSummary[];
  readonly teams: readonly Team[];
  readonly directAssignments: readonly RoleAssignment[];
  readonly memberships: readonly TeamMembership[];
  readonly settings: SecuritySettings;
  readonly warnings: readonly string[];
}

export type RoleOrigin = 'direct' | 'team';

export interface RoleGrant {
  readonly role: Role;
  readonly roleBusinessUnitName: string;
  readonly origin: RoleOrigin;
  readonly team: Team | null;
  readonly teamBusinessUnitName: string | null;
}

export interface UserAccess {
  readonly user: UserSummary;
  readonly businessUnitName: string;
  readonly directRoles: readonly RoleGrant[];
  readonly teamRoles: readonly RoleGrant[];
  readonly warnings: readonly string[];
  readonly isComplete: boolean;
}

// ---- request ------------------------------------------------------------------------------------------------------------

export type RestoreStrategy = 'none' | 'keep' | 'new' | 'root' | 'custom';

export type RoleSelection =
  /** No source role selected: nothing is restored (the preview still shows what is expected to be lost). The default. */
  | { readonly mode: 'none' }
  /** Every direct role the user holds now is a source role (never roles they did not hold). */
  | { readonly mode: 'allDirectRoles' }
  | { readonly mode: 'specific'; readonly roleIds: readonly string[] };

export interface RoleChoice {
  readonly sourceRoleId: string;
  /** Target role (required for custom and for an ambiguous match). */
  readonly chosenRoleId: string | null;
  /** The user accepted the shown risk (different privileges, escalation or reduced access). */
  readonly confirmed: boolean;
}

/**
 * The choice a dialog produces. A risk confirmation only counts when the comparison with the source role was on screen when the user
 * ticked it; a freely chosen role has no comparison yet, so it is recorded unconfirmed and the next preview asks again.
 */
export function choiceFromDialog(sourceRoleId: string, chosenRoleId: string, ticked: boolean, comparisonWasShown: boolean): RoleChoice {
  return { sourceRoleId, chosenRoleId, confirmed: ticked && comparisonWasShown };
}

export interface UserMoveRequest {
  readonly userId: string;
  /** Per-user override of the batch strategy. */
  readonly strategy?: RestoreStrategy;
  /** Per-user override of the batch role selection. */
  readonly selection?: RoleSelection;
  /** Per-user choices; they win over batch choices for the same source role. */
  readonly choices: readonly RoleChoice[];
}

export interface BuMoveRequest {
  readonly targetBusinessUnitId: string;
  readonly strategy: RestoreStrategy;
  readonly selection: RoleSelection;
  readonly choices: readonly RoleChoice[];
  readonly users: readonly UserMoveRequest[];
}

// ---- plan ---------------------------------------------------------------------------------------------------------------

export type UserMoveStatus = 'ready' | 'alreadyInTargetBusinessUnit' | 'disabled' | 'unknownUser';

export type SurvivalKind = 'expectedRetained' | 'expectedRemoved' | 'unknown' | 'unverified';

export interface SurvivalExpectation {
  readonly role: Role;
  readonly roleBusinessUnitName: string;
  readonly kind: SurvivalKind;
  /** Always an expectation with its basis, never a certainty. */
  readonly basis: string;
}

/** Lower number = better match. */
export type MatchLevel = 'lineage' | 'sameNameSamePrivileges' | 'differentPrivileges' | 'suggestionOnly';
export const MATCH_ORDER: Readonly<Record<MatchLevel, number>> = {
  lineage: 1,
  sameNameSamePrivileges: 2,
  differentPrivileges: 3,
  suggestionOnly: 4,
};

export interface PrivilegeDifferenceLine {
  readonly entity: string;
  readonly operation: PrivilegeId;
  readonly sourceDepth: GrantDepth | null;
  readonly candidateDepth: GrantDepth | null;
}

export interface RoleCandidate {
  readonly role: Role;
  readonly businessUnitName: string;
  readonly level: MatchLevel;
  readonly differences: readonly PrivilegeDifferenceLine[];
  /** The candidate has a privilege the source role lacks, or at a wider depth. */
  readonly escalation: boolean;
  /** The candidate lacks a privilege the source role has, or has it at a narrower depth. */
  readonly reducedAccess: boolean;
}

export type DecisionOutcome = 'restore' | 'skipRetained' | 'blocked' | 'notRestoring';

export type BlockReason =
  | 'none'
  | 'missing'
  | 'ambiguous'
  | 'differentPrivilegesUnconfirmed'
  | 'escalationOrReductionUnconfirmed'
  | 'suggestionOnly'
  | 'keepUnavailable'
  | 'needsChoice'
  | 'rootUnavailable'
  | 'invalidChoice'
  | 'privilegeDataIncomplete';

export interface RoleDecision {
  readonly source: Role;
  readonly sourceBusinessUnitName: string;
  readonly outcome: DecisionOutcome;
  readonly blockReason: BlockReason;
  readonly chosen: RoleCandidate | null;
  readonly candidates: readonly RoleCandidate[];
  /** Another source role of the same user resolves to the same target role; it is assigned once. */
  readonly duplicateMapping: boolean;
  readonly explanation: string;
}

export const ASSIGNABILITY_NOTE =
  'Assignability unverified (managed state and the caller\'s right to assign across business units are not checked).';

export interface DefaultTeamView {
  readonly businessUnitName: string;
  readonly roles: readonly Role[];
  /** Role ids the team reports that are not in the role list: its real access is unknown, never "no access". */
  readonly unresolvedRoleIds: readonly string[];
}

export interface UserMovePlan {
  readonly user: UserSummary;
  readonly status: UserMoveStatus;
  readonly statusText: string;
  readonly currentBusinessUnit: string | null;
  readonly targetBusinessUnit: string;
  readonly strategy: RestoreStrategy;
  /** The user's current direct roles. Team-derived roles are in `teamRoles` and are never converted to direct roles. */
  readonly directRoles: readonly RoleGrant[];
  readonly teamRoles: readonly RoleGrant[];
  readonly survival: readonly SurvivalExpectation[];
  readonly decisions: readonly RoleDecision[];
  readonly defaultTeamBefore: DefaultTeamView | null;
  readonly defaultTeamAfter: DefaultTeamView | null;
  readonly risks: readonly string[];
  readonly cannotVerifyBeforeMove: readonly string[];
  readonly expectedOutcome: string;
  /** False when something about the user's access could not be resolved locally. Reports must not call such a row complete. */
  readonly dataComplete: boolean;
}

export const hasBlockedRoles = (p: UserMovePlan): boolean => p.decisions.some((d) => d.outcome === 'blocked');

export interface BuMovePlan {
  readonly targetBusinessUnitId: string;
  readonly targetBusinessUnitName: string;
  readonly settings: SecuritySettings;
  readonly users: readonly UserMovePlan[];
  readonly warnings: readonly string[];
}
