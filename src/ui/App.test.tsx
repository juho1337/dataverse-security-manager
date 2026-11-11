import type { DataSource } from '../app/dataSource';
import { act, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { FixtureReader } from '../adapters/fixture/fixtureReader';
import type { HostWindow } from '../adapters/pptb/connection';
import type { RoleMatrix, TableInfo } from '../domain/privileges';
import type { ReadResult, SecurityDataReader } from '../ports/securityDataReader';
import type { SecurityDataWriter } from '../ports/securityDataWriter';
import { App } from './App';
import { DEFAULT_MODULES, plannedModule } from './modules';

const setup = (reader: SecurityDataReader = new FixtureReader(), host?: HostWindow, dataSource?: DataSource) =>
  ({ user: userEvent.setup(), ...render(<App reader={reader} host={host} {...(dataSource ? { dataSource } : {})} />) });

async function pickTable(user: ReturnType<typeof userEvent.setup>, search: string, optionName: RegExp) {
  const combo = await screen.findByRole('combobox');
  await user.click(combo);
  await user.type(combo, search);
  await user.click(await screen.findByRole('option', { name: optionName }));
}

describe('Role Analyzer landing view', () => {
  it('opens on Role Analyzer with the table selector and an empty-selection hint', async () => {
    setup();
    expect(screen.getByRole('button', { name: 'Role Analyzer' })).toHaveProperty('ariaCurrent', 'page');
    expect(await screen.findByRole('combobox')).toBeTruthy();
    expect(screen.getByText(/Select a table to see which security roles/)).toBeTruthy();
  });

  it('shows a loading state while tables load', async () => {
    let release: (r: ReadResult<readonly TableInfo[]>) => void = () => undefined;
    const slow: SecurityDataReader = {
      listTables: () => new Promise((r) => { release = r; }),
      loadRoleMatrix: async () => ({ status: 'error', errorClass: 'unknown', message: 'unused' }),
      loadRoleDetails: async () => ({ status: 'error', errorClass: 'unknown', message: 'unused' }),
    };
    setup(slow);
    expect(screen.getByText('Loading tables…')).toBeTruthy();
    release({ status: 'ok', data: [] });
    expect(await screen.findByText(/No tables were returned/)).toBeTruthy();
  });

  it('shows an error with Retry when tables cannot be loaded, then recovers', async () => {
    let calls = 0;
    const flaky: SecurityDataReader = {
      listTables: async () => (++calls === 1 ? { status: 'error', errorClass: 'throttled', message: 'Too many requests' } : { status: 'ok', data: [{ logicalName: 'account', displayName: 'Account', supported: true }] }),
      loadRoleMatrix: async () => ({ status: 'error', errorClass: 'unknown', message: 'unused' }),
      loadRoleDetails: async () => ({ status: 'error', errorClass: 'unknown', message: 'unused' }),
    };
    const { user } = setup(flaky);
    expect((await screen.findByRole('alert')).textContent).toContain('throttled');
    await user.click(screen.getByRole('button', { name: 'Retry' }));
    await user.click(await screen.findByRole('combobox'));
    expect(await screen.findByRole('option', { name: /Account/ })).toBeTruthy();
  });
});

describe('table selection and filtering', () => {
  it('matches by display name and by logical name and shows both', async () => {
    const { user } = setup();
    const combo = await screen.findByRole('combobox');
    await user.click(combo);
    await user.type(combo, 'contoso_task');
    const opt = await screen.findByRole('option', { name: /Contoso Task/ });
    expect(opt.textContent).toContain('contoso_task');
    await user.clear(combo);
    await user.type(combo, 'Contoso Pro');
    expect(await screen.findByRole('option', { name: /Contoso Project/ })).toBeTruthy();
  });

  it('shows a no-results state with Clear search', async () => {
    const { user } = setup();
    const combo = await screen.findByRole('combobox');
    await user.type(combo, 'zzzz');
    expect(await screen.findByText(/No tables match/)).toBeTruthy();
    await user.click(screen.getByRole('button', { name: 'Clear search' }));
    expect(screen.queryByText(/No tables match/)).toBeNull();
  });

  it('hides unsupported tables by default and lists them disabled with a reason on request', async () => {
    const { user } = setup();
    const combo = await screen.findByRole('combobox');
    await user.click(combo);
    expect(screen.queryByRole('option', { name: /Audit Log/ })).toBeNull();
    await user.click(screen.getByRole('checkbox', { name: /Show unsupported tables/ }));
    const opt = await screen.findByRole('option', { name: /Audit Log/ });
    expect(opt.getAttribute('aria-disabled')).toBe('true');
    expect(opt.textContent).toContain('No security privileges defined');
    await user.click(opt);
    expect(screen.queryByText(/Selected table:/)).toBeNull();
  });

  it('selects a table with the keyboard', async () => {
    const { user } = setup();
    const combo = await screen.findByRole('combobox');
    await user.click(combo);
    await user.type(combo, 'contoso_project{ArrowDown}{Enter}');
    expect(await screen.findByText(/Selected table:/)).toBeTruthy();
  });

  it('closes the dropdown when focus leaves the selector (Tab) and on an outside click', async () => {
    const { user } = setup();
    await pickTable(user, 'contoso', /Contoso Project/);
    const combo = await screen.findByRole('combobox');
    await user.click(combo);
    expect(screen.queryByRole('listbox')).toBeTruthy();
    await user.tab();
    expect(screen.queryByRole('listbox')).toBeNull();
    await user.click(combo);
    expect(screen.queryByRole('listbox')).toBeTruthy();
    await user.click(document.body);
    expect(screen.queryByRole('listbox')).toBeNull();
    expect(screen.getByText(/Selected table:/)).toBeTruthy();
  });
});

describe('privilege matrix', () => {
  it('shows eight privilege columns and all depths and states as text', async () => {
    const { user } = setup();
    await pickTable(user, 'contoso_project', /Contoso Project/);
    const table = await screen.findByRole('treegrid');
    const headers = within(table).getAllByRole('columnheader').map((h) => h.textContent);
    expect(headers).toEqual(['Security role', 'Create', 'Read', 'Write', 'Delete', 'Append', 'Append To', 'Assign', 'Share']);
    const admin = within(table).getByRole('row', { name: /Project Administrator/ });
    expect(within(admin).getAllByText(/Organization/)).toHaveLength(8);
    const contributor = within(table).getByRole('row', { name: /Project Contributor/ });
    expect(contributor.textContent).toContain('Parent: Child BU');
    expect(contributor.textContent).toContain('Business Unit');
  });

  it('hides roles that grant nothing by default and lists them with Show all roles', async () => {
    const { user } = setup();
    await pickTable(user, 'contoso_project', /Contoso Project/);
    await screen.findByRole('treegrid');
    expect(screen.queryByText('Facilities Coordinator')).toBeNull();
    expect(screen.getByText(/1 role hidden/)).toBeTruthy();
    await user.click(screen.getByRole('checkbox', { name: 'Show all roles' }));
    expect(screen.getByText('Facilities Coordinator')).toBeTruthy();
  });

  it('keeps the selected table while the role search and the table search change', async () => {
    const { user } = setup();
    await pickTable(user, 'contoso_project', /Contoso Project/);
    await screen.findByRole('treegrid');
    await user.type(screen.getByRole('searchbox', { name: 'Search roles' }), 'reader');
    expect(screen.getByText(/Selected table:/).textContent).toContain('Contoso Project');
    expect(screen.queryByText('Project Administrator')).toBeNull();
    const combo = screen.getByRole('combobox');
    await user.type(combo, 'acc');
    expect(screen.getByText(/Selected table:/).textContent).toContain('Contoso Project');
    expect(screen.getByRole('treegrid')).toBeTruthy();
  });

  it('marks not-applicable privileges distinctly', async () => {
    const { user } = setup();
    await pickTable(user, 'contoso_task', /Contoso Task/);
    const admin = within(await screen.findByRole('treegrid')).getByRole('row', { name: /Project Administrator/ });
    expect(within(admin).getAllByText('n/a')).toHaveLength(2);
  });

  it('shows a partial-result banner and unknown cells that are not shown as None', async () => {
    const { user } = setup();
    await pickTable(user, 'contoso_budget', /Contoso Budget/);
    expect(await screen.findByText(/Partial result/)).toBeTruthy();
    const contributor = within(screen.getByRole('treegrid')).getByRole('row', { name: /Project Contributor/ });
    expect(within(contributor).getAllByText('Unknown').length).toBeGreaterThan(0);
    expect(within(contributor).queryByText('None')).toBeNull();
  });

  it('shows an error with Retry when roles cannot be loaded', async () => {
    const { user } = setup();
    await pickTable(user, 'contoso_archive', /Contoso Archive/);
    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toContain('Roles could not be loaded');
    expect(within(alert).getByRole('button', { name: 'Retry' })).toBeTruthy();
  });

  it('ignores a stale response when another table was chosen meanwhile', async () => {
    const releases = new Map<string, (r: ReadResult<RoleMatrix>) => void>();
    const tables: TableInfo[] = [
      { logicalName: 'a', displayName: 'Alpha', supported: true },
      { logicalName: 'b', displayName: 'Beta', supported: true },
    ];
    const reader: SecurityDataReader = {
      listTables: async () => ({ status: 'ok', data: tables }),
      loadRoleMatrix: (t) => new Promise((r) => releases.set(t, r)),
      loadRoleDetails: async () => ({ status: 'error', errorClass: 'unknown', message: 'unused' }),
    };
    const { user } = setup(reader);
    await pickTable(user, 'Alpha', /Alpha/);
    await pickTable(user, 'Beta', /Beta/);
    const rowsFor = (name: string): RoleMatrix => ({ table: tables.find((t) => t.displayName === name)!, roles: [] });
    await act(async () => releases.get('b')?.({ status: 'ok', data: rowsFor('Beta') }));
    expect(await screen.findByText(/Roles with privileges on Beta/)).toBeTruthy();
    // The older request for Alpha answers last; it must not replace the newer Beta result.
    await act(async () => releases.get('a')?.({ status: 'ok', data: rowsFor('Alpha') }));
    expect(screen.queryByText(/Roles with privileges on Alpha/)).toBeNull();
    expect(screen.getByText(/Roles with privileges on Beta/)).toBeTruthy();
  });
});

describe('environment indicator and navigation', () => {
  const fake = (conn: unknown): HostWindow => ({ toolboxAPI: { connections: { getActiveConnection: async () => conn as never } } });

  it('shows demo mode and the synthetic-data label without a host', async () => {
    setup();
    expect(await screen.findByText(/Demo mode/)).toBeTruthy();
    expect(screen.getByText(/Synthetic data \(not read from this environment\)/)).toBeTruthy();
  });

  it('shows the connected environment from the host and still labels data as synthetic', async () => {
    setup(new FixtureReader(), fake({ name: 'Dev org', url: 'https://example.crm4.dynamics.com', environment: 'Dev' }));
    expect(await screen.findByText(/Connected: Dev org \(https:\/\/example\.crm4\.dynamics\.com\) · Dev/)).toBeTruthy();
    expect(screen.getByText(/Synthetic data/)).toBeTruthy();
  });

  it('labels live data as live and does not claim it is synthetic', async () => {
    setup(new FixtureReader(), fake({ name: 'Dev org', url: 'https://example.crm4.dynamics.com', environment: 'Dev' }), 'live');
    expect(await screen.findByText(/Live Dataverse data · read mode/)).toBeTruthy();
    expect(screen.queryByText(/Synthetic data/)).toBeNull();
  });

  it('says editing is enabled when the app has an approved writer and an environment, and read mode when it has not', async () => {
    const writer = {} as SecurityDataWriter;
    const host = fake({ name: 'Dev org', url: 'https://example.crm4.dynamics.com', environment: 'Dev' });
    const { unmount } = render(<App reader={new FixtureReader()} host={host} dataSource="live" writer={writer} environmentId="env-1" />);
    expect(await screen.findByText(/editing enabled/)).toBeTruthy();
    expect(screen.queryByText(/read mode/)).toBeNull();
    unmount();
    render(<App reader={new FixtureReader()} host={host} dataSource="live" />);
    expect(await screen.findByText(/read mode/)).toBeTruthy();
  });

  it('gives every module a way to open another screen (the BU result offers Operations & History)', async () => {
    let received: ((id: string) => void) | undefined;
    const probe = { id: 'probe', label: 'Probe', render: (ctx: { openModule?: (id: string) => void }) => { received = ctx.openModule; return <p>probe</p>; } };
    render(<App reader={new FixtureReader()} modules={[probe as never, plannedModule('other', 'Other', 'later')]} />);
    expect(typeof received).toBe('function');
  });

  it('never labels synthetic data as live', async () => {
    setup(new FixtureReader(), undefined, 'synthetic');
    expect(await screen.findByText(/Synthetic data \(not read from this environment\)/)).toBeTruthy();
    expect(screen.queryByText(/Live Dataverse data/)).toBeNull();
  });

  it('shows Not connected when the host has no active connection', async () => {
    setup(new FixtureReader(), fake(null));
    expect(await screen.findByText(/Not connected/)).toBeTruthy();
  });

  it('shows connection unavailable when the host call fails', async () => {
    setup(new FixtureReader(), { toolboxAPI: { connections: { getActiveConnection: async () => { throw new Error('boom'); } } } });
    expect(await screen.findByText(/Connection unavailable/)).toBeTruthy();
  });

  it('shows the build stamp (version, commit, build time) so the loaded build can be checked', async () => {
    setup();
    await screen.findByRole('combobox');
    expect(screen.getByTestId('build-stamp').textContent).toMatch(/^v\d+\.\d+\.\d+ · \S+ · built \d{4}-\d{2}-\d{2} \d{2}:\d{2} UTC$/);
  });

  it('a planned module says it is planned and the analyzer can be returned to', async () => {
    const user = userEvent.setup();
    render(<App reader={new FixtureReader()} modules={[...DEFAULT_MODULES, plannedModule('later', 'Later Module', 'Not built yet.')]} />);
    await screen.findByRole('combobox');
    await user.click(screen.getByRole('button', { name: 'Later Module' }));
    expect(screen.getByText(/Planned, not implemented in this milestone/)).toBeTruthy();
    await user.click(screen.getByRole('button', { name: 'Role Analyzer' }));
    expect(await screen.findByRole('combobox')).toBeTruthy();
  });
});
