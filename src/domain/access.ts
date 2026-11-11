import type { PrivilegeCells, PrivilegeId } from './privileges';
import { PRIVILEGE_IDS } from './privileges';

// Who reaches a role, and how many distinct people that is. Pure functions, no host or UI types.
// Counting contract (approved 2026-11-01):
// - unique users = deduplicated union of enabled, non-application users reached directly or through a role-bearing team;
// - direct users and via-team users may overlap; assignment paths are counted separately from people;
// - only role-bearing teams are modelled here; access-team and nested membership semantics are NOT evaluated.

/** `Unresolved` = a user id is referenced (assignment or membership) but the user record was not read. */
export type PersonStatus = 'Enabled' | 'Disabled' | 'ApplicationUser' | 'Unresolved';

export interface Person {
  readonly userId: string;
  readonly name: string;
  readonly status: PersonStatus;
}

/** Only enabled, non-application, resolvable users are counted as people. */
export const isCounted = (p: Person): boolean => p.status === 'Enabled';

export interface TeamNode {
  readonly teamId: string;
  readonly name: string;
  readonly teamType: string;
  readonly businessUnitId: string;
  readonly members: readonly Person[];
}

/** One concrete role record (the role in one Business Unit). Edits and counts always refer to a concrete instance. */
export interface RoleInstance {
  readonly roleId: string;
  readonly businessUnitId: string;
  readonly businessUnitName: string;
  readonly cells: PrivilegeCells;
  readonly directUsers: readonly Person[];
  readonly teams: readonly TeamNode[];
}

/** A logical role: the root role plus its Business Unit copies, grouped by verified lineage (never by display name). */
export interface RoleFamily {
  readonly rootRoleId: string;
  readonly name: string;
  readonly instances: readonly RoleInstance[];
}

export interface AssignmentCounts {
  readonly directUsers: number;
  readonly usersViaTeams: number;
  readonly teams: number;
  readonly uniqueUsers: number;
  /** Every way the role reaches someone: each direct assignment plus each team membership (not-counted people included). */
  readonly paths: number;
  /** Counted people who reach the role by more than one route (directly and/or through different teams). */
  readonly usersWithSeveralPaths: number;
  readonly excludedDisabled: number;
  readonly excludedApplication: number;
  readonly unresolved: number;
  readonly directUserIds: readonly string[];
  readonly viaTeamUserIds: readonly string[];
  readonly uniqueUserIds: readonly string[];
  readonly teamIds: readonly string[];
  readonly unresolvedUserIds: readonly string[];
}

const sortedIds = (s: ReadonlySet<string>): string[] => [...s].sort();

/** Counts over one or more role instances (an instance, or all copies of a logical role). */
export function countAssignments(instances: readonly RoleInstance[]): AssignmentCounts {
  const direct = new Set<string>();
  const viaTeams = new Set<string>();
  const teams = new Set<string>();
  const routesByUser = new Map<string, Set<string>>();
  const seen = new Map<string, Person>();
  const unresolved = new Set<string>();
  let paths = 0;

  const add = (p: Person, route: string): void => {
    paths++;
    if (p.status === 'Unresolved') {
      unresolved.add(p.userId);
      return;
    }
    seen.set(p.userId, p);
    if (!isCounted(p)) return;
    let set = routesByUser.get(p.userId);
    if (!set) routesByUser.set(p.userId, (set = new Set()));
    set.add(route);
  };

  for (const instance of instances) {
    for (const u of instance.directUsers) {
      add(u, 'direct');
      if (isCounted(u)) direct.add(u.userId);
    }
    for (const t of instance.teams) {
      teams.add(t.teamId);
      for (const m of t.members) {
        add(m, `team:${t.teamId}`);
        if (isCounted(m)) viaTeams.add(m.userId);
      }
    }
  }

  const union = new Set<string>([...direct, ...viaTeams]);
  const people = [...seen.values()];
  return {
    directUsers: direct.size,
    usersViaTeams: viaTeams.size,
    teams: teams.size,
    uniqueUsers: union.size,
    paths,
    usersWithSeveralPaths: [...routesByUser.values()].filter((r) => r.size > 1).length,
    excludedDisabled: people.filter((p) => p.status === 'Disabled').length,
    excludedApplication: people.filter((p) => p.status === 'ApplicationUser').length,
    unresolved: unresolved.size,
    directUserIds: sortedIds(direct),
    viaTeamUserIds: sortedIds(viaTeams),
    uniqueUserIds: sortedIds(union),
    teamIds: sortedIds(teams),
    unresolvedUserIds: sortedIds(unresolved),
  };
}

/** True when a role record stores at least one privilege of its own, or one that could not be read (so it proves something). */
export function storesOwnPrivileges(cells: PrivilegeCells): boolean {
  return PRIVILEGE_IDS.some((p) => cells[p]?.kind === 'depth' || cells[p]?.kind === 'unknown');
}

/**
 * Privileges on which the concrete instances of one logical role disagree (a Business Unit copy was changed). A copy that stores no privileges
 * on the table (Dataverse creates such copies for every new Business Unit) is not compared, the same rule as the "Instances differ" badge.
 */
export function differingPrivileges(all: readonly RoleInstance[], rootRoleId?: string): PrivilegeId[] {
  // The root always takes part (a root that grants nothing differs from a copy that grants something); only EMPTY COPIES are left out.
  const instances = all.filter((i) => storesOwnPrivileges(i.cells) || (rootRoleId !== undefined && i.roleId.toLowerCase() === rootRoleId.toLowerCase()));
  if (instances.length < 2) return [];
  const key = (i: RoleInstance, p: PrivilegeId): string => {
    const c = i.cells[p];
    return c.kind === 'depth' ? `depth:${c.depth}` : c.kind;
  };
  return PRIVILEGE_IDS.filter((p) => new Set(instances.map((i) => key(i, p))).size > 1);
}

export type Origin =
  | { readonly kind: 'direct' }
  | { readonly kind: 'viaTeams'; readonly teams: readonly string[] }
  | { readonly kind: 'both'; readonly teams: readonly string[] }
  | { readonly kind: 'notCounted'; readonly reason: 'Disabled' | 'ApplicationUser' | 'Unresolved' };

/** How one person reaches one role instance: directly, through team(s), or both. */
export function originOf(person: Person, instance: RoleInstance): Origin {
  if (person.status !== 'Enabled') return { kind: 'notCounted', reason: person.status };
  const isDirect = instance.directUsers.some((u) => u.userId === person.userId);
  const teams = instance.teams.filter((t) => t.members.some((m) => m.userId === person.userId)).map((t) => t.name);
  if (isDirect && teams.length > 0) return { kind: 'both', teams };
  if (isDirect) return { kind: 'direct' };
  return { kind: 'viaTeams', teams };
}

export interface CountText {
  readonly text: string;
  readonly lowerBound: boolean;
}

/** A count is a lower bound (">= N") whenever the data behind it is incomplete; never a bare number then. */
export function formatCount(n: number, complete: boolean): CountText {
  return complete ? { text: String(n), lowerBound: false } : { text: `≥ ${n}`, lowerBound: true };
}

/** Case-insensitive "name contains" filter for people and team lists (never truncates, only narrows). */
export function nameMatches(name: string, query: string): boolean {
  const q = query.trim().toLowerCase();
  return !q || name.toLowerCase().includes(q);
}
