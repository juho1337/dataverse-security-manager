import { describe, expect, it } from 'vitest';
import type { RoleFamily } from '../domain/access';
import type { CellValue, DepthId, PrivilegeCells, PrivilegeId, RoleRow } from '../domain/privileges';
import { PRIVILEGE_IDS } from '../domain/privileges';
import { applyMatrixFilters, describeFilters, NO_FILTERS, type Assignments, type MatrixFilters } from './roleFilters';

const cells = (over: Partial<Record<PrivilegeId, CellValue>> = {}): PrivilegeCells =>
  Object.fromEntries(PRIVILEGE_IDS.map((p) => [p, over[p] ?? { kind: 'noGrant' }])) as PrivilegeCells;
const depth = (d: DepthId): CellValue => ({ kind: 'depth', depth: d });
const role = (id: string, name: string, over: Partial<Record<PrivilegeId, CellValue>> = {}): RoleRow => ({ roleId: id, name, cells: cells(over) });
const family = (id: string, bu: string, users: string[], teams: { name: string; members: string[] }[] = []): RoleFamily => ({
  rootRoleId: id,
  name: id,
  instances: [
    {
      roleId: `${id}-i`,
      businessUnitId: `bu-${bu}`,
      businessUnitName: bu,
      cells: cells(),
      directUsers: users.map((n, i) => ({ userId: `u${i}`, name: n, status: 'Enabled' as const })),
      teams: teams.map((t, i) => ({
        teamId: `t${i}`,
        name: t.name,
        teamType: 'Owner',
        businessUnitId: `bu-${bu}`,
        members: t.members.map((n, j) => ({ userId: `m${j}`, name: n, status: 'Enabled' as const })),
      })),
    },
  ],
});

const roles = [
  role('a', 'Alpha', { Read: depth('Global'), Write: depth('Basic') }),
  role('b', 'Beta', { Read: depth('Local') }),
  role('c', 'Gamma', { Delete: depth('None') }),
  role('d', 'Delta', { Read: { kind: 'unknown' } }),
];
const none = (): Assignments => undefined;
const f = (over: Partial<MatrixFilters>): MatrixFilters => ({ ...NO_FILTERS, ...over });

describe('applyMatrixFilters: privilege and depth', () => {
  it('without filters behaves like the relevant-roles default (unreadable roles stay)', () => {
    const o = applyMatrixFilters(roles, NO_FILTERS, none);
    expect(o.rows.map((r) => r.name)).toEqual(['Alpha', 'Beta', 'Delta']);
    expect(o.hiddenCount).toBe(1);
  });

  it('a privilege filter keeps roles that grant that privilege at any depth', () => {
    const o = applyMatrixFilters(roles, f({ privileges: ['Write'] }), none);
    expect(o.rows.map((r) => r.name)).toEqual(['Alpha']);
  });

  it('a depth filter keeps roles that grant that depth on an examined privilege', () => {
    const o = applyMatrixFilters(roles, f({ privileges: ['Read'], depths: ['Global'] }), none);
    expect(o.rows.map((r) => r.name)).toEqual(['Alpha', 'Delta']);
  });

  it('a depth filter alone looks at all eight privileges', () => {
    const o = applyMatrixFilters(roles, f({ depths: ['Basic'] }), none);
    expect(o.rows.map((r) => r.name)).toEqual(['Alpha', 'Delta']);
  });

  it('the None depth finds roles that explicitly grant nothing, and not roles with no grant', () => {
    const o = applyMatrixFilters(roles, f({ privileges: ['Delete'], depths: ['None'] }), none);
    expect(o.rows.map((r) => r.name)).toEqual(['Gamma']);
  });

  it('an unreadable cell never hides a role, and is counted', () => {
    const o = applyMatrixFilters(roles, f({ privileges: ['Read'], depths: ['Deep'] }), none);
    expect(o.rows.map((r) => r.name)).toEqual(['Delta']);
    expect(o.unreadableIncluded).toBe(1);
  });

  it('a depth filter overrides the relevant-roles default (no hidden count)', () => {
    const o = applyMatrixFilters(roles, f({ depths: ['None'] }), none);
    expect(o.rows.map((r) => r.name)).toEqual(['Delta', 'Gamma']);
    expect(o.hiddenCount).toBe(0);
  });

  it('combines with the name search', () => {
    const o = applyMatrixFilters(roles, f({ privileges: ['Read'], search: 'bet' }), none);
    expect(o.rows.map((r) => r.name)).toEqual(['Beta']);
  });
});

describe('applyMatrixFilters: holder and Business Unit', () => {
  const known: Record<string, Assignments> = {
    a: { status: 'ok', data: family('a', 'Sales', ['Ada Lovelace'], [{ name: 'Support team', members: ['Grace Hopper'] }]) },
    b: { status: 'ok', data: family('b', 'Finance', ['Alan Turing']) },
    d: { status: 'error', errorClass: 'network', message: 'x' },
  };
  const lookup = (id: string): Assignments => known[id];

  it('finds a role by a direct user, a team or a team member', () => {
    expect(applyMatrixFilters(roles, f({ holder: 'ada' }), lookup).rows.map((r) => r.name)).toEqual(['Alpha', 'Delta']);
    expect(applyMatrixFilters(roles, f({ holder: 'support' }), lookup).rows.map((r) => r.name)).toEqual(['Alpha', 'Delta']);
    expect(applyMatrixFilters(roles, f({ holder: 'hopper' }), lookup).rows.map((r) => r.name)).toEqual(['Alpha', 'Delta']);
  });

  it('finds a role by Business Unit', () => {
    expect(applyMatrixFilters(roles, f({ businessUnit: 'fin' }), lookup).rows.map((r) => r.name)).toEqual(['Beta', 'Delta']);
  });

  it('requires both holder and Business Unit on the same copy', () => {
    expect(applyMatrixFilters(roles, f({ holder: 'ada', businessUnit: 'finance' }), lookup).rows.map((r) => r.name)).toEqual(['Delta']);
  });

  it('keeps a role whose assignments could not be read and counts it', () => {
    const o = applyMatrixFilters(roles, f({ holder: 'nobody-matches' }), lookup);
    expect(o.rows.map((r) => r.name)).toEqual(['Delta']);
    expect(o.couldNotCheck).toBe(1);
  });

  it('does not treat a role that was never loaded as "held by nobody": it is counted as not checked', () => {
    const o = applyMatrixFilters(roles, f({ holder: 'ada' }), none);
    expect(o.rows).toEqual([]);
    expect(o.notChecked).toEqual(['a', 'b', 'd']);
  });

  it('a partial read never hides a role: a match is kept, a non-match is kept and flagged as not completely checked', () => {
    const partial = (id: string, users: string[]): Assignments => ({ status: 'partial', data: family(id, 'Sales', users), notes: ['team memberships could not be read'] });
    const look = (id: string): Assignments => (id === 'a' ? partial('a', ['Ada Lovelace']) : id === 'b' ? partial('b', []) : undefined);
    const o = applyMatrixFilters(roles, f({ holder: 'ada' }), look);
    expect(o.rows.map((r) => r.name)).toEqual(['Alpha', 'Beta']);
    expect(o.couldNotCheck).toBe(1); // Beta: no match in an incomplete read
    expect(o.notChecked).toEqual(['d']);
  });

  it('a role still loading is not checked yet', () => {
    const o = applyMatrixFilters(roles, f({ holder: 'ada' }), (id) => (id === 'a' ? 'loading' : undefined));
    expect(o.notChecked).toContain('a');
  });
});

describe('describeFilters', () => {
  const dl = (d: DepthId) => d;
  const pl = (p: PrivilegeId) => p;
  it('names every active filter and the honesty counts, so a report says what it leaves out', () => {
    const flt = f({ privileges: ['Read', 'Write'], depths: ['Global'], holder: 'ada', businessUnit: 'sales' });
    const o = applyMatrixFilters(roles, flt, none);
    const text = describeFilters(flt, o, dl, pl);
    expect(text).toContain('Read or Write at Global');
    expect(text).toContain('held by a user or team matching "ada"');
    expect(text).toContain('Business Unit copy matching "sales"');
    expect(text).toContain('not checked');
  });

  it('keeps the pre-existing wording without new filters', () => {
    const o = applyMatrixFilters(roles, NO_FILTERS, none);
    expect(describeFilters(NO_FILTERS, o, dl, pl)).toBe('no role-name search; only roles that grant something (1 hidden)');
  });
});
