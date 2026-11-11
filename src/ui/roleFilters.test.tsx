import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { FixtureReader } from '../adapters/fixture/fixtureReader';
import { App } from './App';
import type { DownloadFile } from './operations/download';
import type { ReportServices } from './reports/ReportContext';

type U = ReturnType<typeof userEvent.setup>;

function services() {
  const files: DownloadFile[] = [];
  const value: ReportServices = {
    environment: 'Contoso Dev',
    now: () => Date.UTC(2026, 11, 1, 8, 30, 0),
    download: (f) => void files.push(f),
    clipboard: { writeText: async () => undefined },
  };
  return { value, files };
}

async function open(reader = new FixtureReader()) {
  const s = services();
  const user = userEvent.setup();
  render(<App reader={reader} report={s.value} />);
  const combo = await screen.findByRole('combobox');
  await user.click(combo);
  await user.type(combo, 'contoso_project');
  await user.click(await screen.findByRole('option', { name: /Contoso Project/ }));
  await screen.findByRole('treegrid');
  return { user, s, reader };
}

const rowNames = () => within(screen.getByRole('treegrid')).queryAllByRole('rowheader').map((h) => h.querySelector('.role-name')?.textContent ?? '');
const openFilters = async (user: U) => user.click(screen.getByText(/More filters/));

describe('Role Analyzer filters', () => {
  it('no UI source prints a \\uXXXX escape as text (JSX text does not decode it: the user would see the backslash sequence)', () => {
    const sources = import.meta.glob('./**/*.tsx', { query: '?raw', import: 'default', eager: true }) as Record<string, string>;
    const offenders = Object.entries(sources)
      .filter(([name]) => !name.endsWith('.test.tsx'))
      .filter(([, src]) => />[^<>{}\n]*\\\\u[0-9a-fA-F]{4}/.test(src))
      .map(([name]) => name);
    expect(offenders).toEqual([]);
  });
  it('filters by privilege and depth from the matrix alone, and clears again', async () => {
    const { user } = await open();
    const before = rowNames();
    expect(before.length).toBeGreaterThan(1);
    await openFilters(user);
    await user.click(screen.getByRole('checkbox', { name: 'Delete' }));
    const withDelete = rowNames();
    expect(withDelete.length).toBeLessThanOrEqual(before.length);
    await user.click(screen.getByRole('checkbox', { name: 'Organization' }));
    const orgDelete = rowNames();
    expect(orgDelete.length).toBeLessThanOrEqual(withDelete.length);
    await user.click(screen.getByRole('button', { name: 'Clear all filters' }));
    expect(rowNames()).toEqual(before);
  });

  it('the holder filter lists nothing until assignments are loaded, says so, and then finds the role by one of its users', async () => {
    const reader = new FixtureReader();
    const spy = vi.spyOn(reader, 'loadRoleDetails');
    const { user } = await open(reader);
    await openFilters(user);
    await user.type(screen.getByRole('searchbox', { name: 'Held by user or team' }), 'Ann Admin');
    expect(rowNames()).toEqual([]);
    expect(spy).not.toHaveBeenCalled();
    const notice = screen.getByText(/known only for roles whose assignments are loaded/);
    expect(notice.textContent).toMatch(/not checked yet and not listed/);
    await user.click(within(notice).getByRole('button', { name: /Load assignments for \d+ role/ }));
    await screen.findByText('Project Contributor', { selector: '.role-name' });
    expect(spy).toHaveBeenCalled();
    expect(rowNames()).toContain('Project Contributor');
  });

  it('the exported report names the active privilege and Business Unit filters', async () => {
    const { user, s } = await open();
    await openFilters(user);
    await user.click(screen.getByRole('checkbox', { name: 'Read' }));
    await user.type(screen.getByRole('searchbox', { name: 'Business Unit' }), 'North');
    await user.click(within(screen.getByText(/known only for roles whose assignments are loaded/)).getByRole('button', { name: /Load assignments/ }));
    await screen.findAllByText(/./, { selector: '.role-name' });
    await user.click(await screen.findByRole('button', { name: 'Export .txt' }));
    const txt = s.files[0];
    expect(txt?.content).toContain('Read at any granting depth');
    expect(txt?.content).toContain('Business Unit copy matching "North"');
  });
});
