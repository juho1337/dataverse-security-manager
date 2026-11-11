import { readFileSync } from 'node:fs';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { FixtureReader } from '../adapters/fixture/fixtureReader';
import { PRIVILEGE_IDS } from '../domain/privileges';
import type { PrivilegeCells } from '../domain/privileges';
import type { SecurityDataReader } from '../ports/securityDataReader';
import { App } from './App';
import { DepthCells } from './DepthLetters';
import { PRIVILEGE_LABEL } from './labels';

type User = ReturnType<typeof userEvent.setup>;
const setup = (reader: SecurityDataReader = new FixtureReader()) => ({ user: userEvent.setup(), ...render(<App reader={reader} />) });

async function pickTable(user: User, search: string, optionName: RegExp) {
  const combo = await screen.findByRole('combobox');
  await user.click(combo);
  await user.type(combo, search);
  await user.click(await screen.findByRole('option', { name: optionName }));
  await screen.findByRole('treegrid');
}
const switchTo = async (user: User, name: 'Privilege Matrix' | 'Depth Matrix') => user.click(screen.getByRole('radio', { name }));
const roleRow = (name: string): HTMLElement => {
  const row = screen.getByText(name, { selector: '.role-name' }).closest('tr');
  if (!row) throw new Error(`row for ${name} not found`);
  return row;
};
const letters = (row: HTMLElement) => within(row).getAllByRole('button').filter((b) => b.classList.contains('letter'));

describe('view switch', () => {
  it('offers Privilege Matrix (default) and Depth Matrix as one radio group', async () => {
    const { user } = setup();
    await pickTable(user, 'contoso_project', /Contoso Project/);
    const group = screen.getByRole('radiogroup', { name: 'Matrix view' });
    expect(within(group).getAllByRole('radio')).toHaveLength(2);
    expect((screen.getByRole('radio', { name: 'Privilege Matrix' }) as HTMLInputElement).checked).toBe(true);
    expect(screen.getAllByRole('columnheader').map((h) => h.textContent)).toEqual(['Security role', ...PRIVILEGE_IDS.map((p) => PRIVILEGE_LABEL[p])]);
  });

  it('Depth Matrix has exactly the four depth columns with their display labels', async () => {
    const { user } = setup();
    await pickTable(user, 'contoso_project', /Contoso Project/);
    await switchTo(user, 'Depth Matrix');
    expect(screen.getAllByRole('columnheader').map((h) => h.textContent)).toEqual(['Security role', 'User', 'Business Unit', 'Parent: Child BU', 'Organization']);
    expect(screen.getByRole('region', { name: /Depth matrix for Contoso Project/ })).toBeTruthy();
  });
});

describe('Depth Matrix: actual grants versus implied coverage', () => {
  it('renders one granted letter per granted privilege and the lower depths as covered (not as grants)', async () => {
    const { user } = setup();
    await pickTable(user, 'contoso_project', /Contoso Project/);
    await switchTo(user, 'Depth Matrix');
    // Project Contributor: Create Local, Read Deep, Write Local, Delete Basic, Append Local, Append To Local, Assign None, Share Basic.
    const l = letters(roleRow('Project Contributor'));
    expect(l).toHaveLength(32);
    const count = (state: string) => l.filter((b) => b.dataset.state === state).length;
    expect(count('granted')).toBe(7);
    expect(count('covered')).toBe(6);
    expect(count('inactive')).toBe(19);
    expect(l.filter((b) => b.getAttribute('aria-label') === 'Read: granted at Parent: Child BU')).toHaveLength(1);
    expect(l.filter((b) => b.getAttribute('aria-label') === 'Read: covered by the Parent: Child BU grant (implied, not a separate grant)')).toHaveLength(2);
    expect(l.filter((b) => b.getAttribute('aria-label') === 'Assign: not granted')).toHaveLength(4);
    expect(l.filter((b) => b.getAttribute('aria-label')?.startsWith('Assign: granted'))).toHaveLength(0);
  });

  it('each letter has its abbreviation, a full accessible name and the same text as a tooltip', async () => {
    const { user } = setup();
    await pickTable(user, 'contoso_project', /Contoso Project/);
    await switchTo(user, 'Depth Matrix');
    const row = roleRow('Project Administrator');
    const global = within(row).getByRole('button', { name: 'Append To: granted at Organization' });
    expect(global.textContent).toContain('T');
    expect(global.getAttribute('title')).toBe('Append To: granted at Organization');
    expect(within(row).getByRole('button', { name: 'Share: granted at Organization' }).textContent).toContain('H');
  });

  it('shows unknown (never as not granted) and not applicable distinctly', async () => {
    const { user } = setup();
    await pickTable(user, 'contoso_budget', /Contoso Budget/);
    await switchTo(user, 'Depth Matrix');
    expect(screen.getAllByRole('button', { name: /: unknown, could not be read$/ }).length).toBeGreaterThan(0);
    await pickTable(user, 'contoso_task', /Contoso Task/);
    expect(screen.getAllByRole('button', { name: /^Assign: not applicable to this table$/ }).length).toBeGreaterThan(0);
  });
});

describe('both views show the same canonical state', () => {
  it('the granted depth per privilege in the Privilege Matrix equals the granted column in the Depth Matrix', async () => {
    const { user } = setup();
    await pickTable(user, 'contoso_project', /Contoso Project/);
    const fromCells = (): Record<string, string> => {
      const out: Record<string, string> = {};
      for (const td of within(roleRow('Project Contributor')).getAllByRole('gridcell')) {
        const m = /^([A-Za-z ]+): (None|User|Business Unit|Parent: Child BU|Organization)$/.exec(td.getAttribute('aria-label') ?? '');
        if (m && m[2] !== 'None') out[m[1] ?? ''] = m[2] ?? '';
      }
      return out;
    };
    const privilegeView = fromCells();
    await switchTo(user, 'Depth Matrix');
    const depthView: Record<string, string> = {};
    for (const b of letters(roleRow('Project Contributor'))) {
      const m = /^([A-Za-z ]+): granted at (.+)$/.exec(b.getAttribute('aria-label') ?? '');
      if (m) depthView[m[1] ?? ''] = m[2] ?? '';
    }
    expect(Object.keys(privilegeView)).toHaveLength(7);
    expect(depthView).toEqual(privilegeView);
  });

  it('expanded Business Unit copies are only a name with its users and teams: no letters, the privileges are those of the role row', async () => {
    const { user } = setup();
    await pickTable(user, 'contoso_project', /Contoso Project/);
    await switchTo(user, 'Depth Matrix');
    await user.click(await screen.findByRole('button', { name: 'Expand Project Contributor' }));
    await screen.findByText(/Business Unit: North/);
    const north = screen.getByText(/Business Unit: North/, { selector: '.role-name' }).closest('tr');
    expect(north).toBeTruthy();
    expect(letters(north as HTMLElement)).toHaveLength(0);
    expect((north as HTMLElement).textContent).toMatch(/\d+ unique users? · \d+ direct · \d+ teams?/);
  });
});

describe('switching views keeps the context', () => {
  it('keeps the selected table, the role search, the expansion and the focused row', async () => {
    const reader = new FixtureReader();
    const spy = vi.spyOn(reader, 'loadRoleDetails');
    const { user } = setup(reader);
    await pickTable(user, 'contoso_project', /Contoso Project/);
    await user.type(screen.getByLabelText('Search roles'), 'Contributor');
    await user.click(await screen.findByRole('button', { name: 'Expand Project Contributor' }));
    await screen.findByText(/Business Unit: North/);
    roleRow('Project Contributor').focus();
    expect(roleRow('Project Contributor').getAttribute('tabindex')).toBe('0');

    await switchTo(user, 'Depth Matrix');
    expect(screen.getByText(/Selected table:/).textContent).toContain('Contoso Project');
    expect((screen.getByLabelText('Search roles') as HTMLInputElement).value).toBe('Contributor');
    expect(screen.queryByText('Project Administrator', { selector: '.role-name' })).toBeNull();
    expect(screen.getByText(/Business Unit: North/)).toBeTruthy();
    expect(roleRow('Project Contributor').getAttribute('aria-expanded')).toBe('true');
    expect(roleRow('Project Contributor').getAttribute('tabindex')).toBe('0');

    await switchTo(user, 'Privilege Matrix');
    expect(screen.getByText(/Business Unit: North/)).toBeTruthy();
    expect((screen.getByLabelText('Search roles') as HTMLInputElement).value).toBe('Contributor');
    expect(spy).toHaveBeenCalledTimes(1);
  });

  it('keeps the chosen view when another table is selected', async () => {
    const { user } = setup();
    await pickTable(user, 'contoso_project', /Contoso Project/);
    await switchTo(user, 'Depth Matrix');
    await pickTable(user, 'account', /^Account/);
    expect((screen.getByRole('radio', { name: 'Depth Matrix' }) as HTMLInputElement).checked).toBe(true);
    expect(screen.getAllByRole('columnheader').map((h) => h.textContent)).toContain('Organization');
  });
});

describe('read-only: letters never write', () => {
  it('pressing a letter only announces its state; no reader call, no state change', async () => {
    const reader = new FixtureReader();
    const { user } = setup(reader);
    await pickTable(user, 'contoso_project', /Contoso Project/);
    await switchTo(user, 'Depth Matrix');
    const calls = vi.spyOn(reader, 'loadRoleDetails');
    const before = letters(roleRow('Project Reader')).map((b) => b.dataset.state);
    const target = within(roleRow('Project Reader')).getByRole('button', { name: 'Read: granted at Organization' });
    await user.click(target);
    expect(screen.getAllByRole('status').some((s) => s.textContent === 'Read: granted at Organization')).toBe(true);
    target.focus();
    await user.keyboard('{Enter}');
    expect(letters(roleRow('Project Reader')).map((b) => b.dataset.state)).toEqual(before);
    expect(calls).not.toHaveBeenCalled();
  });
});

describe('staged state (styling hook for the editing milestone)', () => {
  const cells = Object.fromEntries(PRIVILEGE_IDS.map((p) => [p, { kind: 'depth', depth: 'Deep' }])) as unknown as PrivilegeCells;
  const renderCells = (staged: Parameters<typeof DepthCells>[0]['staged']) =>
    render(
      <table>
        <tbody>
          <tr>
            <DepthCells cells={cells} staged={staged} onAnnounce={() => undefined} />
          </tr>
        </tbody>
      </table>,
    );

  it('marks a staged grant at the target depth, distinct from granted and covered, with before/after in words', () => {
    renderCells({ Read: 'Global' });
    const staged = screen.getByRole('button', { name: 'Read: staged change, will be granted at Organization (currently granted at Parent: Child BU)' });
    expect(staged.dataset.state).toBe('staged');
    expect(staged.className).toContain('letter-pending'); // looks like a grant, with a dashed outline
    // the depths below the new grant are covered by it, also dashed; the old grant at Parent: Child BU becomes covered too
    const lower = screen.getByRole('button', { name: 'Read: will be covered by the Organization grant (staged change, implied, not a separate grant)' });
    expect(lower.dataset.state).toBe('covered');
    expect(lower.className).toContain('letter-pending');
  });

  it('the pending outline is declared so that it also wins over the pressed-state outline of an editable letter', () => {
    const css = readFileSync('src/ui/styles.css', 'utf8');
    expect(css).toMatch(/\.letter-edit\.letter-pending\[aria-pressed="true"\]/);
  });

  it('marks a staged removal on the current grant', () => {
    renderCells({ Write: 'None' });
    const staged = screen.getByRole('button', { name: 'Write: staged change, will be removed (currently granted at Parent: Child BU)' });
    expect(staged.dataset.state).toBe('inactive');
    expect(staged.className).toContain('letter-pending');
  });
});
