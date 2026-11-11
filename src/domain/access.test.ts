import { describe, expect, it } from 'vitest';
import { FixtureReader } from '../adapters/fixture/fixtureReader';
import type { Person, RoleFamily, RoleInstance } from './access';
import { countAssignments, differingPrivileges, storesOwnPrivileges, formatCount, nameMatches, originOf } from './access';
import { PRIVILEGE_IDS, type CellValue, type PrivilegeCells, type PrivilegeId } from './privileges';

const reader = new FixtureReader();

async function family(table: string, rootRoleId: string): Promise<RoleFamily> {
  const r = await reader.loadRoleDetails(table, rootRoleId);
  if (r.status === 'error') throw new Error(r.message);
  return r.data;
}

const p = (id: string, status: Person['status'] = 'Enabled'): Person => ({ userId: id, name: id, status });
const NO_CELLS = {} as PrivilegeCells;
const inst = (roleId: string, directUsers: Person[], teams: RoleInstance['teams'] = []): RoleInstance => ({
  roleId,
  businessUnitId: 'bu',
  businessUnitName: 'BU',
  cells: NO_CELLS,
  directUsers,
  teams,
});
const team = (teamId: string, members: Person[]) => ({ teamId, name: teamId, teamType: 'Owner', businessUnitId: 'bu', members });

describe('countAssignments: unique users versus assignment paths', () => {
  it('counts a person holding the role directly and through two teams once, on three paths', () => {
    const c = countAssignments([inst('r', [p('a')], [team('t1', [p('a')]), team('t2', [p('a')])])]);
    expect(c.uniqueUsers).toBe(1);
    expect(c.directUsers).toBe(1);
    expect(c.usersViaTeams).toBe(1);
    expect(c.teams).toBe(2);
    expect(c.paths).toBe(3);
    expect(c.usersWithSeveralPaths).toBe(1);
  });

  it('unique users are the deduplicated union of direct and via-team users and never exceed paths', () => {
    const c = countAssignments([inst('r', [p('a'), p('b')], [team('t1', [p('b'), p('c')])])]);
    expect(c.uniqueUserIds).toEqual(['a', 'b', 'c']);
    expect(c.uniqueUsers).toBe(3);
    expect(c.paths).toBe(4);
    expect(c.uniqueUsers).toBeLessThanOrEqual(c.paths);
  });

  it('the same team holding two Business Unit copies is one route for a member, but two paths', () => {
    const t = team('t1', [p('a')]);
    const c = countAssignments([inst('r1', [], [t]), inst('r2', [], [t])]);
    expect(c.uniqueUsers).toBe(1);
    expect(c.paths).toBe(2);
    expect(c.usersWithSeveralPaths).toBe(0);
  });

  it('lists disabled and application users but does not count them as people', () => {
    const c = countAssignments([inst('r', [p('a'), p('off', 'Disabled')], [team('t', [p('svc', 'ApplicationUser')])])]);
    expect(c.uniqueUsers).toBe(1);
    expect(c.paths).toBe(3);
    expect(c.excludedDisabled).toBe(1);
    expect(c.excludedApplication).toBe(1);
  });

  it('an unresolved user is a path and an unresolved reference, never a counted person', () => {
    const c = countAssignments([inst('r', [p('a')], [team('t', [p('ghost', 'Unresolved')])])]);
    expect(c.uniqueUsers).toBe(1);
    expect(c.paths).toBe(2);
    expect(c.unresolved).toBe(1);
    expect(c.unresolvedUserIds).toEqual(['ghost']);
  });

  it('an empty instance has zero everywhere', () => {
    const c = countAssignments([inst('r', [])]);
    expect([c.uniqueUsers, c.paths, c.teams, c.directUsers, c.usersViaTeams]).toEqual([0, 0, 0, 0, 0]);
  });
});

describe('synthetic overlap case (figures derived by hand from syntheticAccess.ts)', () => {
  // Project Contributor, Contoso copy: direct Ann, Cara; teams Project Delivery (Ann, Cara, Dan, Svc[app]) and Regional Leads (Ann, Eva).
  // Project Contributor, North copy: direct Ben, Finn[disabled]; team Regional Leads (Ann, Eva).
  it('whole logical role: 5 unique users on 12 paths, 2 people reach it several ways', async () => {
    const c = countAssignments((await family('contoso_project', 'r-contrib')).instances);
    expect(c.uniqueUserIds).toEqual(['u-ann', 'u-ben', 'u-cara', 'u-dan', 'u-eva']);
    expect(c.directUserIds).toEqual(['u-ann', 'u-ben', 'u-cara']);
    expect(c.viaTeamUserIds).toEqual(['u-ann', 'u-cara', 'u-dan', 'u-eva']);
    expect(c.teams).toBe(2);
    expect(c.paths).toBe(12); // 2+4+2 on the Contoso copy, 2+2 on the North copy
    expect(c.usersWithSeveralPaths).toBe(2); // Ann (direct + 2 teams), Cara (direct + 1 team)
    expect(c.excludedDisabled).toBe(1);
    expect(c.excludedApplication).toBe(1);
    expect(c.unresolved).toBe(0);
  });

  it('one concrete instance is counted on its own (Contoso copy: 4 unique users on 8 paths)', async () => {
    const f = await family('contoso_project', 'r-contrib');
    const hq = f.instances.find((i) => i.businessUnitName === 'Contoso');
    expect(hq).toBeDefined();
    const c = countAssignments([hq as RoleInstance]);
    expect([c.uniqueUsers, c.paths, c.directUsers, c.usersViaTeams, c.teams]).toEqual([4, 8, 2, 4, 2]);
  });

  it('a role held only through one team: 3 unique users on 4 paths (Svc is a path, not a person)', async () => {
    const c = countAssignments((await family('contoso_project', 'r-reader')).instances);
    expect([c.uniqueUsers, c.paths, c.directUsers, c.usersViaTeams, c.teams]).toEqual([3, 4, 0, 3, 1]);
  });

  it('the partial-data table adds an unresolved membership: counts of people stay, paths grow, unresolved is 1', async () => {
    const c = countAssignments((await family('contoso_budget', 'r-contrib')).instances);
    expect(c.uniqueUsers).toBe(5);
    expect(c.paths).toBe(13);
    expect(c.unresolved).toBe(1);
  });
});

describe('Business Unit copies and origins', () => {
  it('reports the privileges on which the copies differ, and none for a single copy', async () => {
    expect(differingPrivileges((await family('contoso_project', 'r-contrib')).instances)).toEqual(['Delete']);
    expect(differingPrivileges((await family('contoso_project', 'r-admin')).instances)).toEqual([]);
  });

  it('does not compare copies that store no privileges on the table (new Business Units get such copies)', () => {
    const full = (over: Partial<Record<PrivilegeId, CellValue>>): PrivilegeCells => Object.fromEntries(PRIVILEGE_IDS.map((p) => [p, over[p] ?? { kind: 'noGrant' }])) as unknown as PrivilegeCells;
    const inst = (id: string, cells: Partial<Record<PrivilegeId, CellValue>>): RoleInstance => ({ roleId: id, businessUnitId: id, businessUnitName: id, cells: full(cells), directUsers: [], teams: [] });
    const root = inst('root', { Create: { kind: 'depth', depth: 'Global' }, Read: { kind: 'depth', depth: 'Global' } });
    const empty = inst('empty', { Create: { kind: 'noGrant' }, Read: { kind: 'noGrant' } });
    expect(differingPrivileges([root, empty, empty])).toEqual([]);
    expect(storesOwnPrivileges(empty.cells)).toBe(false);
    const changed = inst('changed', { Create: { kind: 'depth', depth: 'Basic' }, Read: { kind: 'depth', depth: 'Global' } });
    expect(differingPrivileges([root, empty, changed])).toEqual(['Create']);
    // a root that grants NOTHING still takes part: a copy that grants something differs from it (only empty copies are left out)
    const emptyRoot = inst('root0', {});
    expect(differingPrivileges([emptyRoot, empty, changed])).toEqual([]); // without knowing the root there is nothing to compare against
    expect(differingPrivileges([emptyRoot, empty, changed], 'root0')).toEqual(['Create', 'Read']);
  });

  it('tells direct, via-team, both and not-counted apart for one instance', async () => {
    const f = await family('contoso_project', 'r-contrib');
    const hq = f.instances.find((i) => i.businessUnitName === 'Contoso') as RoleInstance;
    const byId = (id: string) => hq.teams.flatMap((t) => t.members).concat(hq.directUsers).find((m) => m.userId === id) as Person;
    expect(originOf(byId('u-ann'), hq)).toEqual({ kind: 'both', teams: ['Project Delivery', 'Regional Leads'] });
    expect(originOf(byId('u-cara'), hq)).toEqual({ kind: 'both', teams: ['Project Delivery'] });
    expect(originOf(byId('u-dan'), hq)).toEqual({ kind: 'viaTeams', teams: ['Project Delivery'] });
    expect(originOf(byId('u-svc'), hq)).toEqual({ kind: 'notCounted', reason: 'ApplicationUser' });
  });
});

describe('formatCount and nameMatches', () => {
  it('shows a bare number only for complete data; otherwise a lower bound', () => {
    expect(formatCount(5, true)).toEqual({ text: '5', lowerBound: false });
    expect(formatCount(5, false)).toEqual({ text: '≥ 5', lowerBound: true });
  });

  it('filters by a case-insensitive contains match and keeps everything for an empty query', () => {
    expect(nameMatches('Ann Admin', 'ADM')).toBe(true);
    expect(nameMatches('Ann Admin', 'zzz')).toBe(false);
    expect(nameMatches('Ann Admin', '  ')).toBe(true);
  });
});
