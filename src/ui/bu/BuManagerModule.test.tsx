import { act, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { createFakeEnvironment, type FakeEnvironmentOptions } from '../../adapters/fixture/buManagerFixture';
import type { ConnectionState } from '../../adapters/pptb/connection';
import type { BuManagerReader } from '../../application/buManager/ports';
import { BuManagerModule } from './BuManagerModule';

type User = ReturnType<typeof userEvent.setup>;

const HOST = (name: string, url: string): ConnectionState => ({ kind: 'host', name, url, environmentType: 'Dev' });
const DEV = HOST('Dev', 'https://dev.example.test');

function setup(options: FakeEnvironmentOptions = {}, extra: { readonly connection?: ConnectionState; readonly withWriter?: boolean; readonly download?: (n: string, m: string, c: string) => void } = {}) {
  const env = createFakeEnvironment(options);
  const props = {
    reader: env.reader,
    connection: extra.connection ?? DEV,
    dataSource: 'live' as const,
    environmentId: 'env-1',
    ...(extra.withWriter === false ? {} : { writer: env.writer }),
    ...(extra.download ? { download: extra.download } : {}),
  };
  const user = userEvent.setup();
  const view = render(<BuManagerModule {...props} />);
  return { env, user, view, props };
}

async function addUser(user: User, query: string, name: string) {
  await user.clear(screen.getByRole('searchbox', { name: 'Search users by name or email' }));
  await user.type(screen.getByRole('searchbox', { name: 'Search users by name or email' }), query);
  await user.click(screen.getByRole('button', { name: 'Search' }));
  await user.click(await screen.findByRole('checkbox', { name: `Select ${name}` }));
}

const next = (user: User) => user.click(screen.getByRole('button', { name: 'Continue' }));

/** Steps 1 and 2 of the wizard: select the user and choose the target. Ends on step 3, which plans from a fresh read by itself. */
async function toMapping(user: User, who: readonly [string, string] = ['ben', 'Ben Brooks'], target = 'Contoso') {
  await addUser(user, who[0], who[1]);
  await next(user);
  await user.click(await screen.findByRole('radio', { name: new RegExp(`^${target}`) }));
  await next(user);
}

/** Ends on step 3 with the role mapping on screen. The recommended choice (assign the current direct roles, matched in the target) is preselected. */
async function compose(user: User, who: readonly [string, string] = ['ben', 'Ben Brooks'], target = 'Contoso') {
  await toMapping(user, who, target);
  await screen.findByRole('region', { name: 'Role mapping' });
}

/** Step 3 -> step 4: the review of the planned changes. */
async function preview(user: User) {
  await waitFor(() => expect((screen.getByRole('button', { name: 'Review changes' }) as HTMLButtonElement).disabled).toBe(false));
  await user.click(screen.getByRole('button', { name: 'Review changes' }));
  await screen.findByRole('region', { name: 'Review' });
}

async function confirmAll(user: User) {
  await user.click(screen.getByRole('button', { name: /Confirm and execute|Review and confirm/ }));
  const dialog = await screen.findByRole('dialog');
  await user.click(within(dialog).getByRole('checkbox'));
  await user.click(within(dialog).getByRole('button', { name: 'Confirm and move' }));
}

describe('BU Manager: demo mode', () => {
  it('previews with synthetic data and can never execute', async () => {
    const user = userEvent.setup();
    render(<BuManagerModule dataSource="synthetic" />);
    expect(screen.getByText(/Demo data: fictional users and business units/)).toBeTruthy();
    await compose(user);
    await preview(user);
    expect(screen.getByText(/Demo data: executing is not available/)).toBeTruthy();
    expect((screen.getByRole('button', { name: /Confirm and execute/ }) as HTMLButtonElement).disabled).toBe(true);
  });
});

describe('BU Manager: search, preview and confirmation', () => {
  it('shows what would happen, nothing is written by previewing, and the confirmation needs an acknowledgement', async () => {
    const { env, user } = setup();
    await compose(user);
    const plan = screen.getByRole('article', { name: 'Plan for Ben Brooks' });
    expect(within(plan).getByRole('heading').textContent).toContain('North → Contoso');
    expect(within(plan).getByText(/Will be assigned/)).toBeTruthy();
    expect(within(plan).getByRole('list', { name: 'Risks for Ben Brooks' })).toBeTruthy();
    expect(env.writes).toEqual([]);
    await preview(user);
    const review = screen.getByRole('article', { name: 'Review of Ben Brooks' });
    expect(within(review).getByRole('heading').textContent).toContain('North → Contoso');
    expect(env.writes).toEqual([]);

    await user.click(screen.getByRole('button', { name: /Confirm and execute \(2 changes\)/ }));
    const dialog = await screen.findByRole('dialog');
    const steps = within(dialog).getByRole('list', { name: 'Changes in the order they are applied' });
    expect(within(steps).getAllByRole('listitem').map((li) => li.textContent)).toEqual([expect.stringContaining('Move Ben Brooks'), expect.stringContaining('Assign role Project Contributor')]);
    expect((within(dialog).getByRole('button', { name: 'Confirm and move' }) as HTMLButtonElement).disabled).toBe(true);
    expect(env.writes).toEqual([]);
  });

  it('Cancel has the initial focus, Escape closes the dialog and nothing is sent', async () => {
    const { env, user } = setup();
    await compose(user);
    await preview(user);
    await user.click(screen.getByRole('button', { name: /Confirm and execute/ }));
    const dialog = await screen.findByRole('dialog');
    expect(document.activeElement).toBe(within(dialog).getByRole('button', { name: 'Cancel' }));
    await user.keyboard('{Escape}');
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(env.writes).toEqual([]);
  });

  it('moves the user, restores the role and shows every step as verified by a read', async () => {
    const { env, user } = setup();
    await compose(user);
    await preview(user);
    await confirmAll(user);
    const result = await screen.findByRole('region', { name: 'Move result' });
    expect(within(result).getByText(/Every step was applied and confirmed by reading the users again/)).toBeTruthy();
    const rows = within(within(result).getByRole('article', { name: 'Result for Ben Brooks' })).getAllByRole('row').slice(1);
    expect(rows).toHaveLength(2);
    for (const row of rows) expect(within(row).getByText(/Verified/)).toBeTruthy();
    expect(env.writes).toEqual(['moveUser:u-ben:bu-hq', 'assignRole:u-ben:r-contrib']);
  });

  it('exports CSV and JSON of the result without email addresses', async () => {
    const download = vi.fn();
    const { user } = setup({}, { download });
    await compose(user);
    await preview(user);
    await confirmAll(user);
    await screen.findByRole('region', { name: 'Move result' });
    await user.click(screen.getByRole('button', { name: 'Export CSV' }));
    await user.click(screen.getByRole('button', { name: 'Export JSON' }));
    expect(download).toHaveBeenCalledTimes(2);
    expect(download.mock.calls[0]?.[0]).toMatch(/\.csv$/);
    expect(download.mock.calls[1]?.[0]).toMatch(/\.json$/);
    for (const call of download.mock.calls) expect(String(call[2])).not.toMatch(/@example\.test/);
  });
});

describe('BU Manager: failures, reconciliation and retry', () => {
  it('an accepted request that changed nothing is shown as failed and never as success', async () => {
    const { user } = setup({ ignoreWrites: true });
    await compose(user);
    await preview(user);
    await confirmAll(user);
    const result = await screen.findByRole('region', { name: 'Move result' });
    expect(within(result).getByRole('alert').textContent).toContain('Failed');
    expect(within(result).queryByText(/Every step was applied/)).toBeNull();
    expect(within(result).getByText(/the re-read does not show the target business unit/)).toBeTruthy();
  });

  it('a failed role step keeps the verified move, reconciles by reading and offers a safe retry that must be confirmed again', async () => {
    const { env, user } = setup({ failWrite: { kind: 'assignRole', nth: 1, result: { outcome: 'failed', failure: 'throttling', message: 'Dataverse is throttling requests.' } } });
    await compose(user);
    await preview(user);
    await confirmAll(user);
    const result = await screen.findByRole('region', { name: 'Move result' });
    expect(within(result).getByRole('alert').textContent).toContain('Partly applied');
    expect(env.writes).toEqual(['moveUser:u-ben:bu-hq', 'assignRole:u-ben:r-contrib']);

    await user.click(within(result).getByRole('button', { name: 'Reconcile (read again)' }));
    const candidates = await within(result).findByRole('list', { name: 'Retry candidates' });
    expect(candidates.textContent).toContain('Ben Brooks');

    await user.click(within(result).getByRole('button', { name: /Plan a retry for 1 user/ }));
    await screen.findByRole('region', { name: 'Preview' });
    // Only the role that a read proved missing is planned; the verified move is not sent again, and nothing was sent yet.
    expect(env.writes).toHaveLength(2);
    expect(screen.getByRole('button', { name: /Review and confirm \(1 change\)/ })).toBeTruthy();
    await confirmAll(user);
    await screen.findByText(/Every step was applied and confirmed/);
    expect(env.writes.slice(2)).toEqual(['assignRole:u-ben:r-contrib']);
  });

  it('a user the planner blocks is excluded and explained, so nothing is sent for them', async () => {
    const { env, user } = setup();
    await toMapping(user, ['pat', 'Pat Partial'], 'North');
    await screen.findByRole('region', { name: 'Role mapping' });
    // The user is excluded from the move and the wizard cannot go on to a review that sends nothing.
    expect((screen.getByRole('button', { name: 'Review changes' }) as HTMLButtonElement).disabled).toBe(true);
    expect(env.writes).toEqual([]);
  });
});

describe('BU Manager: stale connections and live mode', () => {
  it('discards an open preview when the active connection changes', async () => {
    const { env, user, view, props } = setup();
    await compose(user);
    view.rerender(<BuManagerModule {...props} connection={HOST('Other', 'https://other.example.test')} />);
    expect(await screen.findByText(/The active connection changed, so the preview was discarded/)).toBeTruthy();
    expect(screen.queryByRole('region', { name: 'Review' })).toBeNull();
    expect(env.writes).toEqual([]);
  });

  it('offers no execution without the approved writer', async () => {
    const { user } = setup({}, { withWriter: false });
    await compose(user);
    await preview(user);
    expect((screen.getByRole('button', { name: /Confirm and execute/ }) as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByText(/Executing is not available: this host does not provide the approved write path/)).toBeTruthy();
  });

  it('a failed live read is an error, never demo data', async () => {
    const broken: BuManagerReader = {
      searchUsers: async () => ({ status: 'error', errorClass: 'permission', message: 'The signed-in user is not allowed to read this data.' }),
      loadUserAccess: async () => ({ status: 'error', errorClass: 'unknown', message: 'x' }),
      listBusinessUnits: async () => ({ status: 'error', errorClass: 'network', message: 'The environment could not be reached.' }),
      findUsersByEmail: async () => ({ status: 'error', errorClass: 'unknown', message: 'x' }),
      loadPlanningData: async () => ({ status: 'error', errorClass: 'unknown', message: 'x' }),
    };
    const user = userEvent.setup();
    render(<BuManagerModule reader={broken} dataSource="live" connection={DEV} />);
    await user.type(screen.getByRole('searchbox'), 'ben');
    await user.click(screen.getByRole('button', { name: 'Search' }));
    expect((await screen.findAllByRole('alert')).some((a) => a.textContent?.includes('not allowed to read'))).toBe(true);
    expect(screen.queryByText('Ben Brooks')).toBeNull();
  });

  it('a failed business unit read is an error with a retry on the target step, never demo data', async () => {
    const env = createFakeEnvironment();
    const reader = Object.create(env.reader, {
      listBusinessUnits: { value: async () => ({ status: 'error', errorClass: 'network', message: 'The environment could not be reached.' }) },
    }) as BuManagerReader;
    const user = userEvent.setup();
    render(<BuManagerModule reader={reader} dataSource="live" connection={DEV} />);
    await addUser(user, 'ben', 'Ben Brooks');
    await next(user);
    expect((await screen.findAllByRole('alert')).some((a) => a.textContent?.includes('could not be reached'))).toBe(true);
    expect(screen.getByRole('button', { name: 'Retry' })).toBeTruthy();
    expect(screen.queryByRole('radio')).toBeNull();
  });
});

describe('BU Manager: import', () => {
  it('reads a pasted list, classifies each line, and adds only what is included and movable', async () => {
    const { user } = setup();
    await user.click(screen.getByLabelText('Or paste the list'));
    await user.paste('ben.brooks@example.test\nnobody@example.test\nnot-an-email\nben.brooks@example.test\nfinn.fox@example.test\n');
    await user.click(screen.getByRole('button', { name: 'Read list' }));
    const table = await screen.findByRole('table', { name: 'Lines of the imported list' });
    const rowOf = (text: string) => within(table).getAllByRole('row').find((r) => r.textContent?.includes(text));
    expect(within(rowOf('nobody@example.test')!).getByText('Not found')).toBeTruthy();
    expect(within(rowOf('not-an-email')!).getByText('Invalid')).toBeTruthy();
    expect(within(rowOf('finn.fox@example.test')!).getByText('Disabled user')).toBeTruthy();
    expect((within(rowOf('finn.fox@example.test')!).getByRole('checkbox') as HTMLInputElement).disabled).toBe(true);
    expect(screen.queryByRole('table', { name: 'Users' })).toBeNull(); // reading the file adds nothing

    await user.click(screen.getByRole('button', { name: 'Add 1 user to the move' }));
    const selected = await screen.findByRole('table', { name: 'Users' });
    expect(within(selected).getAllByRole('row')).toHaveLength(2); // header + the one user
    expect(within(selected).getByText('Ben Brooks')).toBeTruthy();
  });

  it('says so when the file has no usable address', async () => {
    const { user } = setup();
    await user.click(await screen.findByLabelText('Or paste the list'));
    await user.paste('hello\nworld');
    await user.click(screen.getByRole('button', { name: 'Read list' }));
    expect((await screen.findByRole('alert')).textContent).toContain('No valid email address');
  });
});

describe('BU Manager: keyboard', () => {
  it('searches with Enter and adds a user with the keyboard', async () => {
    const { user } = setup();
    await user.type(screen.getByRole('searchbox'), 'ben{Enter}');
    const box = (await screen.findByRole('checkbox', { name: 'Select Ben Brooks' })) as HTMLInputElement;
    box.focus();
    await user.keyboard(' ');
    expect(box.checked).toBe(true);
    expect(within(await screen.findByRole('table', { name: 'Users' })).getByText('Ben Brooks')).toBeTruthy();
  });
});

// ---- regression tests for the Codex review of #317

describe('BU Manager: the preview is bound to the real host connection fingerprint', () => {
  function liveSetup() {
    const env = createFakeEnvironment();
    const state = { fingerprint: 'conn-a|https://dev.example.test|1' };
    const props = { reader: env.reader, connection: DEV, dataSource: 'live' as const, environmentId: 'env-1', writer: env.writer, readFingerprint: async () => state.fingerprint };
    const user = userEvent.setup();
    render(<BuManagerModule {...props} />);
    return { env, state, user };
  }

  it('refuses to execute a preview when another connection (same name and URL) became active, and sends nothing', async () => {
    const { env, state, user } = liveSetup();
    await compose(user);
    await preview(user);
    await user.click(screen.getByRole('button', { name: /Confirm and execute/ }));
    const dialog = await screen.findByRole('dialog');
    await user.click(within(dialog).getByRole('checkbox'));
    state.fingerprint = 'conn-b|https://dev.example.test|2'; // same name and URL, different connection
    await user.click(within(dialog).getByRole('button', { name: 'Confirm and move' }));
    expect(await screen.findByText(/The active connection changed, so nothing was sent/)).toBeTruthy();
    expect(env.writes).toEqual([]);
    expect(screen.queryByRole('region', { name: 'Review' })).toBeNull();
  });

  it('discards an open preview as soon as the host connection changes (window focus), without any App-level prop change', async () => {
    const { env, state, user } = liveSetup();
    await compose(user);
    await preview(user);
    state.fingerprint = 'conn-b|https://dev.example.test|1';
    await act(async () => {
      window.dispatchEvent(new Event('focus'));
    });
    expect(await screen.findByText(/The active connection changed, so the preview was discarded/)).toBeTruthy();
    expect(screen.queryByRole('region', { name: 'Review' })).toBeNull();
    expect(env.writes).toEqual([]);
  });

  it('still executes when the fingerprint is unchanged', async () => {
    const { env, user } = liveSetup();
    await compose(user);
    await preview(user);
    await confirmAll(user);
    await screen.findByRole('region', { name: 'Move result' });
    expect(env.writes).toEqual([`moveUser:u-ben:bu-hq`, `assignRole:u-ben:r-contrib`]);
  });

  it('makes no preview when the connection cannot be read', async () => {
    const env = createFakeEnvironment();
    const user = userEvent.setup();
    render(<BuManagerModule reader={env.reader} connection={DEV} dataSource="live" environmentId="env-1" writer={env.writer} readFingerprint={async () => null} />);
    await toMapping(user);
    expect(await screen.findByText(/The active connection could not be read, so no preview was made/)).toBeTruthy();
    expect(screen.queryByRole('region', { name: 'Role mapping' })).toBeNull();
    expect((screen.getByRole('button', { name: 'Review changes' }) as HTMLButtonElement).disabled).toBe(true);
  });
});

describe('BU Manager: custom restore strategy and unverified privilege matches can be resolved in the UI', () => {
  it('offers a role picker for "Choose each role" and the chosen role reaches the plan', async () => {
    const { env, user } = setup();
    await compose(user);
    await user.click(screen.getByRole('radio', { name: /Choose each role/ }));
    const picker = await screen.findByLabelText('Role to assign for Project Contributor');
    expect((screen.getByRole('button', { name: 'Review changes' }) as HTMLButtonElement).disabled).toBe(true); // blocked until a role is chosen
    await user.selectOptions(picker, 'r-contrib');
    await preview(user);
    expect(screen.getByRole('button', { name: /Confirm and execute \(2 changes\)/ })).toBeTruthy();
    await confirmAll(user);
    await screen.findByRole('region', { name: 'Move result' });
    expect(env.writes).toEqual([`moveUser:u-ben:bu-hq`, `assignRole:u-ben:r-contrib`]);
  });

  it('keeps the full role picker after a selection: the person can switch to another role or clear the choice', async () => {
    const { user } = setup();
    await compose(user);
    await user.click(screen.getByRole('radio', { name: /Choose each role/ }));
    const first = await screen.findByLabelText('Role to assign for Project Contributor');
    const optionCount = (first as HTMLSelectElement).options.length;
    expect(optionCount).toBeGreaterThan(2);
    await user.selectOptions(first, 'r-contrib');
    await waitFor(() => expect((screen.getByRole('button', { name: 'Review changes' }) as HTMLButtonElement).disabled).toBe(false));
    const second = screen.getByLabelText('Role to assign for Project Contributor') as HTMLSelectElement;
    expect(second.options.length).toBe(optionCount); // still every role, not only the selected one
    await user.selectOptions(second, 'r-sales');
    await waitFor(() => expect((screen.getByLabelText('Role to assign for Project Contributor') as HTMLSelectElement).value).toBe('r-sales'));
    await user.selectOptions(screen.getByLabelText('Role to assign for Project Contributor'), '');
    await waitFor(() => expect((screen.getByLabelText('Role to assign for Project Contributor') as HTMLSelectElement).value).toBe(''));
    await waitFor(() => expect((screen.getByRole('button', { name: 'Review changes' }) as HTMLButtonElement).disabled).toBe(true));
  });

  it('shows an explicit acknowledgement for an incomplete privilege comparison even when no differences are visible', async () => {
    const env = createFakeEnvironment();
    const reader = Object.create(env.reader, {
      loadPlanningData: {
        value: async (...args: Parameters<BuManagerReader['loadPlanningData']>) => {
          const r = await env.reader.loadPlanningData(...args);
          return r.status === 'error' ? r : { ...r, data: { ...r.data, privilegesComplete: false } };
        },
      },
    }) as BuManagerReader;
    const user = userEvent.setup();
    render(<BuManagerModule reader={reader} connection={DEV} dataSource="live" environmentId="env-1" writer={env.writer} />);
    await compose(user);
    expect((screen.getByRole('button', { name: 'Review changes' }) as HTMLButtonElement).disabled).toBe(true); // blocked: privilegeDataIncomplete
    const ack = await screen.findByRole('checkbox', { name: /I accept this unverified match for Project Contributor/ });
    expect(screen.getByText(/Unverified match/)).toBeTruthy();
    await user.click(ack);
    await waitFor(() => expect((screen.getByRole('button', { name: 'Review changes' }) as HTMLButtonElement).disabled).toBe(false));
    expect((screen.getByRole('checkbox', { name: /I accept this unverified match/ }) as HTMLInputElement).checked).toBe(true);
  });
});
