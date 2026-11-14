import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { FixtureAccessReader, SYNTHETIC_ACCESS_SNAPSHOT } from '../../../adapters/fixture/accessFixture';
import type { SecurityDataWriter } from '../../../ports/securityDataWriter';
import { AccessExplorerModule } from '../AccessExplorerModule';

// Synthetic only. Ben (home North) and Cara (home Contoso) get a role of the North unit; the setting decides whether Cara may.

function setup(crossBu: boolean | null) {
  const held = new Set(SYNTHETIC_ACCESS_SNAPSHOT.directAssignments.map((a) => `${a.userId}|${a.roleId}`));
  const calls: string[] = [];
  const fresh = () =>
    new FixtureAccessReader({
      snapshot: {
        ...SYNTHETIC_ACCESS_SNAPSHOT,
        settings: { ...SYNTHETIC_ACCESS_SNAPSHOT.settings, enableOwnershipAcrossBusinessUnits: crossBu },
        directAssignments: [...held].map((k) => ({ userId: k.split('|')[0] as string, roleId: k.split('|')[1] as string })),
      },
    });
  const reader = {
    searchUsers: (q: string) => fresh().searchUsers(q),
    searchTeams: (q: string) => fresh().searchTeams(q),
    loadUserAccess: (id: string) => fresh().loadUserAccess(id),
    loadTeamAccess: (id: string) => fresh().loadTeamAccess(id),
    loadAssignmentContext: () => fresh().loadAssignmentContext(),
    listRolesOfBusinessUnit: (id: string) => fresh().listRolesOfBusinessUnit(id),
  };
  const writer: SecurityDataWriter = {
    addPrivilege: vi.fn(), removePrivilege: vi.fn(), moveUser: vi.fn(), unassignRole: vi.fn(),
    assignRole: async (_a, userId, roleId) => {
      calls.push(`${userId}|${roleId}`);
      held.add(`${userId}|${roleId}`);
      return { outcome: 'notVerified', message: 'Accepted.', failure: 'none' };
    },
  };
  const user = userEvent.setup();
  render(<AccessExplorerModule reader={reader} writer={writer} environmentId="env-1" environmentLabel="Test environment" debounceMs={0} />);
  return { user, calls };
}

async function chooseUsersAndRole(user: ReturnType<typeof userEvent.setup>) {
  await user.click(await screen.findByRole('button', { name: 'Assign roles to several users' }));
  for (const [q, name] of [['Ben', 'Ben Brooks'], ['Cara', 'Cara Cole']] as const) {
    const box = screen.getByLabelText('Search users');
    await user.clear(box);
    await user.type(box, q);
    await user.click(await screen.findByRole('button', { name: `Add ${name}` }));
  }
  await user.selectOptions(await screen.findByLabelText('Target business unit'), 'North');
  await user.click(await screen.findByRole('checkbox', { name: 'Sales Manager' }));
  await user.click(screen.getByRole('button', { name: 'Preview changes' }));
}

describe('bulk role assignment', () => {
  it('previews user, role and target unit, then applies and verifies each user', async () => {
    const { user, calls } = setup(true);
    await chooseUsersAndRole(user);
    const table = await screen.findByRole('table', { name: /Role assignments by user/ });
    const rows = within(table).getAllByRole('row').slice(1);
    expect(rows).toHaveLength(2);
    expect(rows[0]?.textContent).toContain('Ben Brooks');
    expect(rows[1]?.textContent).toContain('Cara Cole');
    expect(rows[1]?.textContent).toContain('Contoso'); // home unit
    expect(rows[1]?.textContent).toContain('North'); // the role's unit
    expect(calls).toEqual([]); // nothing is written by previewing
    await user.click(screen.getByRole('button', { name: 'Confirm and apply' }));
    await waitFor(() => expect(screen.getByText('All changes verified.')).toBeTruthy());
    expect(calls).toEqual(['u-ben|r-sales', 'u-cara|r-sales']);
  });

  it('does not send a user of another unit when assignment across units is off', async () => {
    const { user, calls } = setup(false);
    await chooseUsersAndRole(user);
    const table = await screen.findByRole('table', { name: /Role assignments by user/ });
    expect(within(table).getAllByRole('row')[2]?.textContent).toContain('Not sent');
    await user.click(screen.getByRole('button', { name: 'Confirm and apply' }));
    await waitFor(() => expect(screen.getByText('All changes verified.')).toBeTruthy());
    expect(calls).toEqual(['u-ben|r-sales']);
  });

  it('offers no write when the setting could not be read: the other unit’s user is not sent', async () => {
    const { user, calls } = setup(null);
    await chooseUsersAndRole(user);
    const table = await screen.findByRole('table', { name: /Role assignments by user/ });
    expect(within(table).getAllByRole('row')[2]?.textContent).toContain('could not be read');
    expect(calls).toEqual([]);
  });
});

describe('bulk result honesty', () => {
  it('names the refused user in the result instead of claiming every user holds the roles', async () => {
    const { user } = setup(false);
    await chooseUsersAndRole(user);
    await user.click(await screen.findByRole('button', { name: 'Confirm and apply' }));
    await waitFor(() => expect(screen.getByText('Every assignment that was sent was read back and confirmed.', { exact: false })).toBeTruthy());
    const table = screen.getByRole('table', { name: 'Result for each user' });
    const cara = within(table).getAllByRole('row')[2]?.textContent ?? '';
    expect(cara).toContain('Not sent');
    expect(cara).toContain('turned off');
  });
});

describe('bulk assignment context failure', () => {
  it('shows the error with a Retry that keeps the chosen users', async () => {
    let failures = 1;
    const base = new FixtureAccessReader({ snapshot: { ...SYNTHETIC_ACCESS_SNAPSHOT, settings: { ...SYNTHETIC_ACCESS_SNAPSHOT.settings, enableOwnershipAcrossBusinessUnits: true } } });
    const reader = {
      searchUsers: (q: string) => base.searchUsers(q),
      searchTeams: (q: string) => base.searchTeams(q),
      loadUserAccess: (id: string) => base.loadUserAccess(id),
      loadTeamAccess: (id: string) => base.loadTeamAccess(id),
      listRolesOfBusinessUnit: (id: string) => base.listRolesOfBusinessUnit(id),
      loadAssignmentContext: async () => (failures-- > 0 ? ({ status: 'error', errorClass: 'network', message: 'down.' } as const) : base.loadAssignmentContext()),
    };
    const writer = { addPrivilege: vi.fn(), removePrivilege: vi.fn(), moveUser: vi.fn(), unassignRole: vi.fn(), assignRole: vi.fn() } as unknown as SecurityDataWriter;
    const user = userEvent.setup();
    render(<AccessExplorerModule reader={reader} writer={writer} environmentId="env-1" environmentLabel="Test environment" debounceMs={0} />);
    await user.click(await screen.findByRole('button', { name: 'Assign roles to several users' }));
    const box = screen.getByLabelText('Search users');
    await user.type(box, 'Ben');
    await user.click(await screen.findByRole('button', { name: 'Add Ben Brooks' }));
    await user.click(await screen.findByRole('button', { name: 'Retry' }));
    await waitFor(() => expect(screen.getByLabelText('Target business unit')).toBeTruthy());
    expect(within(screen.getByRole('list', { name: 'Chosen users' })).getByText('Ben Brooks')).toBeTruthy();
    expect(screen.queryByText(/could not be loaded/)).toBeNull();
  });
});

describe('staged roles of another unit survive a tab change', () => {
  it('still previews the staged North role after Table privileges and back', async () => {
    const { user } = setup(true);
    await user.type(await screen.findByRole('searchbox', { name: 'Search users and teams' }), 'cara');
    await screen.findByText(/found\./);
    await user.click(screen.getByRole('button', { name: /Cara Cole/ }));
    const region = await screen.findByRole('region', { name: 'Change direct roles' });
    await user.click(within(region).getByRole('button', { name: 'Add roles' }));
    await user.selectOptions(await within(region).findByLabelText('Business unit'), 'bu-north');
    await user.click(await within(region).findByRole('checkbox', { name: 'Sales Manager' }));
    await user.click(screen.getByRole('button', { name: 'Table privileges' }));
    await user.click(screen.getByRole('button', { name: 'Security roles' }));
    await user.click(await screen.findByRole('button', { name: 'Preview changes' }));
    const dialog = await screen.findByRole('dialog');
    expect(dialog.textContent).toContain('Sales Manager');
    expect(dialog.textContent).toContain('North');
  });
});

describe('role cache keyed by the unit that produced it', () => {
  it('keeps the Contoso role staged after switching to North and back', async () => {
    const { user } = setup(true);
    await user.type(await screen.findByRole('searchbox', { name: 'Search users and teams' }), 'ben');
    await screen.findByText(/found\./);
    await user.click(screen.getByRole('button', { name: /Ben Brooks/ }));
    const region = await screen.findByRole('region', { name: 'Change direct roles' });
    await user.click(within(region).getByRole('button', { name: 'Add roles' }));
    const select = await within(region).findByLabelText('Business unit');
    await user.selectOptions(select, 'bu-hq');
    await user.click(await within(region).findByRole('checkbox', { name: 'System Administrator' }));
    await user.selectOptions(select, 'bu-north');
    await user.click(await within(region).findByRole('checkbox', { name: 'Sales Manager' }));
    await user.selectOptions(select, 'bu-hq'); // back at once: the picker may still hold North's answer for a moment
    await user.click(screen.getByRole('button', { name: 'Preview changes' }));
    const dialog = await screen.findByRole('dialog');
    expect(dialog.textContent).toContain('System Administrator');
    expect(dialog.textContent).toContain('Sales Manager');
    expect(dialog.textContent).not.toContain('not in the list of roles');
  });
});
