import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { makeExpansionReader } from '../test/expansionHost';
import { App } from './App';

// The role expansion driven by the REAL PPTB reader (over an in-memory host that answers like the real service), in live mode: nothing here comes
// from the synthetic fixtures. Which parts are verified against the real environment is stated in the PR; this is the wiring and rendering check.

type User = ReturnType<typeof userEvent.setup>;

async function openContributor(reader: ReturnType<typeof makeExpansionReader>['reader']) {
  const user: User = userEvent.setup();
  render(<App reader={reader} dataSource="live" />);
  const combo = await screen.findByRole('combobox');
  await user.click(combo);
  await user.type(combo, 'contoso_project');
  await user.click(await screen.findByRole('option', { name: /Contoso Project/ }));
  await screen.findByRole('treegrid');
  // the matrix lists every role record: the root and its Business Unit copy are two rows with the same name; expand the first (the root)
  await user.click((await screen.findAllByRole('button', { name: 'Expand Lineage Role' }))[0] as HTMLElement);
  return user;
}

describe('role expansion with the live reader', () => {
  it('shows the live instances, people and counts from the host, labelled live and never synthetic', async () => {
    const { reader } = makeExpansionReader();
    await openContributor(reader);
    expect(await screen.findByText(/Business Unit: North/)).toBeTruthy();
    expect(screen.getByText(/Business Unit: Contoso/)).toBeTruthy();
    // Ada is direct AND in the team (one person, two routes); Dan is disabled and the service app is an application user: not people
    expect((await screen.findAllByText(/^2 unique users · \d+ direct · \d+ teams? \(\d+ users? from teams\) · 1 application user · 1 disabled/)).length).toBeGreaterThan(0);
    expect(screen.getByText(/Live Dataverse data · read mode/)).toBeTruthy();
    expect(screen.queryByText(/Synthetic data/)).toBeNull();
    // none of the fixture names appear
    expect(screen.queryByText(/Project Contributor/)).toBeNull();
  });

  it('shows a partial banner and lower bounds, never a bare number, when the direct users could not be read', async () => {
    const { reader } = makeExpansionReader({ failUsers: new Error('503 Service Unavailable') });
    await openContributor(reader);
    expect((await screen.findAllByText(/direct users could not be read/)).length).toBeGreaterThan(0);
    expect(screen.getAllByText(/≥/).length).toBeGreaterThan(0);
  });

  it('shows an error with Retry, and no invented numbers, when the role instances cannot be read', async () => {
    const { reader } = makeExpansionReader({ failFamily: new Error('503 Service Unavailable') });
    await openContributor(reader);
    expect(await screen.findByRole('button', { name: 'Retry' })).toBeTruthy();
    expect(screen.queryByText(/\d+ users? ·/)).toBeNull();
  });

  it('shows ONE row per logical role (root and Business Unit copy grouped); expanding it lists both Business Units', async () => {
    const { reader } = makeExpansionReader();
    const user = userEvent.setup();
    render(<App reader={reader} dataSource="live" />);
    const combo = await screen.findByRole('combobox');
    await user.click(combo);
    await user.type(combo, 'contoso_project');
    await user.click(await screen.findByRole('option', { name: /Contoso Project/ }));
    await screen.findByRole('treegrid');
    const buttons = await screen.findAllByRole('button', { name: 'Expand Lineage Role' });
    expect(buttons).toHaveLength(1); // the copy is not a row of its own
    expect(screen.getAllByText('Expand to see users and teams').length).toBeGreaterThan(0); // the live reader reads who holds a role only when it is expanded
    await user.click(buttons[0] as HTMLElement);
    expect(await screen.findByText(/Business Unit: North/)).toBeTruthy();
    expect(screen.getByText(/Business Unit: Contoso/)).toBeTruthy();
  });

  it('an expanded family renders unique rows, keys and ids, keeps keyboard navigation, and collapses cleanly', async () => {
    const errors = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const { reader } = makeExpansionReader();
    const user = userEvent.setup();
    render(<App reader={reader} dataSource="live" />);
    const combo = await screen.findByRole('combobox');
    await user.click(combo);
    await user.type(combo, 'contoso_project');
    await user.click(await screen.findByRole('option', { name: /Contoso Project/ }));
    await screen.findByRole('treegrid');
    await user.click((await screen.findAllByRole('button', { name: 'Expand Lineage Role' }))[0] as HTMLElement);
    await screen.findByText(/Business Unit: North/);

    // no React duplicate-key warning
    const logged = errors.mock.calls.flat().map(String).join(' ');
    expect(logged).not.toMatch(/same key|unique "key"/);
    // no duplicate DOM id anywhere
    const ids = [...document.querySelectorAll('[id]')].map((e) => e.id);
    expect(new Set(ids).size).toBe(ids.length);

    // keyboard: arrows walk every focusable row exactly once
    const rows = () => screen.getAllByRole('row').filter((r) => r.hasAttribute('aria-expanded'));
    (rows()[0] as HTMLElement).focus();
    const visited = new Set<Element>([document.activeElement as Element]);
    for (let i = 0; i < rows().length - 1; i++) {
      await user.keyboard('{ArrowDown}');
      visited.add(document.activeElement as Element);
    }
    expect(visited.size).toBe(rows().length);

    await user.click(screen.getAllByRole('button', { name: 'Collapse Lineage Role' })[0] as HTMLElement);
    expect(screen.queryByText(/Business Unit: North/)).toBeNull();
    errors.mockRestore();
  });
});
