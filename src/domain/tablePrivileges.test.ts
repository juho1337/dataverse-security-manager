import { describe, expect, it } from 'vitest';
import type { PrivilegeId } from './privileges';
import { aggregateTablePrivileges, cellsOf, mergeOrigins, removalEffect, roleInstancesOfTeam, type RoleGrantRecord, type RoleGrantsData, type RoleInstance } from './tablePrivileges';

const ALL: readonly PrivilegeId[] = ['Create', 'Read', 'Write', 'Delete', 'Append', 'AppendTo', 'Assign', 'Share'];
const DIRECT = { kind: 'direct' } as const;
const via = (teamId: string, teamName: string) => ({ kind: 'team', teamId, teamName }) as const;
const role = (roleId: string, roleName: string, origins: RoleInstance['origins'], businessUnitName = 'Contoso'): RoleInstance => ({ roleId, roleName, businessUnitName, origins });
const grant = (roleId: string, table: string, operation: PrivilegeId, depth: RoleGrantRecord['depth']): RoleGrantRecord => ({ roleId, table, operation, depth });
const data = (grants: RoleGrantRecord[], over: Partial<RoleGrantsData> = {}): RoleGrantsData => ({
  grants,
  catalog: new Map([['account', new Set(ALL)], ['project', new Set(ALL.filter((o) => o !== 'Assign'))]]),
  tableNames: new Map([['account', 'Account']]),
  complete: true,
  ...over,
});
const one = (input: Parameters<typeof aggregateTablePrivileges>[0], table: string) => aggregateTablePrivileges(input).find((t) => t.logicalName === table)!;

describe('aggregateTablePrivileges', () => {
  it('the highest explicit depth wins and every contributor is kept, with the ones that determine it', () => {
    const roles = [role('a', 'Admin', [DIRECT]), role('b', 'Reader', [via('t1', 'Sales')])];
    const t = one({ roles, rolesComplete: true, data: data([grant('a', 'account', 'Read', 'Global'), grant('b', 'account', 'Read', 'Local')]) }, 'account');
    const read = t.operations.Read;
    expect(read.cell).toEqual({ kind: 'depth', depth: 'Global' });
    expect(read.contributors.map((c) => [c.roleName, c.depth, c.determinesAggregate])).toEqual([['Admin', 'Global', true], ['Reader', 'Local', false]]);
    expect(read.contributors[1]!.origins).toEqual([via('t1', 'Sales')]);
  });

  it('overlapping direct and team grants at different depths: the team grant can be the one that decides', () => {
    const roles = [role('a', 'Basic', [DIRECT]), role('b', 'Team role', [via('t1', 'Sales')])];
    const t = one({ roles, rolesComplete: true, data: data([grant('a', 'account', 'Write', 'Basic'), grant('b', 'account', 'Write', 'Deep')]) }, 'account');
    expect(t.operations.Write.cell).toEqual({ kind: 'depth', depth: 'Deep' });
    const decider = t.operations.Write.contributors.find((c) => c.determinesAggregate)!;
    expect(decider.roleName).toBe('Team role');
    expect(decider.origins[0]).toEqual(via('t1', 'Sales'));
  });

  it('same-name roles with different ids stay separate contributors; equal depths decide together', () => {
    const roles = [role('r1', 'Project Contributor', [DIRECT], 'Contoso'), role('r2', 'Project Contributor', [DIRECT], 'North')];
    const t = one({ roles, rolesComplete: true, data: data([grant('r1', 'account', 'Read', 'Local'), grant('r2', 'account', 'Read', 'Local')]) }, 'account');
    const c = t.operations.Read.contributors;
    expect(c).toHaveLength(2);
    expect(new Set(c.map((x) => x.roleId))).toEqual(new Set(['r1', 'r2']));
    expect(c.every((x) => x.determinesAggregate)).toBe(true);
    expect(c.map((x) => x.businessUnitName).sort()).toEqual(['Contoso', 'North']);
  });

  it('keeps no-grant, not-applicable and unknown apart, and never turns a gap into no-grant', () => {
    const roles = [role('a', 'Admin', [DIRECT])];
    const complete = one({ roles, rolesComplete: true, data: data([grant('a', 'project', 'Read', 'Global')]) }, 'project');
    expect(complete.operations.Read.cell).toEqual({ kind: 'depth', depth: 'Global' });
    expect(complete.operations.Write.cell).toEqual({ kind: 'noGrant' });
    expect(complete.operations.Assign.cell).toEqual({ kind: 'notApplicable' }); // the table has no Assign privilege
    expect(complete.partial).toBe(false);
    for (const [rolesComplete, grantsComplete] of [[false, true], [true, false]] as const) {
      const gap = one({ roles, rolesComplete, data: data([grant('a', 'project', 'Read', 'Global')], { complete: grantsComplete }) }, 'project');
      expect(gap.operations.Write.cell).toEqual({ kind: 'unknown' });
      expect(gap.operations.Read.cell).toEqual({ kind: 'depth', depth: 'Global' }); // what is known stays known
      expect(gap.operations.Assign.cell).toEqual({ kind: 'notApplicable' });
      expect(gap.partial).toBe(true);
    }
  });

  it('ignores grants of roles the person or team does not hold, drops None grants, and lists only tables with a grant', () => {
    const roles = [role('a', 'Admin', [DIRECT])];
    const tables = aggregateTablePrivileges({ roles, rolesComplete: true, data: data([grant('a', 'account', 'Read', 'None'), grant('other', 'project', 'Read', 'Global'), grant('a', 'project', 'Create', 'Basic')]) });
    expect(tables.map((t) => t.logicalName)).toEqual(['project']);
    expect(tables[0]!.operations.Read.cell).toEqual({ kind: 'noGrant' });
    expect(tables[0]!.operations.Create.cell).toEqual({ kind: 'depth', depth: 'Basic' });
  });

  it('sorts tables by display name (logical name when none is known) and exposes the cells in the Role Analyzer shape', () => {
    const roles = [role('a', 'Admin', [DIRECT])];
    const tables = aggregateTablePrivileges({ roles, rolesComplete: true, data: data([grant('a', 'project', 'Read', 'Local'), grant('a', 'account', 'Read', 'Local')]) });
    expect(tables.map((t) => t.displayName)).toEqual(['Account', 'project']);
    expect(Object.keys(cellsOf(tables[0]!))).toEqual([...ALL]);
  });
});

describe('removalEffect', () => {
  const op = (roles: RoleInstance[], grants: RoleGrantRecord[]) => one({ roles, rolesComplete: true, data: data(grants) }, 'account').operations.Read;
  const a = role('a', 'A', [DIRECT]);
  const b = role('b', 'B', [DIRECT]);
  const c = role('c', 'C', [DIRECT]);

  it('says what removing a contributor does to the aggregate', () => {
    expect(removalEffect(op([a], [grant('a', 'account', 'Read', 'Global')]), 'a')).toEqual({ kind: 'removes' });
    expect(removalEffect(op([a, b], [grant('a', 'account', 'Read', 'Global'), grant('b', 'account', 'Read', 'Global')]), 'a')).toEqual({ kind: 'nothing' });
    expect(removalEffect(op([a, b, c], [grant('a', 'account', 'Read', 'Global'), grant('b', 'account', 'Read', 'Local'), grant('c', 'account', 'Read', 'Basic')]), 'a')).toEqual({ kind: 'lowers', to: 'Local' });
    expect(removalEffect(op([a, b], [grant('a', 'account', 'Read', 'Global'), grant('b', 'account', 'Read', 'Local')]), 'b')).toEqual({ kind: 'nothing' }); // a lower grant is already superseded
    expect(removalEffect(op([a], [grant('a', 'account', 'Read', 'Global')]), 'zzz')).toEqual({ kind: 'unknown' });
  });
});

describe('completeness is never turned into a statement', () => {
  const roles = [role('a', 'A', [DIRECT])];
  it('a table operation missing from an incomplete catalog is unknown, not "not applicable"', () => {
    const t = one({ roles, rolesComplete: true, data: data([grant('a', 'project', 'Read', 'Global')], { complete: false, catalogComplete: false }) }, 'project');
    expect(t.operations.Assign.cell).toEqual({ kind: 'unknown' }); // project has no Assign in the catalog, but the catalog is incomplete
    expect(t.operations.Read.cell).toEqual({ kind: 'depth', depth: 'Global' });
    const full = one({ roles, rolesComplete: true, data: data([grant('a', 'project', 'Read', 'Global')]) }, 'project');
    expect(full.operations.Assign.cell).toEqual({ kind: 'notApplicable' });
  });

  it('what removing a role would do is unknown when other roles may have been unread (only "nothing" survives)', () => {
    const a = role('a', 'A', [DIRECT]);
    const b = role('b', 'B', [DIRECT]);
    const incomplete = (grants: RoleGrantRecord[]) => one({ roles: [a, b], rolesComplete: false, data: data(grants) }, 'account').operations.Read;
    expect(removalEffect(incomplete([grant('a', 'account', 'Read', 'Global')]), 'a')).toEqual({ kind: 'unknown' }); // an unread role may grant it too
    expect(removalEffect(incomplete([grant('a', 'account', 'Read', 'Global'), grant('b', 'account', 'Read', 'Local')]), 'a')).toEqual({ kind: 'unknown' });
    expect(removalEffect(incomplete([grant('a', 'account', 'Read', 'Global'), grant('b', 'account', 'Read', 'Global')]), 'a')).toEqual({ kind: 'nothing' });
  });
});

describe('origins', () => {
  it('merges the ways one role reaches the person without duplicates', () => {
    const merged = mergeOrigins([DIRECT, via('t1', 'Sales')], [via('t1', 'Sales'), via('t2', 'Ops'), DIRECT]);
    expect(merged).toEqual([DIRECT, via('t1', 'Sales'), via('t2', 'Ops')]);
  });

  it('a team has its roles assigned to the team itself (no fabricated member privileges)', () => {
    const instances = roleInstancesOfTeam([{ role: { id: 'r', name: 'Team role' }, businessUnitName: null }]);
    expect(instances).toEqual([{ roleId: 'r', roleName: 'Team role', businessUnitName: 'business unit not read', origins: [DIRECT] }]);
  });
});
