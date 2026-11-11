import { describe, expect, it } from 'vitest';
import { FixtureReader } from '../adapters/fixture/fixtureReader';
import { PARTIAL_ROLES, PROJECT_ROLES, SYNTHETIC_TABLES } from '../adapters/fixture/syntheticData';
import { countUnsupported, filterRoles, filterTables } from './tables';

describe('filterTables', () => {
  it('hides unsupported tables by default and lists them on request', () => {
    expect(filterTables(SYNTHETIC_TABLES, '', false).some((t) => !t.supported)).toBe(false);
    expect(filterTables(SYNTHETIC_TABLES, '', true).some((t) => !t.supported)).toBe(true);
    expect(countUnsupported(SYNTHETIC_TABLES)).toBe(1);
  });

  it('matches display name and logical name, case-insensitively', () => {
    expect(filterTables(SYNTHETIC_TABLES, 'CONTOSO PRO', false).map((t) => t.logicalName)).toEqual(['contoso_project']);
    expect(filterTables(SYNTHETIC_TABLES, 'contoso_task', false).map((t) => t.displayName)).toEqual(['Contoso Task']);
  });

  it('ranks prefix matches before substring matches', () => {
    const tables = [
      { logicalName: 'zz_budget_account', displayName: 'Budget Account', supported: true },
      { logicalName: 'account', displayName: 'Account', supported: true },
    ];
    expect(filterTables(tables, 'acc', false).map((t) => t.logicalName)).toEqual(['account', 'zz_budget_account']);
  });

  it('returns nothing for a query that matches no table', () => {
    expect(filterTables(SYNTHETIC_TABLES, 'zzz', true)).toEqual([]);
  });
});

describe('filterRoles', () => {
  it('shows relevant roles by default and reports how many are hidden', () => {
    const r = filterRoles(PROJECT_ROLES, '', false);
    expect(r.rows.map((x) => x.name)).not.toContain('Facilities Coordinator');
    expect(r.hiddenCount).toBe(1);
  });

  it('Show all lists roles that grant nothing', () => {
    const r = filterRoles(PROJECT_ROLES, '', true);
    expect(r.rows.map((x) => x.name)).toContain('Facilities Coordinator');
    expect(r.hiddenCount).toBe(0);
  });

  it('searches by role name', () => {
    expect(filterRoles(PROJECT_ROLES, 'reader', false).rows.map((x) => x.name)).toEqual(['Project Reader']);
  });

  it('does not hide a role whose cells are unknown', () => {
    const unknownOnly = PARTIAL_ROLES.filter((x) => x.roleId === 'r-contrib');
    expect(filterRoles(unknownOnly, '', false).rows).toHaveLength(1);
  });
});

describe('FixtureReader', () => {
  const reader = new FixtureReader();

  it('lists tables', async () => {
    const r = await reader.listTables();
    expect(r.status).toBe('ok');
  });

  it('returns a partial result with unknown cells for the partial-data table', async () => {
    const r = await reader.loadRoleMatrix('contoso_budget');
    expect(r.status).toBe('partial');
    if (r.status === 'partial') {
      expect(r.notes.length).toBeGreaterThan(0);
      expect(r.data.roles.some((x) => Object.values(x.cells).some((c) => c.kind === 'unknown'))).toBe(true);
    }
  });

  it('classifies failures instead of throwing', async () => {
    const failing = await reader.loadRoleMatrix('contoso_archive');
    expect(failing).toMatchObject({ status: 'error', errorClass: 'network' });
    const missing = await reader.loadRoleMatrix('nope');
    expect(missing).toMatchObject({ status: 'error', errorClass: 'notFound' });
    const unsupported = await reader.loadRoleMatrix('contoso_auditlog');
    expect(unsupported.status).toBe('error');
  });

  it('marks non-applicable privileges distinctly', async () => {
    const r = await reader.loadRoleMatrix('contoso_task');
    expect(r.status).toBe('ok');
    if (r.status === 'ok') expect(r.data.roles[0]?.cells.Assign).toEqual({ kind: 'notApplicable' });
  });
});
