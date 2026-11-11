import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { FixtureReader } from '../adapters/fixture/fixtureReader';
import { App } from './App';
import { plannedModule, type AppModule } from './modules';

type User = ReturnType<typeof userEvent.setup>;

async function pickTable(user: User) {
  const combo = await screen.findByRole('combobox');
  await user.click(combo);
  await user.type(combo, 'contoso_project');
  await user.click(await screen.findByRole('option', { name: /Contoso Project/ }));
  await screen.findByRole('treegrid');
}

describe('app shell modules', () => {
  it('keeps the selected table and the expanded role when switching modules and back', async () => {
    const user = userEvent.setup();
    render(<App reader={new FixtureReader()} />);
    await pickTable(user);
    await user.click(await screen.findByRole('button', { name: 'Expand Project Contributor' }));
    await screen.findByText(/Business Unit: North/);

    await user.click(screen.getByRole('button', { name: 'Access Explorer' }));
    expect(document.querySelector('[data-module="analyzer"]')?.hasAttribute('hidden')).toBe(true);
    expect(screen.getByRole('button', { name: 'Access Explorer' }).getAttribute('aria-current')).toBe('page');

    await user.click(screen.getByRole('button', { name: 'Role Analyzer' }));
    expect(document.querySelector('[data-module="analyzer"]')?.hasAttribute('hidden')).toBe(false);
    expect(screen.getByText(/Selected table:/).textContent).toContain('contoso_project');
    expect(screen.getByRole('button', { name: 'Collapse Project Contributor' })).toBeTruthy();
    expect(screen.getByText(/Business Unit: North/)).toBeTruthy();
  });

  it('does not load a module that was never visited, keeps keepAlive modules mounted and unmounts placeholders when leaving them', async () => {
    const user = userEvent.setup();
    render(<App reader={new FixtureReader()} />);
    await screen.findByRole('combobox');
    expect(document.querySelector('[data-module="explorer"]')).toBeNull();
    await user.click(screen.getByRole('button', { name: 'Access Explorer' }));
    expect(document.querySelector('[data-module="explorer"]')).not.toBeNull();
    // The explorer and the BU Manager are keepAlive (a running write must survive navigation); only a placeholder unmounts when left.
    await user.click(screen.getByRole('button', { name: 'BU Manager' }));
    expect(document.querySelector('[data-module="explorer"]')).not.toBeNull();
    expect(document.querySelector('[data-module="bu"]')).not.toBeNull();
    await user.click(screen.getByRole('button', { name: 'Access Explorer' }));
    expect(document.querySelector('[data-module="bu"]')).not.toBeNull();
  });

  it('unmounts a placeholder module when leaving it', async () => {
    const user = userEvent.setup();
    const modules: AppModule[] = [
      { id: 'one', label: 'One', render: () => <p>First module</p> },
      plannedModule('later', 'Later', 'Not built yet.'),
    ];
    render(<App reader={new FixtureReader()} modules={modules} />);
    await user.click(screen.getByRole('button', { name: 'Later' }));
    expect(document.querySelector('[data-module="later"]')).not.toBeNull();
    await user.click(screen.getByRole('button', { name: 'One' }));
    expect(document.querySelector('[data-module="later"]')).toBeNull();
  });

  it('renders the navigation from the registered modules without any change to the shell', async () => {
    const user = userEvent.setup();
    const modules: AppModule[] = [
      { id: 'one', label: 'One', render: () => <p>First module</p> },
      plannedModule('two', 'Two', 'Later.'),
      { id: 'three', label: 'Three', keepAlive: true, render: ({ dataSource }) => <p>Third module ({dataSource})</p> },
    ];
    render(<App reader={new FixtureReader()} modules={modules} dataSource="live" />);
    expect(screen.getByText('First module')).toBeTruthy();
    expect(screen.getAllByRole('button').map((b) => b.textContent)).toEqual(['One', 'Two', 'Three']);
    await user.click(screen.getByRole('button', { name: 'Three' }));
    expect(screen.getByText('Third module (live)')).toBeTruthy();
    expect(screen.queryByText('First module')).toBeNull();
  });

  it('moves between modules with the keyboard (buttons in tab order, current page announced)', async () => {
    const user = userEvent.setup();
    render(<App reader={new FixtureReader()} />);
    await screen.findByRole('combobox');
    const nav = screen.getByRole('navigation', { name: 'Screens' });
    nav.querySelectorAll('button')[0]?.focus();
    await user.tab();
    expect(document.activeElement?.textContent).toBe('Access Explorer');
    await user.keyboard('{Enter}');
    expect(screen.getByRole('button', { name: 'Access Explorer' }).getAttribute('aria-current')).toBe('page');
  });
});
