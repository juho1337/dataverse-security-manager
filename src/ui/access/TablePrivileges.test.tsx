import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { FixtureAccessReader } from '../../adapters/fixture/accessFixture';
import type { AccessReader } from '../../ports/accessReader';
import { AccessExplorerModule } from './AccessExplorerModule';

type U = ReturnType<typeof userEvent.setup>;

function setup(reader: AccessReader = new FixtureAccessReader()) {
  const user = userEvent.setup();
  render(<AccessExplorerModule reader={reader} debounceMs={0} />);
  return { user };
}

async function open(user: U, query: string, name: RegExp) {
  await user.type(screen.getByRole('searchbox', { name: 'Search users and teams' }), query);
  await screen.findByText(/found\./);
  await user.click(screen.getByRole('button', { name }));
}

async function tablePrivileges(user: U) {
  await user.click(await screen.findByRole('button', { name: 'Table privileges' }));
  return screen.findByRole('region', { name: 'Table privileges' });
}

describe('Access Explorer: table privileges of a user', () => {
  it('lists the tables the roles grant, with the highest depth per operation, in the Privilege Matrix semantics', async () => {
    const { user } = setup();
    await open(user, 'ann', /Ann Admin/);
    const panel = await tablePrivileges(user);
    const table = await within(panel).findByRole('table', { name: 'Table privileges by privilege' });
    const rows = within(table).getAllByRole('row').slice(1);
    expect(rows.map((r) => within(r).getAllByRole('rowheader')[0]?.textContent)).toEqual([expect.stringContaining('Account'), expect.stringContaining('Contoso Project')]);
    const account = rows.find((r) => r.textContent?.includes('Account'))!;
    expect(within(account).getByRole('button', { name: 'Account: Read: Organization' })).toBeTruthy();
    // the demo table has no Assign privilege: shown as not applicable, never as no grant
    const project = rows.find((r) => r.textContent?.includes('Contoso Project'))!;
    expect(within(project).getByRole('button', { name: 'Contoso Project: Assign: n/a' })).toBeTruthy();
    expect(screen.getByText(/not access to a particular record/)).toBeTruthy();
  });

  it('shows every contributing role of a cell with its source and what removing it would do, without conflating anything', async () => {
    const { user } = setup();
    await open(user, 'ann', /Ann Admin/);
    const panel = await tablePrivileges(user);
    await user.click(await within(panel).findByRole('button', { name: 'Account: Read: Organization' }));
    const sources = within(panel).getByRole('region', { name: 'Privilege sources' });
    expect(within(sources).getByRole('heading').textContent).toContain('Account · Read: Organization');
    const list = within(sources).getByRole('list', { name: 'Contributing roles' });
    const items = within(list).getAllByRole('listitem');
    expect(items.length).toBeGreaterThan(2);
    expect(items[0]!.textContent).toContain('System Administrator');
    expect(items[0]!.textContent).toContain('determines the result');
    expect(items[0]!.textContent).toContain('Direct');
    expect(items[0]!.textContent).toContain('Removing this role would lower the result to');
    // a lower grant is shown as superseded, and a role reached through a team says which team
    expect(items.some((i) => i.textContent?.includes('superseded by System Administrator'))).toBe(true);
    expect(items.some((i) => /Via team/.test(i.textContent ?? ''))).toBe(true);
    for (const i of items) expect(i.textContent).toMatch(/role id [0-9a-z-]{4,}/);
  });

  it('shows the same data By depth with the Role Analyzer letters, and a letter opens its sources', async () => {
    const { user } = setup();
    await open(user, 'ann', /Ann Admin/);
    const panel = await tablePrivileges(user);
    await user.click(within(panel).getByRole('radio', { name: 'Depth Matrix' }));
    const table = within(panel).getByRole('table', { name: 'Table privileges by depth' });
    expect(within(table).getAllByRole('columnheader').map((h) => h.textContent)).toEqual(['Table', 'User', 'Business Unit', 'Parent: Child BU', 'Organization']);
    // Read on Account is granted at Organization (a letter in the Organization column), the lower columns only imply it
    const letter = within(table).getAllByRole('button', { name: /^Account, Organization: Read: granted at Organization/ })[0]!;
    expect(letter).toBeTruthy();
    expect(within(table).getAllByRole('button', { name: /^Account, User: Read: covered by the Organization grant/ })[0]).toBeTruthy();
    await user.click(letter);
    expect(within(panel).getByRole('region', { name: 'Privilege sources' }).textContent).toContain('System Administrator');
  });

  it('draws the Depth Matrix letters exactly like the Role Analyzer: one coloured letter per privilege (data-priv), its state, a tooltip, and a group per depth', async () => {
    const { user } = setup();
    await open(user, 'ann', /Ann Admin/);
    const panel = await tablePrivileges(user);
    await user.click(within(panel).getByRole('radio', { name: 'Depth Matrix' }));
    const table = within(panel).getByRole('table', { name: 'Table privileges by depth' });
    const account = within(table).getAllByRole('row').find((r) => r.textContent?.includes('Account'))!;
    const groups = within(account).getAllByRole('group', { name: /privileges$/ });
    expect(groups.map((g) => g.getAttribute('aria-label'))).toEqual(['User privileges', 'Business Unit privileges', 'Parent: Child BU privileges', 'Organization privileges']);
    for (const g of groups) {
      const letters = [...g.querySelectorAll('button.letter')];
      expect(letters.map((l) => l.getAttribute('data-priv'))).toEqual(['Create', 'Read', 'Write', 'Delete', 'Append', 'AppendTo', 'Assign', 'Share']);
      for (const l of letters) {
        expect(l.getAttribute('data-state')).toMatch(/^(granted|covered|inactive|notApplicable|unknown)$/);
        expect(l.getAttribute('title')).toBeTruthy();
      }
    }
  });

  it('filters the tables by display or logical name', async () => {
    const { user } = setup();
    await open(user, 'ann', /Ann Admin/);
    const panel = await tablePrivileges(user);
    await user.type(within(panel).getByRole('searchbox', { name: 'Find a table' }), 'contoso_pro');
    const rows = within(within(panel).getByRole('table', { name: 'Table privileges by privilege' })).getAllByRole('row').slice(1);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.textContent).toContain('Contoso Project');
    expect(within(panel).getByText(/1 table with at least one grant/)).toBeTruthy();
  });

  it('marks partial data: cells that cannot be determined are unknown, never no grant', async () => {
    const { user } = setup();
    await open(user, 'pat', /Pat Partial/);
    const panel = await tablePrivileges(user);
    expect((await within(panel).findAllByRole('alert'))[0]?.textContent).toContain('Incomplete');
    expect(within(panel).getAllByRole('button', { name: /: Unknown$/ }).length).toBeGreaterThan(0);
    expect(within(panel).queryByRole('button', { name: /: No grant$/ })).toBeNull();
  });

  it('a failed read is an error with a retry, never an empty analysis', async () => {
    const base = new FixtureAccessReader();
    let calls = 0;
    const reader: AccessReader = { ...base, searchUsers: (q) => base.searchUsers(q), searchTeams: (q) => base.searchTeams(q), loadUserAccess: (id) => base.loadUserAccess(id), loadTeamAccess: (id) => base.loadTeamAccess(id), loadRoleGrants: async () => { calls++; return { status: 'error', errorClass: 'permission', message: 'Not allowed.' }; } };
    const { user } = setup(reader);
    await open(user, 'ann', /Ann Admin/);
    const panel = await tablePrivileges(user);
    expect((await within(panel).findByRole('alert')).textContent).toContain('could not be loaded: Not allowed.');
    await user.click(within(panel).getByRole('button', { name: 'Retry' }));
    expect(calls).toBe(2);
    expect(within(panel).queryByRole('table')).toBeNull();
  });
});

describe('Access Explorer: table privileges of a team', () => {
  it('shows what the team’s own roles grant and says it is not what its members effectively have', async () => {
    const { user } = setup();
    await open(user, 'contoso', /Contoso\s+default team/);
    const panel = await tablePrivileges(user);
    expect(within(panel).getByText(/not what its members effectively have/)).toBeTruthy();
    const table = await within(panel).findByRole('table', { name: 'Table privileges by privilege' });
    expect(within(table).getByRole('button', { name: 'Account: Read: User' })).toBeTruthy();
    await user.click(within(table).getByRole('button', { name: 'Account: Read: User' }));
    const sources = within(panel).getByRole('region', { name: 'Privilege sources' });
    expect(sources.textContent).toContain('Basic User');
    expect(sources.textContent).toContain('Removing this role would remove this privilege');
  });
});
