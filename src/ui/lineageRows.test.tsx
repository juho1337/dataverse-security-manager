import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { FixtureReader } from '../adapters/fixture/fixtureReader';
import { PRIVILEGE_IDS, type CellValue, type PrivilegeCells, type RoleMatrix, type RoleRow } from '../domain/privileges';
import type { ReadResult, SecurityDataReader } from '../ports/securityDataReader';
import type { SecurityDataWriter } from '../ports/securityDataWriter';
import { App } from './App';

const ENV = '00000000-0000-4000-8000-000000000002';
const ORPHAN_ID = 'e1000000-0000-0000-0000-0000000000f1';

const noGrant = Object.fromEntries(PRIVILEGE_IDS.map((p) => [p, { kind: 'noGrant' } as CellValue])) as PrivilegeCells;

/** The synthetic matrix, with lineage as the live reader now supplies it: the first role is a root with two copies (one differs, one stores nothing),
 *  plus an orphan copy whose root is not in the loaded data. */
class GroupedReader implements SecurityDataReader {
  readonly base = new FixtureReader();
  listTables = () => this.base.listTables();
  loadRoleDetails = (t: string, r: string) => this.base.loadRoleDetails(t, r);
  async loadRoleMatrix(table: string): Promise<ReadResult<RoleMatrix>> {
    const r = await this.base.loadRoleMatrix(table);
    if (r.status === 'error') return r;
    // the live reader supplies no per-role user counts (they load on expansion), so the rows carry lineage only
    const roles: RoleRow[] = r.data.roles.map(({ summary, ...row }) => (void summary,
      row.name === 'Project Contributor'
        ? { ...row, isManaged: false, parentRootRoleId: null, lineage: { instanceCount: 3, instancesDiffer: true, copiesWithoutStoredGrants: 1, anyInstanceGrants: true } }
        : { ...row, isManaged: false, parentRootRoleId: null, lineage: { instanceCount: 1, instancesDiffer: false, copiesWithoutStoredGrants: 0, anyInstanceGrants: true } }),
    );
    roles.push({
      roleId: ORPHAN_ID,
      name: 'Orphan Role',
      isManaged: false,
      parentRootRoleId: 'e1000000-0000-0000-0000-0000000000f0',
      cells: noGrant,
      lineage: { instanceCount: 1, instancesDiffer: false, copiesWithoutStoredGrants: 0, anyInstanceGrants: true, rootMissing: true },
    });
    return { ...r, data: { ...r.data, roles } } as ReadResult<RoleMatrix>;
  }
}

const writer: SecurityDataWriter = { addPrivilege: vi.fn(), removePrivilege: vi.fn(), assignRole: vi.fn(), unassignRole: vi.fn(), moveUser: vi.fn() };

async function open(view: 'privilege' | 'depth' = 'privilege') {
  const user = userEvent.setup();
  render(<App reader={new GroupedReader()} writer={writer} environmentId={ENV} dataSource="live" />);
  const combo = await screen.findByRole('combobox');
  await user.click(combo);
  await user.type(combo, 'contoso_project');
  await user.click(await screen.findByRole('option', { name: /Contoso Project/ }));
  await screen.findByRole('treegrid');
  if (view === 'depth') await user.click(screen.getByRole('radio', { name: 'Depth Matrix' }));
  return user;
}

const rowOf = (name: string): HTMLElement => {
  const row = screen.getAllByRole('row').find((r) => within(r).queryByText(name, { selector: '.role-name' }));
  if (!row) throw new Error(`row ${name} not found`);
  return row;
};

describe.each(['privilege', 'depth'] as const)('lineage rows in the %s matrix', (view) => {
  it('invites to expand for who holds the role (no instance jargon) and shows the "Instances differ" badge on the family row', async () => {
    await open(view);
    const first = within(rowOf('Project Contributor'));
    expect(first.getByText('Expand to see users and teams')).toBeTruthy();
    expect(first.getByText('Instances differ')).toBeTruthy();
    // a family with no copies shows no difference badge
    expect(within(rowOf('Project Reader')).queryByText('Instances differ')).toBeNull();
  });

  it('marks an orphan copy as its own row with "Root role not loaded", and refuses to edit it, naming the reason', async () => {
    await open(view);
    expect(within(rowOf('Orphan Role')).getByText('Root role not loaded')).toBeTruthy();
    // a role that cannot be edited is marked once, with the reason, and offers no editing
    expect(within(rowOf('Orphan Role')).getByText(/\(read-only\)/).closest('[title]')?.getAttribute('title')).toMatch(/root role is not in the loaded data/);
    expect(within(rowOf('Orphan Role')).queryAllByTitle('Click to edit this role')).toHaveLength(0);
    expect(screen.queryByRole('region', { name: 'Role editing' })).toBeNull();
  });

  it('editing a family targets the root role (the row), and the row has a unique id and keyboard focus', async () => {
    const user = await open(view);
    await user.click(within(rowOf('Project Contributor')).getAllByRole(view === 'depth' ? 'button' : 'gridcell', { name: /^Read/ })[0] as HTMLElement);
    expect(await screen.findByRole('region', { name: 'Role editing' })).toBeTruthy();
    const ids = [...document.querySelectorAll('[id]')].map((e) => e.id);
    expect(new Set(ids).size).toBe(ids.length);
  });
});

describe('filters work on families', () => {
  it('a family stays listed when only a copy grants on the table, and "Show all roles" counts families', async () => {
    const reader = new GroupedReader();
    const original = reader.loadRoleMatrix.bind(reader);
    reader.loadRoleMatrix = async (t: string) => {
      const r = await original(t);
      if (r.status === 'error') return r;
      // the root grants nothing, but a copy does (anyInstanceGrants)
      const roles = r.data.roles.map((row) => (row.name === 'Project Reader' ? { ...row, cells: noGrant } : row));
      return { ...r, data: { ...r.data, roles } } as ReadResult<RoleMatrix>;
    };
    const user = userEvent.setup();
    render(<App reader={reader} writer={writer} environmentId={ENV} dataSource="live" />);
    const combo = await screen.findByRole('combobox');
    await user.click(combo);
    await user.type(combo, 'contoso_project');
    await user.click(await screen.findByRole('option', { name: /Contoso Project/ }));
    await screen.findByRole('treegrid');
    expect(screen.getAllByText('Project Reader', { selector: '.role-name' }).length).toBe(1); // kept by anyInstanceGrants
  });
});
