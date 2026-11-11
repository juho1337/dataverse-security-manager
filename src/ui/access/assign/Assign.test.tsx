import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { FixtureAccessReader, SYNTHETIC_ACCESS_SNAPSHOT } from '../../../adapters/fixture/accessFixture';
import type { OperationResult } from '../../../domain/operations';
import type { AccessReader } from '../../../ports/accessReader';
import type { SecurityDataWriter } from '../../../ports/securityDataWriter';
import { App } from '../../App';
import { DEFAULT_MODULES } from '../../modules';
import { AccessExplorerModule } from '../AccessExplorerModule';

// Synthetic data only. The reader reads the current (fake) assignments on every call, and the fake writer changes them, so what the screen
// shows after applying is what a fresh read found.

function environment(behaviour: { acceptOnly?: boolean; fail?: boolean } = {}) {
  const held = new Set(SYNTHETIC_ACCESS_SNAPSHOT.directAssignments.map((a) => `${a.userId}|${a.roleId}`));
  const calls: string[] = [];
  const fresh = () =>
    new FixtureAccessReader({
      snapshot: { ...SYNTHETIC_ACCESS_SNAPSHOT, directAssignments: [...held].map((k) => ({ userId: k.split('|')[0] as string, roleId: k.split('|')[1] as string })) },
    });
  const reader: AccessReader = {
    searchUsers: (q) => fresh().searchUsers(q),
    searchTeams: (q) => fresh().searchTeams(q),
    loadUserAccess: (id) => fresh().loadUserAccess(id),
    loadTeamAccess: (id) => fresh().loadTeamAccess(id),
    listRolesOfBusinessUnit: (id) => fresh().listRolesOfBusinessUnit(id),
  };
  const result = (): OperationResult =>
    behaviour.fail ? { outcome: 'failed', message: 'Dataverse refused the change.', failure: 'permission' } : { outcome: 'notVerified', message: 'Accepted.', failure: 'none' };
  const writer: SecurityDataWriter = {
    addPrivilege: vi.fn(),
    removePrivilege: vi.fn(),
    moveUser: vi.fn(),
    assignRole: async (_a, userId, roleId) => {
      calls.push(`assign:${userId}:${roleId}`);
      const r = result();
      if (r.outcome !== 'failed' && !behaviour.acceptOnly) held.add(`${userId}|${roleId}`);
      return r;
    },
    unassignRole: async (_a, userId, roleId) => {
      calls.push(`unassign:${userId}:${roleId}`);
      const r = result();
      if (r.outcome !== 'failed' && !behaviour.acceptOnly) held.delete(`${userId}|${roleId}`);
      return r;
    },
  };
  return { reader, writer, calls, held };
}

function setup(env = environment(), withWriter = true) {
  const user = userEvent.setup();
  render(
    <AccessExplorerModule
      reader={env.reader}
      debounceMs={0}
      {...(withWriter ? { writer: env.writer, environmentId: 'env-1', environmentLabel: 'Test environment (https://test.invalid)' } : {})}
    />,
  );
  return { user, env };
}

async function open(user: ReturnType<typeof userEvent.setup>, query: string, name: RegExp) {
  await user.type(screen.getByRole('searchbox', { name: 'Search users and teams' }), query);
  await screen.findByText(/found\./);
  await user.click(screen.getByRole('button', { name }));
  return screen.findByRole('region', { name: 'Change direct roles' }).catch(() => null);
}

const section = () => screen.getByRole('region', { name: 'Change direct roles' });

type U = ReturnType<typeof userEvent.setup>;

/** Opens the Add roles picker (once) and returns it. Choosing a role only stages it. */
async function openPicker(user: U) {
  const s = section();
  if (!within(s).queryByRole('region', { name: 'Add roles' })) await user.click(within(s).getByRole('button', { name: 'Add roles' }));
  return within(s).findByRole('region', { name: 'Add roles' });
}
async function pickerCheckbox(user: U, role: string) {
  const picker = await openPicker(user);
  return (await within(picker).findByRole('checkbox', { name: new RegExp('^' + role) })) as HTMLInputElement;
}
async function addRole(user: U, role: string) {
  await user.click(await pickerCheckbox(user, role));
}

describe('Access Explorer: direct role assignment', () => {
  it('offers no changes without an approved writer', async () => {
    const { user } = setup(environment(), false);
    await open(user, 'cara', /Cara Cole/);
    await screen.findByRole('article', { name: 'Access of Cara Cole' });
    expect(screen.queryByRole('region', { name: 'Change direct roles' })).toBeNull();
    expect(screen.getAllByText(/Read-only in this session/).length).toBeGreaterThan(0);
  });

  it('offers an Add roles picker with only the roles of the user’s own business unit, marks held roles, and states that roles are not record-level access', async () => {
    const { user } = setup();
    await open(user, 'cara', /Cara Cole/);
    await screen.findByRole('region', { name: 'Change direct roles' });
    expect(screen.queryByRole('region', { name: 'Add roles' })).toBeNull(); // nothing is listed until Add roles is pressed
    const picker = await openPicker(user);
    expect(within(picker).getByRole('checkbox', { name: /^Basic User/ })).toBeTruthy();
    expect(within(picker).getByRole('checkbox', { name: /^System Administrator/ })).toBeTruthy();
    expect(within(picker).queryByRole('checkbox', { name: /Sales Manager/ })).toBeNull(); // belongs to North
    const held = within(picker).getByRole('checkbox', { name: /^Project Contributor/ }) as HTMLInputElement;
    expect(held.disabled).toBe(true); // already assigned: shown, not assignable
    expect(within(picker).getByText('already assigned')).toBeTruthy();
    expect(screen.getByText(/does not grant or remove access to individual records/)).toBeTruthy();
    await user.type(within(picker).getByRole('searchbox', { name: 'Search roles' }), 'admin');
    expect(within(picker).queryByRole('checkbox', { name: /^Basic User/ })).toBeNull();
    expect(within(picker).getByRole('checkbox', { name: /^System Administrator/ })).toBeTruthy();
  });

  it('stages several roles in one pass and shows one combined preview; choosing writes nothing', async () => {
    const { user, env } = setup();
    await open(user, 'cara', /Cara Cole/);
    await addRole(user, 'System Administrator');
    await addRole(user, 'Basic User');
    expect(within(section()).getByText('2 changes staged. Nothing is saved until you preview and confirm.')).toBeTruthy();
    expect(env.calls).toEqual([]);
    await user.click(within(section()).getByRole('button', { name: 'Preview changes' }));
    const rows = within(within(screen.getByRole('dialog', { name: 'Review role changes' })).getByRole('table')).getAllByRole('row').slice(1);
    expect(rows).toHaveLength(2);
    expect(env.calls).toEqual([]);
  });

  it('works as a table: a click on the row chooses or releases the role, with the status in the row', async () => {
    const { user, env } = setup();
    await open(user, 'cara', /Cara Cole/);
    const picker = await openPicker(user);
    const table = within(picker).getByRole('table', { name: 'Roles of Contoso' });
    const box = within(table).getByRole('checkbox', { name: /^Basic User/ }) as HTMLInputElement;
    const row = box.closest('tr') as HTMLElement;
    expect(within(row).getByText('can be added')).toBeTruthy();
    await user.click(within(row).getByText('Basic User')); // the row, not the checkbox
    expect(box.checked).toBe(true);
    expect(within(row).getByText('will be added')).toBeTruthy();
    expect(within(section()).getByText(/1 change staged/)).toBeTruthy();
    await user.click(within(row).getByText('Basic User'));
    expect(box.checked).toBe(false);
    // an assigned role cannot be chosen by clicking its row either
    const held = within(table).getByRole('checkbox', { name: /^Project Contributor/ }) as HTMLInputElement;
    await user.click(within(held.closest('tr') as HTMLElement).getByText('Project Contributor'));
    expect(held.checked).toBe(true);
    expect(within(section()).getByText('No changes staged.')).toBeTruthy();
    expect(env.calls).toEqual([]);
  });

  it('puts Remove on each direct role row, explains why a team role has none, and keeps the staged removal visible', async () => {
    const { user } = setup();
    await open(user, 'ann', /Ann Admin/);
    const direct = await screen.findByRole('region', { name: 'Direct roles' });
    const rows = within(direct).getAllByRole('listitem');
    expect(rows.length).toBeGreaterThan(0);
    for (const row of rows) expect(within(row).getByRole('button', { name: /^Remove/ })).toBeTruthy();
    const viaTeams = screen.getByRole('region', { name: 'Team-derived roles' });
    expect(within(viaTeams).queryByRole('button', { name: /Remove/ })).toBeNull();
    expect(within(viaTeams).getAllByText(/Cannot be removed here: change the team's roles or its membership/).length).toBeGreaterThan(0);
    await user.click(within(rows[0]!).getByRole('button', { name: /^Remove/ }));
    expect(within(rows[0]!).getByText('will be removed')).toBeTruthy();
    expect(within(section()).getByText(/1 change staged/)).toBeTruthy();
    expect(screen.queryByRole('heading', { name: 'Remove a direct role' })).toBeNull();
  });

  it('previews exactly what will be sent, writes nothing on cancel or Escape, and traps focus in the dialog', async () => {
    const { user, env } = setup();
    await open(user, 'cara', /Cara Cole/);
    const s = await screen.findByRole('region', { name: 'Change direct roles' });
    await addRole(user, 'System Administrator');
    await user.click(screen.getByRole('button', { name: 'Remove Project Contributor' }));
    expect(within(s).getByText('2 changes staged. Nothing is saved until you preview and confirm.')).toBeTruthy();
    await user.click(within(s).getByRole('button', { name: 'Preview changes' }));
    const dialog = screen.getByRole('dialog', { name: 'Review role changes' });
    expect(within(dialog).getByText('Test environment (https://test.invalid)')).toBeTruthy();
    const rows = within(within(dialog).getByRole('table')).getAllByRole('row').slice(1);
    expect(rows.map((r) => r.textContent)).toEqual([
      expect.stringContaining('AddSystem AdministratorContoso'),
      expect.stringContaining('RemoveProject ContributorContoso'),
    ]);
    expect(within(dialog).getByText(/no automatic undo/)).toBeTruthy();
    // Cancel is focused first; Tab cycles inside; Escape cancels.
    const cancel = within(dialog).getByRole('button', { name: 'Cancel' });
    const confirm = within(dialog).getByRole('button', { name: 'Confirm and apply' });
    expect(document.activeElement).toBe(cancel);
    await user.tab({ shift: true });
    expect(document.activeElement).toBe(confirm);
    await user.tab();
    expect(document.activeElement).toBe(cancel);
    await user.keyboard('{Escape}');
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(document.activeElement).toBe(within(section()).getByRole('button', { name: 'Preview changes' })); // focus returns to the trigger
    expect(env.calls).toEqual([]);
    // Staged changes are kept after cancelling the preview.
    expect(within(section()).getByText(/2 changes staged/)).toBeTruthy();
  });

  it('applies after confirmation, verifies by a fresh read, reloads the user and keeps the search and the selection', async () => {
    const { user, env } = setup();
    await open(user, 'cara', /Cara Cole/);
    const s = await screen.findByRole('region', { name: 'Change direct roles' });
    await addRole(user, 'System Administrator');
    await user.click(screen.getByRole('button', { name: 'Remove Project Contributor' }));
    await user.click(within(s).getByRole('button', { name: 'Preview changes' }));
    await user.click(screen.getByRole('button', { name: 'Confirm and apply' }));
    const result = await screen.findByRole('region', { name: 'Role change result' });
    expect(env.calls).toEqual(['assign:u-cara:r-admin', 'unassign:u-cara:r-contrib']); // additions first
    expect(within(result).getByText(/Every change was applied and confirmed/)).toBeTruthy();
    expect(within(result).getAllByText('Verified')).toHaveLength(2); // both rows (the overall line reads "Verified.")
    expect(within(result).getAllByText('Assigned directly')).toHaveLength(1);
    expect(within(result).getAllByText('Not assigned directly')).toHaveLength(1);
    await user.click(within(result).getByRole('button', { name: 'Close and reload the user' }));
    const direct = await screen.findByRole('region', { name: 'Direct roles' });
    expect(await within(direct).findByText('System Administrator', { selector: 'strong' })).toBeTruthy();
    expect(within(direct).queryByText('Project Contributor')).toBeNull();
    // The search text, its results and the selected user survive the update.
    expect((screen.getByRole('searchbox', { name: 'Search users and teams' }) as HTMLInputElement).value).toBe('cara');
    expect(screen.getByRole('button', { name: /^Cara Cole/ }).getAttribute('aria-current')).toBe('true');
    expect(screen.getByRole('article', { name: 'Access of Cara Cole' })).toBeTruthy();
    expect(screen.queryByRole('region', { name: 'Role change result' })).toBeNull();
  });

  it('never shows verified when the request was accepted but a fresh read does not show the change', async () => {
    const { user, env } = setup(environment({ acceptOnly: true }));
    await open(user, 'cara', /Cara Cole/);
    const s = await screen.findByRole('region', { name: 'Change direct roles' });
    await addRole(user, 'Basic User');
    await user.click(within(s).getByRole('button', { name: 'Preview changes' }));
    await user.click(screen.getByRole('button', { name: 'Confirm and apply' }));
    const result = await screen.findByRole('region', { name: 'Role change result' });
    expect(env.calls).toHaveLength(1);
    expect(within(result).queryByText('Verified')).toBeNull();
    expect(within(result).getAllByText('Failed').length).toBeGreaterThan(0);
    expect(within(result).getByText(/does not show the role assigned/)).toBeTruthy();
    expect(within(result).getByRole('alert')).toBeTruthy();
  });

  it('shows a refused write as failed with the reason, and the rest as not attempted', async () => {
    const { user } = setup(environment({ fail: true }));
    await open(user, 'cara', /Cara Cole/);
    const s = await screen.findByRole('region', { name: 'Change direct roles' });
    await addRole(user, 'System Administrator');
    await user.click(screen.getByRole('button', { name: 'Remove Project Contributor' }));
    await user.click(within(s).getByRole('button', { name: 'Preview changes' }));
    await user.click(screen.getByRole('button', { name: 'Confirm and apply' }));
    const result = await screen.findByRole('region', { name: 'Role change result' });
    expect(within(result).getByText('Dataverse refused the change.')).toBeTruthy();
    expect(within(result).getByText('Not attempted')).toBeTruthy();
    expect(within(result).getByText(/No change was applied/)).toBeTruthy();
  });

  it('is operable from the keyboard and Discard clears staged changes without writing', async () => {
    const { user, env } = setup();
    await open(user, 'cara', /Cara Cole/);
    const s = section();
    const add = await pickerCheckbox(user, 'Basic User');
    add.focus();
    await user.keyboard(' ');
    expect(add.checked).toBe(true);
    expect(within(s).getByText(/1 change staged/)).toBeTruthy();
    await user.keyboard(' ');
    expect(add.checked).toBe(false);
    await user.keyboard(' ');
    await user.click(within(s).getByRole('button', { name: 'Discard' }));
    expect(within(s).getByText('No changes staged.')).toBeTruthy();
    expect((within(s).getByRole('button', { name: 'Preview changes' }) as HTMLButtonElement).disabled).toBe(true);
    expect(env.calls).toEqual([]);
  });

  it('offers removal but not assignment for a disabled user, and no changes at all when the access is incomplete', async () => {
    const { user } = setup();
    await open(user, 'finn', /Finn Fox/);
    const s = await screen.findByRole('region', { name: 'Change direct roles' });
    expect((await pickerCheckbox(user, 'Sales Manager')).disabled).toBe(true);
    expect(within(s).getByText(/This user is disabled/)).toBeTruthy();
    expect((screen.getByRole('button', { name: 'Remove Project Contributor' }) as HTMLButtonElement).disabled).toBe(false);
    await user.clear(screen.getByRole('searchbox', { name: 'Search users and teams' }));
    await user.type(screen.getByRole('searchbox', { name: 'Search users and teams' }), 'pat');
    await user.click(await screen.findByRole('button', { name: /Pat Partial/ }));
    await screen.findByRole('article', { name: 'Access of Pat Partial' });
    const p = section();
    expect(within(p).getByText(/not read completely/)).toBeTruthy();
    expect((screen.getByRole('button', { name: 'Remove Basic User' }) as HTMLButtonElement).disabled).toBe(true);
  });

  it('drops staged changes when another user is selected', async () => {
    const { user } = setup();
    await open(user, 'ex', /Cara Cole/);
    const s = await screen.findByRole('region', { name: 'Change direct roles' });
    await addRole(user, 'Basic User');
    expect(within(s).getByText(/1 change staged/)).toBeTruthy();
    await user.click(screen.getByRole('button', { name: /Ann Admin/ }));
    await screen.findByRole('article', { name: 'Access of Ann Admin' });
    expect(within(section()).getByText('No changes staged.')).toBeTruthy();
  });

  it('Cancel button also returns focus to the preview trigger', async () => {
    const { user } = setup();
    await open(user, 'cara', /Cara Cole/);
    const s = await screen.findByRole('region', { name: 'Change direct roles' });
    await addRole(user, 'System Administrator');
    await user.click(within(s).getByRole('button', { name: 'Preview changes' }));
    await user.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Cancel' }));
    expect(document.activeElement).toBe(within(section()).getByRole('button', { name: 'Preview changes' }));
  });

  it('an accepted assignment seen in an INCOMPLETE final read is not verified (regression)', async () => {
    const env = environment();
    const complete = env.reader.loadUserAccess;
    let afterWrite = false;
    env.writer.assignRole = async (_a, userId, roleId) => { env.held.add(`${userId}|${roleId}`); afterWrite = true; return { outcome: 'notVerified', message: 'Accepted.', failure: 'none' }; };
    env.reader.loadUserAccess = async (id) => {
      const r = await complete(id);
      return afterWrite && r.status === 'ok' ? ({ status: 'partial', data: { ...r.data, isComplete: false }, notes: ['Some assignments could not be read.'] } as unknown as typeof r) : r;
    };
    const { user } = setup(env);
    await open(user, 'cara', /Cara Cole/);
    const s = await screen.findByRole('region', { name: 'Change direct roles' });
    await addRole(user, 'System Administrator');
    await user.click(within(s).getByRole('button', { name: 'Preview changes' }));
    await user.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Confirm and apply' }));
    expect(await screen.findAllByText(/Accepted, not verified/)).not.toHaveLength(0);
    expect(screen.queryByText(/Every change was applied and confirmed/)).toBeNull();
  });

  it('keeps a running write and its result when the user switches screens (regression)', async () => {
    const env = environment();
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    env.writer.assignRole = async (_a, userId, roleId) => { await gate; env.held.add(`${userId}|${roleId}`); return { outcome: 'notVerified', message: 'Accepted.', failure: 'none' }; };
    const explorer = DEFAULT_MODULES.find((m) => m.id === 'explorer')!;
    expect(explorer.keepAlive).toBe(true);
    const user = userEvent.setup();
    render(
      <App
        reader={{} as never}
        modules={[
          { id: 'explorer', label: 'Access Explorer', keepAlive: explorer.keepAlive, render: () => <AccessExplorerModule reader={env.reader} debounceMs={0} writer={env.writer} environmentId="env-1" environmentLabel="Test environment (https://test.invalid)" /> },
          { id: 'other', label: 'Other', render: () => <p>other screen</p> },
        ]}
      />,
    );
    await open(user, 'cara', /Cara Cole/);
    const s = await screen.findByRole('region', { name: 'Change direct roles' });
    await addRole(user, 'System Administrator');
    await user.click(within(s).getByRole('button', { name: 'Preview changes' }));
    await user.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Confirm and apply' }));
    await user.click(screen.getByRole('button', { name: 'Other' }));
    expect(screen.getByText('other screen')).toBeTruthy();
    release();
    await user.click(screen.getByRole('button', { name: 'Access Explorer' }));
    expect(await screen.findAllByText(/Accepted, not verified|Verified/)).not.toHaveLength(0);
  });
});

describe('the role change result and the Add roles panel (presentation)', () => {
  it('the result comes into view, offers "Close and reload the user" at its top, and badges each outcome', async () => {
    const scroll = vi.fn();
    const original = HTMLElement.prototype.scrollIntoView;
    HTMLElement.prototype.scrollIntoView = scroll;
    try {
      const { user } = setup();
      await open(user, 'cara', /Cara Cole/);
      const s = await screen.findByRole('region', { name: 'Change direct roles' });
      await addRole(user, 'System Administrator');
      await user.click(within(s).getByRole('button', { name: 'Preview changes' }));
      const dialog = screen.getByRole('dialog', { name: 'Review role changes' });
      expect(within(dialog).getByText('Add').className).toContain('rd-verb-add'); // what the step does, as a coloured chip
      await user.click(within(dialog).getByRole('button', { name: 'Confirm and apply' }));
      const result = await screen.findByRole('region', { name: 'Role change result' });
      expect(scroll).toHaveBeenCalled(); // the result is drawn below the roles: it is brought into view
      const head = result.querySelector('.assign-result-head') as HTMLElement;
      expect(within(head).getByRole('button', { name: 'Close and reload the user' })).toBeTruthy(); // reachable without scrolling to the bottom
      expect(within(result).getAllByRole('button', { name: 'Close and reload the user' })).toHaveLength(1);
      expect(within(result).getAllByText('Verified').some((e) => e.className.includes('rp-badge-ok'))).toBe(true);
    } finally {
      HTMLElement.prototype.scrollIntoView = original;
    }
  });

  it('the role picker has a search field with an icon and marks a managed role', async () => {
    const { user } = setup();
    await open(user, 'cara', /Cara Cole/);
    await user.click(await screen.findByRole('button', { name: 'Add roles' }));
    const picker = await screen.findByRole('region', { name: 'Add roles' });
    expect(picker.querySelector('.search-field svg.icon')).not.toBeNull();
    expect(within(picker).getByRole('searchbox', { name: 'Search roles' })).toBeTruthy();
  });
});
