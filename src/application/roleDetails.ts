import type { AssignmentCounts, RoleFamily, RoleInstance } from '../domain/access';
import { countAssignments, differingPrivileges, formatCount } from '../domain/access';
import type { PrivilegeId } from '../domain/privileges';
import type { ReadResult } from '../ports/securityDataReader';

/** Shown wherever counts appear: role assignments are not the same as effective access to records. */
export const COUNT_LIMITATION =
  'Counts cover users assigned the role directly and members of teams that hold it. Access teams and nested membership are not evaluated, so this is not complete effective access to records.';

export interface InstanceView {
  readonly instance: RoleInstance;
  readonly counts: AssignmentCounts;
}

export interface FamilyView {
  readonly family: RoleFamily;
  /** Counts over all Business Unit copies of the logical role (union of people, so nobody is counted twice). */
  readonly counts: AssignmentCounts;
  readonly instances: readonly InstanceView[];
  readonly differing: readonly PrivilegeId[];
  /** False when the read was partial or a referenced user could not be resolved: all counts are then lower bounds. */
  readonly complete: boolean;
  readonly notes: readonly string[];
}

/** View model for an expanded role; the UI never recomputes counts itself. */
export function describeFamily(result: Exclude<ReadResult<RoleFamily>, { status: 'error' }>): FamilyView {
  const family = result.data;
  const counts = countAssignments(family.instances);
  const notes = result.status === 'partial' ? [...result.notes] : [];
  return {
    family,
    counts,
    instances: family.instances.map((instance) => ({ instance, counts: countAssignments([instance]) })),
    differing: differingPrivileges(family.instances, family.rootRoleId),
    complete: result.status === 'ok' && counts.unresolved === 0,
    notes,
  };
}

/**
 * Who holds a role, in plain words: "5 unique users · 2 direct · 3 teams (4 users from teams) · 1 application user".
 * Unique users are the people who hold the role directly or through a team, each counted once; "direct" are the ones assigned the role themselves,
 * and the number in brackets are the (distinct) people who reach it through the teams (a person can be in both numbers, hence they do not add up).
 * Application users are service accounts and are shown separately; disabled users and users that could not be read are named only when there
 * are any. A count from incomplete data is a lower bound ("≥ 5"). (The number of assignment paths is an internal measure and is not shown.)
 */
export function describeCounts(c: AssignmentCounts, complete: boolean): string {
  const n = (count: number, one: string, many: string): string => {
    const f = formatCount(count, complete);
    return `${f.text} ${count === 1 && complete ? one : many}`;
  };
  const viaTeams = formatCount(c.usersViaTeams, complete).text;
  const parts = [
    n(c.uniqueUsers, 'unique user', 'unique users'),
    `${formatCount(c.directUsers, complete).text} direct`,
    `${n(c.teams, 'team', 'teams')} (${viaTeams} user${c.usersViaTeams === 1 && complete ? '' : 's'} from teams)`,
    n(c.excludedApplication, 'application user', 'application users'),
  ];
  if (c.excludedDisabled > 0) parts.push(`${c.excludedDisabled} disabled`);
  if (c.unresolved > 0) parts.push(`${c.unresolved} not read`);
  return parts.join(' · ');
}

/** What the assignments of one listed role currently are, as far as the screen knows (the matrix keeps one state per role row). */
export type RoleAssignmentsState = { readonly phase: 'loading' } | { readonly phase: 'done'; readonly result: ReadResult<RoleFamily> } | undefined;

export interface UsersTotal {
  /** People and teams over every loaded role, each counted once (a person who holds two of the roles is one person). */
  readonly counts: AssignmentCounts;
  /** Roles listed. */
  readonly roles: number;
  /** Listed roles whose users were read (completely or in part). */
  readonly loaded: number;
  /** Roles being read right now. */
  readonly loading: number;
  /** Roles whose read failed. */
  readonly failed: number;
  /** True only when every listed role was read completely: otherwise the numbers are lower bounds. */
  readonly complete: boolean;
}

/**
 * The total over the listed roles: one pass over the loaded role families (a Business Unit copy of a role returns the same family as its root, so a
 * family is counted once). Nothing here reads Dataverse; roles that are not loaded are only counted as such.
 */
export function totalUsers(roleIds: readonly string[], stateOf: (roleId: string) => RoleAssignmentsState): UsersTotal {
  const families = new Map<string, RoleFamily>();
  let loaded = 0;
  let loading = 0;
  let failed = 0;
  let complete = true;
  for (const id of roleIds) {
    const s = stateOf(id);
    if (!s) {
      complete = false;
    } else if (s.phase === 'loading') {
      loading++;
      complete = false;
    } else if (s.result.status === 'error') {
      failed++;
      complete = false;
    } else {
      loaded++;
      families.set(s.result.data.rootRoleId, s.result.data);
      if (s.result.status === 'partial') complete = false;
    }
  }
  const counts = countAssignments([...families.values()].flatMap((f) => f.instances));
  if (counts.unresolved > 0) complete = false;
  return { counts, roles: roleIds.length, loaded, loading, failed, complete };
}

/** The line next to the table title: the total over the listed roles, or an invitation to load the users when none were read yet. */
export function describeTotal(t: UsersTotal): string {
  if (t.roles === 0) return '';
  if (t.loaded === 0) return t.loading > 0 ? 'Reading users…' : 'Users not loaded yet';
  const progress = t.loaded === t.roles ? `all ${t.roles} role${t.roles === 1 ? '' : 's'} read` : `${t.loaded} of ${t.roles} roles read`;
  return `Total: ${describeCounts(t.counts, t.complete)} (${progress}${t.failed > 0 ? `, ${t.failed} failed` : ''})`;
}
