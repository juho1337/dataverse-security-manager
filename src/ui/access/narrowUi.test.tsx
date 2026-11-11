import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { FixtureAccessReader } from '../../adapters/fixture/accessFixture';
import { AccessExplorerModule } from './AccessExplorerModule';

describe('Access Explorer: narrow the search results by Business Unit', () => {
  it('narrows what was found without searching again, says how many are hidden, and restores them when cleared', async () => {
    const user = userEvent.setup();
    render(<AccessExplorerModule reader={new FixtureAccessReader()} debounceMs={0} />);
    await user.type(screen.getByRole('searchbox', { name: 'Search users and teams' }), 'a');
    await user.type(screen.getByRole('searchbox', { name: 'Search users and teams' }), 'n');
    await screen.findByText(/found\./);
    const all = screen.getAllByRole('button', { name: /·|·/ }).length;
    expect(all).toBeGreaterThan(0);

    const narrow = screen.getByRole('searchbox', { name: 'Narrow by Business Unit' });
    await user.type(narrow, 'zzz-no-such-business-unit');
    expect(screen.getByText(/it does not search again: \d+ hidden/)).toBeTruthy();
    expect(screen.queryAllByRole('button', { name: /Ann Admin/ })).toHaveLength(0);

    await user.clear(narrow);
    expect(screen.queryByText(/it does not search again/)).toBeNull();
    expect(screen.getAllByRole('button', { name: /Ann Admin/ }).length).toBeGreaterThan(0);
  });
});
