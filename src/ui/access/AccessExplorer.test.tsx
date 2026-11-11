import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { FixtureAccessReader } from '../../adapters/fixture/accessFixture';
import { FixtureReader } from '../../adapters/fixture/fixtureReader';
import type { AccessReader } from '../../ports/accessReader';
import { App } from '../App';
import { AccessExplorerModule } from './AccessExplorerModule';

const setup = (reader: AccessReader = new FixtureAccessReader()) => ({
  user: userEvent.setup(),
  ...render(<AccessExplorerModule reader={reader} debounceMs={0} />),
});

async function search(user: ReturnType<typeof userEvent.setup>, text: string) {
  await user.type(screen.getByRole('searchbox', { name: 'Search users and teams' }), text);
  await screen.findByText(/found\./);
}

describe('Access Explorer', () => {
  it('searches users and teams, labels disabled and application users', async () => {
    const { user } = setup();
    expect(screen.getByText('Nothing searched yet.')).toBeTruthy();
    await search(user, 'fi');
    const users = screen.getByRole('list', { name: 'User results' });
    expect(within(users).getByText('Finn Fox')).toBeTruthy();
    expect(within(users).getByText('disabled')).toBeTruthy();
    await user.clear(screen.getByRole('searchbox', { name: 'Search users and teams' }));
    await user.type(screen.getByRole('searchbox', { name: 'Search users and teams' }), 'svc');
    expect(await within(await screen.findByRole('list', { name: 'User results' })).findByText('application user')).toBeTruthy();
  });

  it('shows hint for too-short text and empty results', async () => {
    const { user } = setup();
    await user.type(screen.getByRole('searchbox', { name: 'Search users and teams' }), 'a');
    expect(screen.getByText(/at least 2 characters are needed/)).toBeTruthy();
    await user.type(screen.getByRole('searchbox', { name: 'Search users and teams' }), 'zzz');
    expect(await screen.findByText('No users match this search.')).toBeTruthy();
    expect(screen.getByText('No teams match this search.')).toBeTruthy();
  });

  it('shows direct roles, team roles grouped by team with the origin text, business unit and the scope notice', async () => {
    const { user } = setup();
    await search(user, 'ann');
    await user.click(screen.getByRole('button', { name: /Ann Admin/ }));
    const detail = await screen.findByRole('article', { name: 'Access of Ann Admin' });
    expect(within(detail).getByText(/Business unit: Contoso/)).toBeTruthy();
    expect(within(detail).getByText(/record sharing/)).toBeTruthy();
    const direct = within(detail).getByRole('region', { name: 'Direct roles' });
    expect(within(direct).getByText('System Administrator')).toBeTruthy();
    expect(within(direct).getAllByText('Origin: direct')).toHaveLength(2);
    const viaTeams = within(detail).getByRole('region', { name: 'Team-derived roles' });
    expect(within(viaTeams).getByText('Default team of Contoso')).toBeTruthy();
    expect(within(viaTeams).getByText('Origin: via the default team of Contoso')).toBeTruthy();
    expect(within(viaTeams).getByText('Origin: via owner team Project Delivery in Contoso')).toBeTruthy();
    // The access team the user belongs to carries no role and is not shown as a source of roles.
    expect(within(viaTeams).queryByText(/Reviewers/)).toBeNull();
    expect(within(detail).queryByText(/Incomplete data/)).toBeNull();
  });

  it('shows partial data as incomplete, not as no access', async () => {
    const { user } = setup();
    await search(user, 'pat');
    await user.click(screen.getByRole('button', { name: /Pat Partial/ }));
    const detail = await screen.findByRole('article', { name: 'Access of Pat Partial' });
    const alert = within(detail).getByRole('alert');
    expect(alert.textContent).toContain('Incomplete data');
    expect(alert.textContent).toContain('t-unread');
    expect(within(detail).getByText('Origin: via the default team of Contoso')).toBeTruthy();
  });

  it('an empty list under a read gap says it is not proof of no roles', async () => {
    const base = new FixtureAccessReader();
    const reader: AccessReader = {
      ...base,
      searchUsers: (q) => base.searchUsers(q),
      searchTeams: (q) => base.searchTeams(q),
      loadTeamAccess: (id) => base.loadTeamAccess(id),
      loadUserAccess: async (id) => {
        const r = await base.loadUserAccess('u-svc');
        if (r.status === 'error') return r;
        return { status: 'partial', data: { ...r.data, user: { ...r.data.user, id }, directRoles: [], teamRoles: [], isComplete: false, warnings: ['Data gap: direct role assignments could not be read (permission).'] }, notes: ['x'] };
      },
    };
    const { user } = setup(reader);
    await search(user, 'svc');
    await user.click(screen.getByRole('button', { name: /Svc Integration/ }));
    const direct = await screen.findByRole('region', { name: 'Direct roles' });
    expect(direct.textContent).toContain('does not mean there are none');
    expect(direct.textContent).not.toContain('No roles are assigned directly');
  });

  it('shows a loading state and an error with retry', async () => {
    let fail = true;
    const base = new FixtureAccessReader();
    const reader: AccessReader = {
      searchUsers: (q) => base.searchUsers(q),
      searchTeams: (q) => base.searchTeams(q),
      loadTeamAccess: (id) => base.loadTeamAccess(id),
      loadUserAccess: async (id) => (fail ? { status: 'error', errorClass: 'permission', message: 'The signed-in user is not allowed to read this data.' } : base.loadUserAccess(id)),
    };
    const { user } = setup(reader);
    await search(user, 'ann');
    await user.click(screen.getByRole('button', { name: /Ann Admin/ }));
    expect((await screen.findByRole('alert')).textContent).toContain('not allowed to read');
    fail = false;
    await user.click(screen.getByRole('button', { name: 'Retry' }));
    expect(await screen.findByRole('article', { name: 'Access of Ann Admin' })).toBeTruthy();
  });

  it('shows a search failure with retry, and a partial search note', async () => {
    const base = new FixtureAccessReader();
    const reader: AccessReader = {
      ...base,
      searchUsers: async () => ({ status: 'error', errorClass: 'network', message: 'The environment could not be reached.' }),
      searchTeams: async () => ({ status: 'partial', data: [], notes: ['Only the first 50 matches are shown.'] }),
      loadUserAccess: (id) => base.loadUserAccess(id),
      loadTeamAccess: (id) => base.loadTeamAccess(id),
    };
    const { user } = setup(reader);
    await user.type(screen.getByRole('searchbox', { name: 'Search users and teams' }), 'ann');
    expect((await screen.findByRole('alert')).textContent).toContain('could not be reached');
    expect(screen.getByRole('button', { name: 'Retry' })).toBeTruthy();
    expect(screen.getByRole('note').textContent).toContain('Incomplete: Only the first 50');
  });

  it('opens a team, lists roles and members, and a member opens that user', async () => {
    const { user } = setup();
    await search(user, 'delivery');
    await user.click(screen.getByRole('button', { name: /Project Delivery/ }));
    const team = await screen.findByRole('article', { name: 'Team Project Delivery' });
    expect(within(team).getByRole('region', { name: 'Team roles' }).textContent).toContain('Project Contributor');
    await user.click(within(team).getByRole('button', { name: /Cara Cole/ }));
    expect(await screen.findByRole('article', { name: 'Access of Cara Cole' })).toBeTruthy();
  });

  it('says access teams carry no roles', async () => {
    const { user } = setup();
    await search(user, 'review');
    await user.click(screen.getByRole('button', { name: /Reviewers/ }));
    expect(await screen.findByText('Access teams carry no security roles.')).toBeTruthy();
  });

  it('compares two users from the result list', async () => {
    const { user } = setup();
    await search(user, 'example.test');
    await user.click(screen.getByRole('button', { name: /Ann Admin/ }));
    await screen.findByRole('article', { name: 'Access of Ann Admin' });
    await user.selectOptions(screen.getByRole('combobox', { name: /Compare Ann Admin with/ }), 'Ben Brooks');
    expect(await screen.findByRole('heading', { name: 'Only Ann Admin' })).toBeTruthy();
    expect(screen.getByRole('heading', { name: 'Only Ben Brooks' })).toBeTruthy();
    expect(screen.getByRole('heading', { name: 'Both hold' })).toBeTruthy();
  });

  it('is operable from the keyboard: type, tab to a result, Enter selects it', async () => {
    const { user } = setup();
    await search(user, 'cara');
    // The All/Users/Teams filter comes first in the tab order; the result follows it.
    for (let i = 0; i < 6 && !document.activeElement?.textContent?.includes('Cara Cole'); i++) await user.tab();
    expect(document.activeElement?.textContent).toContain('Cara Cole');
    await user.keyboard('{Enter}');
    expect(await screen.findByRole('article', { name: 'Access of Cara Cole' })).toBeTruthy();
  });

  it('filters the results to Users or Teams without losing the search', async () => {
    const { user } = setup();
    await search(user, 'co');
    expect(screen.getByRole('list', { name: 'User results' })).toBeTruthy();
    expect(screen.getByRole('list', { name: 'Team results' })).toBeTruthy();
    await user.click(screen.getByRole('button', { name: /^Teams/ }));
    expect(screen.queryByRole('list', { name: 'User results' })).toBeNull();
    expect(screen.getByRole('list', { name: 'Team results' })).toBeTruthy();
    expect(screen.getByRole('button', { name: /^Teams/ }).getAttribute('aria-pressed')).toBe('true');
    await user.click(screen.getByRole('button', { name: /^Users/ }));
    expect(screen.queryByRole('list', { name: 'Team results' })).toBeNull();
    expect((screen.getByRole('searchbox', { name: 'Search users and teams' }) as HTMLInputElement).value).toBe('co');
  });

  it('says once, in one short expandable line, that roles are not record-level access', async () => {
    const { user } = setup();
    await search(user, 'ann');
    await user.click(screen.getByRole('button', { name: /Ann Admin/ }));
    const detail = await screen.findByRole('article', { name: 'Access of Ann Admin' });
    expect(within(detail).getAllByText('Roles show privileges, not access to individual records.')).toHaveLength(1);
    expect(within(detail).getAllByRole('note').filter((n) => n.tagName === 'DETAILS')).toHaveLength(1);
  });

  it('announces counts in a live region and labels the search input', async () => {
    const { user } = setup();
    await search(user, 'ann');
    expect(screen.getByRole('status').textContent).toBe('1 user and 0 teams found.');
    expect(screen.getByRole('search')).toBeTruthy();
  });
});

describe('Access Explorer in the app shell', () => {
  it('is registered as a module and uses clearly labelled synthetic data without a host', async () => {
    const user = userEvent.setup();
    render(<App reader={new FixtureReader()} />);
    await user.click(screen.getByRole('button', { name: 'Access Explorer' }));
    expect(await screen.findByText(/Demo data: fictional users/)).toBeTruthy();
    expect(screen.queryByText(/Planned, not implemented/)).toBeNull();
  });
});

describe('Access Explorer: the round refresh button next to the name', () => {
  it('reads the user again without hiding what is shown, and also reads the table privileges again', async () => {
    const reader = new FixtureAccessReader();
    const spy = vi.spyOn(reader, 'loadUserAccess');
    const user = userEvent.setup();
    render(<AccessExplorerModule reader={reader} debounceMs={0} />);
    await user.type(screen.getByRole('searchbox', { name: 'Search users and teams' }), 'ann');
    await screen.findByText(/found\./);
    await user.click(screen.getByRole('button', { name: /Ann Admin/ }));
    const article = await screen.findByRole('article', { name: 'Access of Ann Admin' });
    expect(spy).toHaveBeenCalledTimes(1);
    const refresh = within(article).getByRole('button', { name: 'Refresh the access of Ann Admin' });
    await user.click(refresh);
    await vi.waitFor(() => expect(spy).toHaveBeenCalledTimes(2));
    // The view stays on screen while it reads: the heading is never replaced by "Loading access...".
    expect(screen.getByRole('article', { name: 'Access of Ann Admin' })).toBeTruthy();
    await vi.waitFor(() => expect((within(screen.getByRole('article', { name: 'Access of Ann Admin' })).getByRole('button', { name: 'Refresh the access of Ann Admin' }) as HTMLButtonElement).disabled).toBe(false));
  });

  it('on the Table privileges tab it reads the privileges of the roles again as well, and keeps the tab and the table view', async () => {
    const reader = new FixtureAccessReader();
    const spy = vi.spyOn(reader as Required<Pick<FixtureAccessReader, 'loadRoleGrants'>>, 'loadRoleGrants');
    const user = userEvent.setup();
    render(<AccessExplorerModule reader={reader} debounceMs={0} />);
    await user.type(screen.getByRole('searchbox', { name: 'Search users and teams' }), 'ann');
    await screen.findByText(/found\./);
    await user.click(screen.getByRole('button', { name: /Ann Admin/ }));
    await user.click(await screen.findByRole('button', { name: 'Table privileges' }));
    await screen.findByRole('table', { name: 'Table privileges by privilege' });
    expect(spy).toHaveBeenCalledTimes(1);
    await user.click(screen.getByRole('button', { name: 'Refresh the access of Ann Admin' }));
    await vi.waitFor(() => expect(spy).toHaveBeenCalledTimes(2));
    expect(await screen.findByRole('table', { name: 'Table privileges by privilege' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Table privileges' }).getAttribute('aria-pressed')).toBe('true');
  });

  it('reads the table privileges again only AFTER the refreshed access has arrived (never from the old snapshot)', async () => {
    const reader = new FixtureAccessReader();
    const grants = vi.spyOn(reader as Required<Pick<FixtureAccessReader, 'loadRoleGrants'>>, 'loadRoleGrants');
    const original = reader.loadUserAccess.bind(reader);
    let release: () => void = () => undefined;
    let calls = 0;
    vi.spyOn(reader, 'loadUserAccess').mockImplementation(async (id) => {
      if (++calls === 1) return original(id);
      await new Promise<void>((r) => { release = r; }); // the refreshed access is slow
      return original(id);
    });
    const user = userEvent.setup();
    render(<AccessExplorerModule reader={reader} debounceMs={0} />);
    await user.type(screen.getByRole('searchbox', { name: 'Search users and teams' }), 'ann');
    await screen.findByText(/found\./);
    await user.click(screen.getByRole('button', { name: /Ann Admin/ }));
    await user.click(await screen.findByRole('button', { name: 'Table privileges' }));
    await screen.findByRole('table', { name: 'Table privileges by privilege' });
    expect(grants).toHaveBeenCalledTimes(1);
    await user.click(screen.getByRole('button', { name: 'Refresh the access of Ann Admin' }));
    await vi.waitFor(() => expect(calls).toBe(2));
    expect(grants).toHaveBeenCalledTimes(1); // nothing is read from the old snapshot while the refreshed access is on its way
    release();
    await vi.waitFor(() => expect(grants).toHaveBeenCalledTimes(2));
  });

  it('is shown for a team as well, and reads the team again', async () => {
    const reader = new FixtureAccessReader();
    const spy = vi.spyOn(reader, 'loadTeamAccess');
    const user = userEvent.setup();
    render(<AccessExplorerModule reader={reader} debounceMs={0} />);
    await user.type(screen.getByRole('searchbox', { name: 'Search users and teams' }), 'delivery');
    await screen.findByText(/found\./);
    await user.click(screen.getByRole('button', { name: /Project Delivery/ }));
    const team = await screen.findByRole('article', { name: 'Team Project Delivery' });
    await user.click(within(team).getByRole('button', { name: 'Refresh the access of team Project Delivery' }));
    await vi.waitFor(() => expect(spy).toHaveBeenCalledTimes(2));
    expect(screen.getByRole('article', { name: 'Team Project Delivery' })).toBeTruthy();
  });
});
