import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { FixtureReader } from '../../adapters/fixture/fixtureReader';
import type { OperationResult } from '../../domain/operations';
import { PRIVILEGE_IDS, type CellValue, type PrivilegeCells, type PrivilegeId, type RoleMatrix } from '../../domain/privileges';
import type { HeldDepth } from '../../domain/roleEditing';
import type { ReadResult, SecurityDataReader } from '../../ports/securityDataReader';
import type { SecurityDataWriter } from '../../ports/securityDataWriter';
import { App } from '../App';

type User = ReturnType<typeof userEvent.setup>;

const ENV = '00000000-0000-4000-8000-000000000002';
const ROLE_NAME = 'Project Contributor';
const ok: OperationResult = { outcome: 'notVerified', message: 'accepted', failure: 'none' };

/** The synthetic reader, with the effect of accepted writes applied to what it reads back (like Dataverse after a successful write). */
class LiveLikeReader implements SecurityDataReader {
  readonly base = new FixtureReader();
  readonly overrides = new Map<string, Partial<Record<PrivilegeId, HeldDepth>>>();
  matrixLoads = 0;
  /** Every read after the first fails (a role that cannot be read again after a write). */
  failLoads = false;
  /** While set, reads wait for it (a reload that is still running). */
  gate: Promise<void> | null = null;
  mutate?: (m: RoleMatrix) => RoleMatrix;
  listTables = () => this.base.listTables();
  loadRoleDetails = (t: string, r: string) => this.base.loadRoleDetails(t, r);
  async loadRoleMatrix(table: string): Promise<ReadResult<RoleMatrix>> {
    this.matrixLoads++;
    if (this.gate) await this.gate;
    if (this.failLoads) return { status: 'error', errorClass: 'network', message: 'down' };
    const r = await this.base.loadRoleMatrix(table);
    if (r.status === 'error') return r;
    const roles = r.data.roles.map((row) => {
      const o = this.overrides.get(row.roleId);
      if (!o) return row;
      const cells = { ...row.cells } as Record<PrivilegeId, CellValue>;
      for (const p of PRIVILEGE_IDS) {
        if (p in o) {
          const d = o[p];
          cells[p] = d ? { kind: 'depth', depth: d } : { kind: 'noGrant' };
        }
      }
      return { ...row, cells: cells as PrivilegeCells };
    });
    const data = { ...r.data, roles };
    return { ...r, data: this.mutate ? this.mutate(data) : data } as ReadResult<RoleMatrix>;
  }
}

function writerFor(reader: LiveLikeReader, behaviour: { failOn?: PrivilegeId; hold?: Promise<void>; unreadableAfterFail?: boolean } = {}) {
  const calls: string[] = [];
  const idOf = (priv: string) => PRIVILEGE_IDS.find((p) => priv.endsWith(`${PRIVILEGE_IDS.indexOf(p) + 1}`.padStart(12, '0'))) as PrivilegeId;
  const writer: SecurityDataWriter = {
    addPrivilege: vi.fn(async (_a, role, priv, depth) => {
      const p = idOf(priv);
      calls.push(`add ${p} ${depth}`);
      if (behaviour.hold) await behaviour.hold;
      if (behaviour.failOn === p && behaviour.unreadableAfterFail) reader.failLoads = true;
      if (behaviour.failOn === p) return { outcome: 'failed', message: 'Dataverse refused.', failure: 'permission' } as OperationResult;
      reader.overrides.set(role, { ...(reader.overrides.get(role) ?? {}), [p]: depth });
      return ok;
    }),
    removePrivilege: vi.fn(async (_a, role, priv) => {
      const p = idOf(priv);
      calls.push(`remove ${p}`);
      reader.overrides.set(role, { ...(reader.overrides.get(role) ?? {}), [p]: null });
      return ok;
    }),
    assignRole: vi.fn(), unassignRole: vi.fn(), moveUser: vi.fn(),
  };
  return { writer, calls };
}

function setup(reader: LiveLikeReader, writer: SecurityDataWriter | null) {
  return { user: userEvent.setup(), ...render(<App reader={reader} writer={writer} environmentId={ENV} dataSource="live" />) };
}

async function pickTable(user: User) {
  const combo = await screen.findByRole('combobox');
  await user.click(combo);
  await user.type(combo, 'contoso_project');
  await user.click(await screen.findByRole('option', { name: /Contoso Project/ }));
  await screen.findByRole('treegrid');
}

const contributorRow = (): HTMLElement => {
  const row = screen.getAllByRole('row').find((r) => within(r).queryByText(ROLE_NAME, { selector: '.role-name' }));
  if (!row) throw new Error('row not found');
  return row;
};
/** The four Read letters of the edited row, lowest depth first: User, Business Unit, Parent: Child BU, Organization. */
const readLetter = (index: number): HTMLElement => within(contributorRow()).getAllByRole('button', { name: /^Read:/ })[index] as HTMLElement;

/** Editing is always on: a click on a cell of an editable role starts it (there is no Edit button). */
const editCell = async () => (await waitFor(() => within(contributorRow()).getAllByRole('gridcell', { name: /^Read:/ })))[0] as HTMLElement;
const offersEditing = () => within(contributorRow()).queryAllByTitle('Click to edit this role').length > 0;
const depthSelect = (privilege: string) => screen.getByRole('combobox', { name: `${privilege} depth for ${ROLE_NAME}` });

async function startEditing(user: User) {
  await pickTable(user);
  await user.click(await editCell());
  await screen.findByRole('region', { name: 'Role editing' });
}

describe('editing is only offered with an approved writer', () => {
  it('shows no edit controls without a writer (demo mode or a host without the Dataverse API)', async () => {
    const { user } = setup(new LiveLikeReader(), null);
    await pickTable(user);
    expect(screen.queryAllByTitle('Click to edit this role')).toHaveLength(0);
    expect(screen.queryByText(/\(read-only\)/)).toBeNull();
  });

  it('offers editing with a writer', async () => {
    const reader = new LiveLikeReader();
    const { user } = setup(reader, writerFor(reader).writer);
    await pickTable(user);
    await editCell();
    expect(offersEditing()).toBe(true);
  });
});

describe('Privilege Matrix editing', () => {
  it('stages a change with before/after, writes nothing until the preview is confirmed, and verifies by re-reading', async () => {
    const reader = new LiveLikeReader();
    const { writer, calls } = writerFor(reader);
    const { user } = setup(reader, writer);
    await startEditing(user);

    await user.selectOptions(depthSelect('Read'), 'Organization');
    expect(calls).toEqual([]); // staging never writes
    const bar = screen.getByRole('region', { name: 'Role editing' });
    expect(within(bar).getByText(/1 change staged/)).toBeTruthy();
    expect(within(bar).getByRole('list', { name: 'Staged changes' }).textContent).toMatch(/Read: Parent: Child BU → Organization/);
    expect(screen.getByText(/^was /)).toBeTruthy();

    await user.click(screen.getByRole('button', { name: 'Preview changes' }));
    const dialog = await screen.findByRole('dialog', { name: 'Review changes' });
    expect(within(dialog).getByText(/will be sent to/)).toBeTruthy();
    expect(within(dialog).getByRole('row', { name: /Read/ })).toBeTruthy();
    expect(calls).toEqual([]); // the preview never writes

    await user.click(within(dialog).getByRole('button', { name: 'Confirm and apply' }));
    expect(await screen.findByText(/Verified\./)).toBeTruthy();
    expect(calls).toEqual(['add Read Global']);
    const result = screen.getByRole('region', { name: 'Edit result' });
    expect(within(result).getByText('Verified', { selector: 'strong' })).toBeTruthy();
  });

  it('Undo, Redo and Discard work, and Discard leaves the role untouched', async () => {
    const reader = new LiveLikeReader();
    const { writer, calls } = writerFor(reader);
    const { user } = setup(reader, writer);
    await startEditing(user);

    await user.selectOptions(depthSelect('Read'), 'Organization');
    expect(screen.getByText(/1 change staged/)).toBeTruthy();
    await user.click(screen.getByRole('button', { name: 'Undo' }));
    expect(screen.getByText('No changes staged.')).toBeTruthy();
    await user.click(screen.getByRole('button', { name: 'Redo' }));
    expect(screen.getByText(/1 change staged/)).toBeTruthy();
    await user.click(screen.getByRole('button', { name: 'Discard' }));
    expect(screen.queryByRole('region', { name: 'Role editing' })).toBeNull();
    expect(calls).toEqual([]);
    await editCell();
    expect(offersEditing()).toBe(true); // back to normal browsing
  });

  it('cancelling the preview returns to editing with the staged changes kept; Escape cancels too', async () => {
    const reader = new LiveLikeReader();
    const { user } = setup(reader, writerFor(reader).writer);
    await startEditing(user);
    await user.selectOptions(depthSelect('Read'), 'Organization');
    await user.click(screen.getByRole('button', { name: 'Preview changes' }));
    await user.click(await screen.findByRole('button', { name: 'Cancel' }));
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(screen.getByText(/1 change staged/)).toBeTruthy();
    await user.click(screen.getByRole('button', { name: 'Preview changes' }));
    await screen.findByRole('dialog');
    await user.keyboard('{Escape}');
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(screen.getByText(/1 change staged/)).toBeTruthy();
  });

  it('the preview opens with Cancel focused, so Enter cannot confirm by accident', async () => {
    const reader = new LiveLikeReader();
    const { writer, calls } = writerFor(reader);
    const { user } = setup(reader, writer);
    await startEditing(user);
    await user.selectOptions(depthSelect('Read'), 'Organization');
    await user.click(screen.getByRole('button', { name: 'Preview changes' }));
    const cancel = await screen.findByRole('button', { name: 'Cancel' });
    await waitFor(() => expect(document.activeElement).toBe(cancel));
    await user.keyboard('{Enter}');
    expect(calls).toEqual([]);
  });

  it('removes a privilege (Not held) and orders additions before the removal', async () => {
    const reader = new LiveLikeReader();
    const { writer, calls } = writerFor(reader);
    const { user } = setup(reader, writer);
    await startEditing(user);
    await user.selectOptions(depthSelect('Read'), 'Not held');
    await user.selectOptions(depthSelect('Delete'), 'Organization');
    await user.click(screen.getByRole('button', { name: 'Preview changes' }));
    const dialog = await screen.findByRole('dialog');
    const rows = within(dialog).getAllByRole('row').slice(1).map((r) => r.textContent ?? '');
    expect(rows[0]).toMatch(/Delete/);
    expect(rows[1]).toMatch(/Read/);
    await user.click(within(dialog).getByRole('button', { name: 'Confirm and apply' }));
    await screen.findByRole('region', { name: 'Edit result' });
    expect(calls).toEqual(['add Delete Global', 'remove Read']);
  });

  it('reports a failed change, the change that was not attempted, and does not claim success', async () => {
    const reader = new LiveLikeReader();
    const { writer } = writerFor(reader, { failOn: 'Delete' });
    const { user } = setup(reader, writer);
    await startEditing(user);
    await user.selectOptions(depthSelect('Delete'), 'Organization');
    await user.selectOptions(depthSelect('Read'), 'Not held');
    await user.click(screen.getByRole('button', { name: 'Preview changes' }));
    await user.click(within(await screen.findByRole('dialog')).getByRole('button', { name: 'Confirm and apply' }));
    const result = await screen.findByRole('region', { name: 'Edit result' });
    expect(within(result).getByRole('alert').textContent).toMatch(/No change was applied/);
    expect(within(result).getAllByText('Failed').length).toBeGreaterThan(0);
    expect(within(result).getByText('Not attempted')).toBeTruthy();
    expect(within(result).queryByText('Verified')).toBeNull();
  });

  it('keeps the selected table, the search and the expanded rows after the role is read again', async () => {
    const reader = new LiveLikeReader();
    const { writer } = writerFor(reader);
    const { user } = setup(reader, writer);
    await pickTable(user);
    await user.type(screen.getByLabelText('Search roles'), 'Project');
    await user.click(await screen.findByRole('button', { name: `Expand ${ROLE_NAME}` }));
    await screen.findByText(/Business Unit: North/);

    await user.click(await editCell());
    await user.selectOptions(depthSelect('Read'), 'Organization');
    await user.click(screen.getByRole('button', { name: 'Preview changes' }));
    await user.click(within(await screen.findByRole('dialog')).getByRole('button', { name: 'Confirm and apply' }));
    await screen.findByRole('region', { name: 'Edit result' });
    const loadsBefore = reader.matrixLoads;
    await user.click(screen.getByRole('button', { name: 'Close and reload the role' }));
    await waitFor(() => expect(reader.matrixLoads).toBeGreaterThan(loadsBefore));

    expect(screen.getByText(/Selected table:/).textContent).toContain('contoso_project');
    expect((screen.getByLabelText('Search roles') as HTMLInputElement).value).toBe('Project');
    expect(await screen.findByRole('button', { name: `Collapse ${ROLE_NAME}` })).toBeTruthy();
    expect(screen.getByText(/Business Unit: North/)).toBeTruthy();
  });
});

describe('review findings: apply across table changes, unreadable re-read, reload window', () => {
  it('keeps the result of a running apply when another table is selected, and draws no edit cells on the other table', async () => {
    const reader = new LiveLikeReader();
    let release: () => void = () => undefined;
    const hold = new Promise<void>((resolve) => { release = resolve; });
    const { writer, calls } = writerFor(reader, { hold });
    const { user } = setup(reader, writer);
    await startEditing(user);
    await user.selectOptions(depthSelect('Read'), 'Organization');
    await user.click(screen.getByRole('button', { name: 'Preview changes' }));
    await user.click(within(await screen.findByRole('dialog')).getByRole('button', { name: 'Confirm and apply' }));
    expect(await screen.findByText(/Applying changes/)).toBeTruthy();

    // Another table is selected while the apply is still running.
    const combo = screen.getAllByRole('combobox')[0] as HTMLElement;
    await user.click(combo);
    await user.type(combo, 'contoso_task');
    await user.click(await screen.findByRole('option', { name: /Contoso Task/ }));
    await waitFor(() => expect(screen.getByText(/Selected table:/).textContent).toContain('contoso_task'));
    expect(screen.queryAllByRole('combobox', { name: /depth for/ })).toHaveLength(0);
    expect(screen.queryAllByTitle('Click to edit this role')).toHaveLength(0); // no second operation over the running one

    release();
    const result = await screen.findByRole('region', { name: 'Edit result' });
    expect(result.textContent).toContain('contoso_project');
    expect(within(result).getByText('Verified', { selector: 'strong' })).toBeTruthy();
    expect(calls).toEqual(['add Read Global']);
  });

  it('shows Unknown, never "Not held", when a failed change cannot be re-read', async () => {
    const reader = new LiveLikeReader();
    const { writer } = writerFor(reader, { failOn: 'Delete', unreadableAfterFail: true });
    const { user } = setup(reader, writer);
    await startEditing(user);
    await user.selectOptions(depthSelect('Delete'), 'Organization');
    await user.click(screen.getByRole('button', { name: 'Preview changes' }));
    await user.click(within(await screen.findByRole('dialog')).getByRole('button', { name: 'Confirm and apply' }));
    const result = await screen.findByRole('region', { name: 'Edit result' });
    const row = within(result).getByRole('row', { name: /Delete/ });
    expect(row.textContent).toContain('Unknown (not read)');
    expect(within(result).getByRole('alert')).toBeTruthy();
  });

  it('offers no new edit until the reload after an apply has finished, so a new session never starts on the old values', async () => {
    const reader = new LiveLikeReader();
    const { writer } = writerFor(reader);
    const { user } = setup(reader, writer);
    await startEditing(user);
    await user.selectOptions(depthSelect('Read'), 'Organization');
    await user.click(screen.getByRole('button', { name: 'Preview changes' }));
    await user.click(within(await screen.findByRole('dialog')).getByRole('button', { name: 'Confirm and apply' }));
    await screen.findByRole('region', { name: 'Edit result' });

    let release: () => void = () => undefined;
    reader.gate = new Promise<void>((resolve) => { release = resolve; });
    await user.click(screen.getByRole('button', { name: 'Close and reload the role' }));
    await screen.findByText(/Reading the role again/);
    expect(offersEditing()).toBe(false);
    const row = contributorRow();
    row.focus();
    await user.keyboard('e');
    expect(screen.queryByRole('region', { name: 'Role editing' })).toBeNull();

    release();
    await user.click(await editCell());
    // The new session starts from the refreshed value: Organization is now the original, so choosing it again is no change.
    expect((depthSelect('Read') as HTMLSelectElement).value).toBe('Global');
    await user.selectOptions(depthSelect('Read'), 'User');
    expect(screen.getByText(/1 change staged/)).toBeTruthy();
  });
});

describe('Depth Matrix editing', () => {
  async function toDepthView(user: User) {
    await user.click(screen.getByRole('radio', { name: /Depth Matrix/ }));
  }

  it('chooses a depth by pressing a letter, shows it staged, and pressing the chosen depth again removes the privilege', async () => {
    const reader = new LiveLikeReader();
    const { writer, calls } = writerFor(reader);
    const { user } = setup(reader, writer);
    await pickTable(user);
    await toDepthView(user);

    await user.click(readLetter(3)); // Organization
    expect(readLetter(3).getAttribute('aria-pressed')).toBe('true');
    expect(readLetter(3).dataset.state).toBe('staged');
    expect(readLetter(2).getAttribute('aria-pressed')).toBe('false'); // Parent: Child BU is no longer the chosen depth
    expect(calls).toEqual([]);
    await user.click(readLetter(3)); // the same depth again: remove
    expect(screen.getByText(/Read: Parent: Child BU → Not held/)).toBeTruthy();
    expect(readLetter(3).getAttribute('aria-pressed')).toBe('false');
    expect(calls).toEqual([]);
  });

  it('clicking the depth a role already grants removes the grant on the FIRST click, also when no edit has started yet', async () => {
    const reader = new LiveLikeReader();
    const { writer, calls } = writerFor(reader);
    const { user } = setup(reader, writer);
    await pickTable(user);
    await toDepthView(user);
    await user.click(readLetter(2)); // Parent: Child BU is the granted depth of the Read privilege
    expect(await screen.findByRole('region', { name: 'Role editing' })).toBeTruthy();
    expect(screen.getByText(/Read: Parent: Child BU → Not held/)).toBeTruthy(); // staged at once, not a silent no-op
    expect(calls).toEqual([]);
  });

  it('shares the staged change with the Privilege Matrix (same session, same writer)', async () => {
    const reader = new LiveLikeReader();
    const { writer, calls } = writerFor(reader);
    const { user } = setup(reader, writer);
    await pickTable(user);
    await toDepthView(user);
    await user.click(readLetter(3));
    await user.click(screen.getByRole('radio', { name: /Privilege Matrix/ }));
    expect((depthSelect('Read') as HTMLSelectElement).value).toBe('Global');
    await user.click(screen.getByRole('button', { name: 'Preview changes' }));
    await user.click(within(await screen.findByRole('dialog')).getByRole('button', { name: 'Confirm and apply' }));
    await screen.findByRole('region', { name: 'Edit result' });
    expect(calls).toEqual(['add Read Global']);
  });

  it('letters can be reached and pressed with the keyboard', async () => {
    const reader = new LiveLikeReader();
    const { user } = setup(reader, writerFor(reader).writer);
    await pickTable(user);
    await toDepthView(user);
    readLetter(3).focus();
    await user.keyboard('{Enter}');
    expect(readLetter(3).getAttribute('aria-pressed')).toBe('true');
  });
});

describe('roles that must not be edited', () => {
  const withRow = (change: Partial<RoleMatrix['roles'][number]>) => {
    const reader = new LiveLikeReader();
    reader.mutate = (m) => ({ ...m, roles: m.roles.map((r) => (r.name === ROLE_NAME ? { ...r, ...change } : r)) });
    return reader;
  };

  it('keeps marking the roles that cannot be edited while another role is being edited', async () => {
    const reader = new LiveLikeReader();
    let other = '';
    reader.mutate = (m) => ({ ...m, roles: m.roles.map((r) => { if (r.name !== ROLE_NAME && other === '') other = r.name; return r.name === other ? { ...r, isManaged: true } : r; }) });
    const { user } = setup(reader, writerFor(reader).writer);
    await startEditing(user); // editing ROLE_NAME
    const otherRow = screen.getAllByRole('row').find((r) => within(r).queryByText(other, { selector: '.role-name' }));
    expect(otherRow).toBeTruthy();
    expect(within(otherRow as HTMLElement).getByText(/\(read-only\)/)).toBeTruthy(); // not only when the editor is idle
  });

  it.each([
    ['a managed role', { isManaged: true }, /managed/i],
    ['a Business Unit copy', { parentRootRoleId: 'c0000000-0000-0000-0000-0000000000cc' }, /copy/],
    ['a role whose managed state is unknown', { isManaged: undefined }, /managed/i],
  ])('refuses %s with the reason and does not start editing', async (_n, change, reason) => {
    const reader = withRow(change as never);
    const { user } = setup(reader, writerFor(reader).writer);
    await pickTable(user);
    const badge = await waitFor(() => within(contributorRow()).getByText(/\(read-only\)/));
    expect(badge.closest('[title]')?.getAttribute('title')).toMatch(reason);
    expect(offersEditing()).toBe(false);
    expect(screen.queryByRole('region', { name: 'Role editing' })).toBeNull();
  });

  it('starts editing a focused role row with the E key', async () => {
    const reader = new LiveLikeReader();
    const { user } = setup(reader, writerFor(reader).writer);
    await pickTable(user);
    const row = (await screen.findByRole('button', { name: `Expand ${ROLE_NAME}` })).closest('tr') as HTMLElement;
    row.focus();
    await user.keyboard('e');
    expect(await screen.findByRole('region', { name: 'Role editing' })).toBeTruthy();
  });
});

describe('the preview shortcut below the table', () => {
  it('appears while editing, says how many changes are pending, starts the same preview, and is gone when editing ends', async () => {
    const reader = new LiveLikeReader();
    const { user } = setup(reader, writerFor(reader).writer);
    await startEditing(user);
    const footer = screen.getByRole('group', { name: 'Preview the staged changes' });
    expect((within(footer).getByRole('button', { name: 'Preview (nothing staged)' }) as HTMLButtonElement).disabled).toBe(true);
    await user.selectOptions(depthSelect('Read'), 'Organization');
    expect(within(footer).getByText(/1 pending change\./)).toBeTruthy();
    await user.click(within(footer).getByRole('button', { name: 'Preview 1 change' }));
    expect(await screen.findByRole('dialog')).toBeTruthy();
    await user.keyboard('{Escape}');
    await user.click(screen.getByRole('button', { name: 'Discard' }));
    expect(screen.queryByRole('group', { name: 'Preview the staged changes' })).toBeNull();
  });

  it('is not there when nothing is being edited', async () => {
    const reader = new LiveLikeReader();
    const { user } = setup(reader, writerFor(reader).writer);
    await pickTable(user);
    expect(screen.queryByRole('group', { name: 'Preview the staged changes' })).toBeNull();
  });
});

describe('several roles in one edit', () => {
  const rowOfRole = (name: string): HTMLElement => {
    const row = screen.getAllByRole('row').find((r) => within(r).queryByText(name, { selector: '.role-name' }));
    if (!row) throw new Error(`row ${name} not found`);
    return row;
  };
  /** A second editable role on the table (not managed, a root role), found in the synthetic data. */
  async function secondRoleName(): Promise<string> {
    const r = await new FixtureReader().loadRoleMatrix('contoso_project');
    if (r.status === 'error') throw new Error('fixture');
    const other = r.data.roles.find((x) => x.name !== ROLE_NAME && x.isManaged === false && x.parentRootRoleId === null);
    if (!other) throw new Error('no second editable role in the fixture');
    return other.name;
  }
  const startRole = async (user: User, name: string) => {
    const cell = (await waitFor(() => within(rowOfRole(name)).getAllByRole('gridcell', { name: /^Read:/ })))[0] as HTMLElement;
    await user.click(cell);
  };
  const readSelect = (name: string) => screen.getByRole('combobox', { name: `Read depth for ${name}` }) as HTMLSelectElement;
  /** Chooses a Read depth that differs from what the role holds now, so the choice is a real change. */
  const changeRead = async (user: User, name: string) => {
    const select = readSelect(name);
    await user.selectOptions(select, select.value === 'Global' ? 'Basic' : 'Global');
  };

  it('edits two roles, previews both, applies them one after the other and verifies each', async () => {
    const reader = new LiveLikeReader();
    const { writer, calls } = writerFor(reader);
    const second = await secondRoleName();
    const { user } = setup(reader, writer);
    await startEditing(user);
    await user.selectOptions(depthSelect('Read'), 'Organization');
    await startRole(user, second);
    await changeRead(user, second);
    expect(screen.getByText(/Editing 2 roles/, { selector: 'strong' })).toBeTruthy();
    expect(screen.getByText(/2 changes staged/)).toBeTruthy();

    await user.click(screen.getByRole('button', { name: 'Preview changes' }));
    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByRole('heading', { name: ROLE_NAME })).toBeTruthy();
    expect(within(dialog).getByRole('heading', { name: second })).toBeTruthy();
    expect(calls).toHaveLength(0); // nothing is written by the preview
    await user.click(within(dialog).getByRole('button', { name: 'Confirm and apply' }));

    const result = await screen.findByRole('region', { name: 'Edit result' });
    expect(within(result).getByText(/2 of 2 roles verified/)).toBeTruthy();
    expect(calls).toHaveLength(2);
    expect(writer.addPrivilege).toHaveBeenCalledTimes(2);
  });

  it('stops after a role that fails: the roles after it are not attempted and not changed', async () => {
    const reader = new LiveLikeReader();
    const { writer, calls } = writerFor(reader, { failOn: 'Read' });
    const second = await secondRoleName();
    const { user } = setup(reader, writer);
    await startEditing(user);
    await user.selectOptions(depthSelect('Read'), 'Organization');
    await startRole(user, second);
    await changeRead(user, second);
    await user.click(screen.getByRole('button', { name: 'Preview changes' }));
    await user.click(within(await screen.findByRole('dialog')).getByRole('button', { name: 'Confirm and apply' }));

    const result = await screen.findByRole('region', { name: 'Edit result' });
    expect(within(result).getByText(/0 of 2 roles verified/)).toBeTruthy();
    expect(within(result).getByText(/Not attempted\./)).toBeTruthy();
    expect(calls).toHaveLength(1); // only the first role was sent; the second was never written
  });

  it('removes one role from the edit and keeps the other', async () => {
    const reader = new LiveLikeReader();
    const { writer } = writerFor(reader);
    const second = await secondRoleName();
    const { user } = setup(reader, writer);
    await startEditing(user);
    await user.selectOptions(depthSelect('Read'), 'Organization');
    await startRole(user, second);
    await changeRead(user, second);
    await user.click(screen.getByRole('button', { name: `Remove ${second} from the edit` }));
    expect(screen.getByText(/Editing Project Contributor/, { selector: 'strong' })).toBeTruthy();
    expect(screen.getByText(/1 change staged/)).toBeTruthy();
  });

  it('a role that is being edited keeps its staged change when another role is added', async () => {
    const reader = new LiveLikeReader();
    const second = await secondRoleName();
    const { user } = setup(reader, writerFor(reader).writer);
    await startEditing(user);
    await user.selectOptions(depthSelect('Read'), 'Organization');
    await startRole(user, second);
    expect((depthSelect('Read') as HTMLSelectElement).value).toBe('Global');
    expect(screen.getByText(/1 change staged/)).toBeTruthy();
  });
});
