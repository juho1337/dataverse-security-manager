import { act, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { FixtureReader } from '../adapters/fixture/fixtureReader';
import type { RoleFamily } from '../domain/access';
import type { ReadResult, SecurityDataReader } from '../ports/securityDataReader';
import { App } from './App';

type User = ReturnType<typeof userEvent.setup>;

const setup = (reader: SecurityDataReader = new FixtureReader()) => ({ user: userEvent.setup(), ...render(<App reader={reader} />) });

async function pickTable(user: User, search: string, optionName: RegExp) {
  const combo = await screen.findByRole('combobox');
  await user.click(combo);
  await user.type(combo, search);
  await user.click(await screen.findByRole('option', { name: optionName }));
  await screen.findByRole('treegrid');
}

const expandRole = async (user: User, name: string) => user.click(await screen.findByRole('button', { name: `Expand ${name}` }));

describe('role expansion: lazy loading and counts', () => {
  it('loads details only when a role is expanded, and only once', async () => {
    const reader = new FixtureReader();
    const spy = vi.spyOn(reader, 'loadRoleDetails');
    const { user } = setup(reader);
    await pickTable(user, 'contoso_project', /Contoso Project/);
    expect(spy).not.toHaveBeenCalled();
    await expandRole(user, 'Project Contributor');
    await screen.findByText(/Business Unit: North/);
    expect(spy).toHaveBeenCalledTimes(1);
    await user.click(screen.getByRole('button', { name: 'Collapse Project Contributor' }));
    expect(screen.queryByText(/Business Unit: North/)).toBeNull();
    await expandRole(user, 'Project Contributor');
    expect(await screen.findByText(/Business Unit: North/)).toBeTruthy();
    expect(spy).toHaveBeenCalledTimes(1);
  });

  it('shows users and teams as the collapsed count and the full split (users, teams, application users) once expanded', async () => {
    const { user } = setup();
    await pickTable(user, 'contoso_project', /Contoso Project/);
    expect(screen.getByText('5 unique users · 2 teams')).toBeTruthy();
    await expandRole(user, 'Project Contributor');
    expect((await screen.findAllByText('5 unique users · 3 direct · 2 teams (4 users from teams) · 1 application user · 1 disabled')).length).toBeGreaterThan(0);
    expect(document.body.textContent).not.toMatch(/assignment path/i);
  });

  it('always states that counts are role assignments, not complete effective access', async () => {
    const { user } = setup();
    await pickTable(user, 'contoso_project', /Contoso Project/);
    expect(screen.getAllByText(/Access teams and nested membership are not evaluated/).length).toBeGreaterThan(0);
  });
});

describe('role expansion: instances, users, teams and members', () => {
  it('lists each Business Unit copy by name with its holders and says where the copies differ (on the role, not per copy)', async () => {
    const { user } = setup();
    await pickTable(user, 'contoso_project', /Contoso Project/);
    expect(screen.getByText('Instances differ')).toBeTruthy();
    await expandRole(user, 'Project Contributor');
    expect(await screen.findByText(/The copies differ on: Delete\./)).toBeTruthy();
    expect(screen.queryAllByLabelText(/differs from another Business Unit copy/)).toHaveLength(0); // the copy rows carry no privilege cells
    expect(screen.getByText(/Business Unit: North/).closest('tr')?.textContent).toMatch(/\d+ unique users? · \d+ direct · \d+ teams?/);
  });

  it('shows direct users and teams in place with origin badges, and team members on demand', async () => {
    const { user } = setup();
    await pickTable(user, 'contoso_project', /Contoso Project/);
    await expandRole(user, 'Project Contributor');
    await user.click(await screen.findByRole('button', { name: 'Expand Contoso copy' }));

    const direct = await screen.findByRole('region', { name: /Direct users \(2\)/ });
    expect(within(direct).getByText('Ann Admin').parentElement?.textContent).toContain('Direct + via team');
    expect(within(direct).getByText('Cara Cole').parentElement?.textContent).toContain('Direct + via team');

    const teams = screen.getByRole('region', { name: /Teams \(2\)/ });
    expect(screen.queryByRole('list', { name: 'Members of Project Delivery' })).toBeNull();
    await user.click(within(teams).getByRole('button', { name: /Project Delivery/ }));
    const members = screen.getByRole('list', { name: 'Members of Project Delivery' });
    expect(within(members).getByText('Dan Dixon').parentElement?.textContent).toContain('Via team Project Delivery');
    expect(within(members).getByText('Svc Integration').parentElement?.textContent).toContain('Application user, not counted');
  });

  it('shows the counts of one instance separately from the whole role', async () => {
    const { user } = setup();
    await pickTable(user, 'contoso_project', /Contoso Project/);
    await expandRole(user, 'Project Contributor');
    await user.click(await screen.findByRole('button', { name: 'Expand Contoso copy' }));
    expect((await screen.findAllByText(/^4 unique users · \d+ direct · \d+ teams?/)).length).toBeGreaterThan(0);
  });

  it('opens the only copy of a role automatically', async () => {
    const { user } = setup();
    await pickTable(user, 'contoso_project', /Contoso Project/);
    await expandRole(user, 'Project Administrator');
    expect(await screen.findByRole('region', { name: /Direct users \(1\)/ })).toBeTruthy();
  });

  it('lists every member without truncation and filters without losing the expansion', async () => {
    class BigTeam extends FixtureReader {
      override async loadRoleDetails(table: string, root: string): Promise<ReadResult<RoleFamily>> {
        const r = await super.loadRoleDetails(table, root);
        if (r.status === 'error' || root !== 'r-admin') return r;
        const users = Array.from({ length: 60 }, (_, i) => ({ userId: `u${i}`, name: `Person ${String(i).padStart(2, '0')}`, status: 'Enabled' as const }));
        const [first, ...rest] = r.data.instances;
        if (!first) return r;
        return { ...r, data: { ...r.data, instances: [{ ...first, directUsers: users }, ...rest] } };
      }
    }
    const { user } = setup(new BigTeam());
    await pickTable(user, 'contoso_project', /Contoso Project/);
    await expandRole(user, 'Project Administrator');
    const direct = await screen.findByRole('region', { name: /Direct users \(60\)/ });
    expect(within(direct).getAllByRole('listitem')).toHaveLength(60);
    expect(screen.queryByText(/and \d+ others/i)).toBeNull();
    expect(screen.queryByRole('searchbox', { name: 'Filter people and teams' })).toBeNull(); // no filter: the lists are shown whole
  });
});

describe('role expansion: partial data and failures', () => {
  it('shows a partial banner and lower bounds, never a bare number, when memberships are incomplete', async () => {
    const { user } = setup();
    await pickTable(user, 'contoso_budget', /Contoso Budget/);
    expect(screen.getByText(/≥ 5 unique users/)).toBeTruthy();
    await expandRole(user, 'Project Contributor');
    const banner = await screen.findByText(/could not be read completely: a membership row refers to a user that was not read/);
    expect(banner.closest('[role="status"]')?.textContent).toContain('Counts are shown as lower bounds');
    expect(screen.getAllByText(/≥ 5 unique users/).length).toBeGreaterThan(0);
    expect(screen.getAllByText(/1 not read/).length).toBeGreaterThan(0);
  });

  it('shows an error with Retry when the details cannot be loaded, then recovers', async () => {
    let calls = 0;
    class Flaky extends FixtureReader {
      override async loadRoleDetails(table: string, root: string): Promise<ReadResult<RoleFamily>> {
        if (++calls === 1) return { status: 'error', errorClass: 'throttled', message: 'Too many requests' };
        return super.loadRoleDetails(table, root);
      }
    }
    const { user } = setup(new Flaky());
    await pickTable(user, 'contoso_project', /Contoso Project/);
    await expandRole(user, 'Project Administrator');
    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toContain('throttled');
    await user.click(within(alert).getByRole('button', { name: 'Retry' }));
    expect(await screen.findByRole('region', { name: /Direct users \(1\)/ })).toBeTruthy();
  });

  it('ignores an answer that arrives after another table was chosen', async () => {
    let release: () => void = () => undefined;
    class Late extends FixtureReader {
      override loadRoleDetails(table: string, root: string): Promise<ReadResult<RoleFamily>> {
        return new Promise((resolve) => {
          release = () => resolve(super.loadRoleDetails(table, root));
        });
      }
    }
    const { user } = setup(new Late());
    await pickTable(user, 'contoso_project', /Contoso Project/);
    await expandRole(user, 'Project Contributor');
    expect(await screen.findByText('Loading assignments…')).toBeTruthy();
    await pickTable(user, 'account', /^Account/);
    await act(async () => {
      release();
    });
    expect(screen.queryByText(/Business Unit: North/)).toBeNull();
    expect(screen.queryByText('Loading assignments…')).toBeNull();
    expect(screen.queryByRole('region', { name: /Direct users/ })).toBeNull();
  });
});

describe('role expansion: filters and keyboard', () => {
  it('keeps the expansion and the loaded details while the role search changes', async () => {
    const reader = new FixtureReader();
    const spy = vi.spyOn(reader, 'loadRoleDetails');
    const { user } = setup(reader);
    await pickTable(user, 'contoso_project', /Contoso Project/);
    await expandRole(user, 'Project Contributor');
    await screen.findByText(/Business Unit: North/);
    const search = screen.getByRole('searchbox', { name: 'Search roles' });
    await user.type(search, 'Reader');
    expect(screen.queryByText(/Business Unit: North/)).toBeNull();
    await user.clear(search);
    expect(await screen.findByText(/Business Unit: North/)).toBeTruthy();
    expect(spy).toHaveBeenCalledTimes(1);
    expect(screen.getByText(/Selected table:/)).toBeTruthy();
  });

  it('supports the treegrid keys: arrows expand, collapse and move; Enter and Space toggle; Home and End jump', async () => {
    const { user } = setup();
    await pickTable(user, 'contoso_project', /Contoso Project/);
    const row = screen.getByRole('row', { name: /Project Administrator/ });
    expect(row.getAttribute('aria-level')).toBe('1');
    act(() => row.focus());

    await user.keyboard('{ArrowRight}');
    await screen.findByText(/Business Unit: Contoso/);
    expect(row.getAttribute('aria-expanded')).toBe('true');

    await user.keyboard('{ArrowRight}'); // already open: moves to the first child (the instance row)
    const instance = document.activeElement as HTMLElement;
    expect(instance.textContent).toContain('Business Unit: Contoso');
    expect(instance.getAttribute('aria-level')).toBe('2');
    expect(instance.getAttribute('aria-expanded')).toBe('true');

    await user.keyboard('{ArrowLeft}'); // collapses the instance
    expect(instance.getAttribute('aria-expanded')).toBe('false');
    await user.keyboard('{ArrowLeft}'); // then moves to the parent role row
    expect(document.activeElement).toBe(row);
    await user.keyboard('{ArrowLeft}'); // then collapses it
    expect(row.getAttribute('aria-expanded')).toBe('false');

    await user.keyboard('{Enter}');
    expect(row.getAttribute('aria-expanded')).toBe('true');
    await user.keyboard(' ');
    expect(row.getAttribute('aria-expanded')).toBe('false');

    await user.keyboard('{End}');
    expect(document.activeElement?.textContent).toContain('Service Desk Agent');
    await user.keyboard('{Home}');
    expect(document.activeElement).toBe(row.parentElement?.querySelector('tr[tabindex]') ?? row);
  });

  it('keeps one tab stop for the whole grid (roving tabindex)', async () => {
    const { user } = setup();
    await pickTable(user, 'contoso_project', /Contoso Project/);
    const stops = screen.getAllByRole('row').filter((r) => r.getAttribute('tabindex') === '0');
    expect(stops).toHaveLength(1);
  });
});

describe('the total and the Refresh users button next to the table title', () => {
  it('shows "Users not loaded yet" at first and expanding a single role works exactly as before', async () => {
    const reader = new FixtureReader();
    const spy = vi.spyOn(reader, 'loadRoleDetails');
    const { user } = setup(reader);
    await pickTable(user, 'contoso_project', /Contoso Project/);
    expect(screen.getByText('Users not loaded yet')).toBeTruthy();
    expect(spy).not.toHaveBeenCalled();
    await expandRole(user, 'Project Contributor');
    await screen.findByText(/Business Unit: North/);
    expect(spy).toHaveBeenCalledTimes(1);
    expect(screen.getByText(/^Total: /).textContent).toMatch(/1 of \d+ roles read/);
  });

  it('Load users reads every listed role (one read each) and then shows the total over all of them', async () => {
    const reader = new FixtureReader();
    const spy = vi.spyOn(reader, 'loadRoleDetails');
    const { user } = setup(reader);
    await pickTable(user, 'contoso_project', /Contoso Project/);
    const listed = screen.getAllByRole('button', { name: /^Expand / }).length;
    await user.click(screen.getByRole('button', { name: 'Load users' }));
    await screen.findByText(/all \d+ roles? read/);
    expect(screen.getByRole('button', { name: 'Refresh users' })).toBeTruthy(); // once everything is read the button offers a re-read
    expect(spy).toHaveBeenCalledTimes(listed);
    const total = screen.getByText(/^Total: /).textContent ?? '';
    expect(total).toMatch(/unique users · \d+ direct · \d+ teams? \(\d+ users? from teams\) · \d+ application users?/);
    // Nothing is expanded by it: the roles still open by hand, from what was read.
    expect(screen.queryByText(/Business Unit: North/)).toBeNull();
    await expandRole(user, 'Project Contributor');
    expect(await screen.findByText(/Business Unit: North/)).toBeTruthy();
    expect(spy).toHaveBeenCalledTimes(listed);
  });

  it('pressing it again, when everything was read, reads the roles again', async () => {
    const reader = new FixtureReader();
    const spy = vi.spyOn(reader, 'loadRoleDetails');
    const { user } = setup(reader);
    await pickTable(user, 'contoso_project', /Contoso Project/);
    const listed = screen.getAllByRole('button', { name: /^Expand / }).length;
    await user.click(screen.getByRole('button', { name: 'Load users' }));
    await screen.findByText(/all \d+ roles? read/);
    await user.click(screen.getByRole('button', { name: 'Refresh users' }));
    await vi.waitFor(() => expect(spy).toHaveBeenCalledTimes(listed * 2));
    await screen.findByText(/all \d+ roles? read/);
  });
});

describe('the expand control next to a role', () => {
  it('is a labelled chevron button that says what it shows, keeps its accessible name and expanded state, and has no text glyph', async () => {
    const { user } = setup();
    await pickTable(user, 'contoso_project', /Contoso Project/);
    const open = await screen.findByRole('button', { name: 'Expand Project Contributor' });
    expect(open.getAttribute('title')).toBe('Show users and teams');
    expect(open.getAttribute('aria-expanded')).toBe('false');
    expect(open.textContent).toBe(''); // an icon, no ▸ character
    expect(open.querySelector('svg.icon')).not.toBeNull();
    await user.click(open);
    const close = await screen.findByRole('button', { name: 'Collapse Project Contributor' });
    expect(close.getAttribute('title')).toBe('Hide users and teams');
    expect(close.getAttribute('aria-expanded')).toBe('true');
  });
});
