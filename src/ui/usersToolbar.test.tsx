import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import type { UsersTotal } from '../application/roleDetails';
import type { AssignmentCounts } from '../domain/access';
import { UsersToolbar } from './UsersToolbar';

const counts = (over: Partial<AssignmentCounts> = {}): AssignmentCounts => ({
  directUsers: 3, usersViaTeams: 2, teams: 2, uniqueUsers: 4, paths: 6, usersWithSeveralPaths: 1, excludedDisabled: 0, excludedApplication: 5, unresolved: 0,
  directUserIds: [], viaTeamUserIds: [], uniqueUserIds: [], teamIds: [], unresolvedUserIds: [], ...over,
});
const total = (over: Partial<UsersTotal> = {}): UsersTotal => ({ counts: counts(), roles: 12, loaded: 12, loading: 0, failed: 0, complete: true, ...over });

describe('UsersToolbar states', () => {
  it('nothing read: an invitation and a prominent "Load users" that starts the read', async () => {
    const onLoad = vi.fn();
    render(<UsersToolbar total={total({ loaded: 0, complete: false, counts: counts({ uniqueUsers: 0, directUsers: 0, teams: 0, usersViaTeams: 0, excludedApplication: 0 }) })} onLoad={onLoad} />);
    expect(screen.getByText('Users not loaded yet')).toBeTruthy();
    const button = screen.getByRole('button', { name: 'Load users' });
    expect(button.className).toContain('primary');
    await userEvent.setup().click(button);
    expect(onLoad).toHaveBeenCalledTimes(1);
  });

  it('reading: a progress bar with the count, and the button is busy and disabled', () => {
    render(<UsersToolbar total={total({ loaded: 3, loading: 4, complete: false })} onLoad={() => undefined} />);
    expect(screen.getByText('Reading users… 3 of 12')).toBeTruthy();
    const bar = screen.getByRole('progressbar', { name: 'Roles whose users were read' }) as HTMLProgressElement;
    expect([bar.value, bar.max]).toEqual([3, 12]);
    const button = screen.getByRole('button', { name: 'Reading…' }) as HTMLButtonElement;
    expect(button.disabled).toBe(true);
    expect(button.className).toContain('is-busy');
  });

  it('all read: the total as chips with one sentence for a screen reader, and a quieter "Refresh users"', () => {
    render(<UsersToolbar total={total()} onLoad={() => undefined} />);
    expect(screen.getByText(/^Total: 4 unique users · 3 direct · 2 teams \(2 users from teams\) · 5 application users \(all 12 roles read\)$/)).toBeTruthy();
    expect(screen.getByText(/unique users/, { selector: '.user-chip' }).textContent).toContain('4');
    expect(screen.getByText(/application users/, { selector: '.user-chip' }).textContent).toContain('5');
    const button = screen.getByRole('button', { name: 'Refresh users' });
    expect(button.className).not.toContain('primary');
  });

  it('some read: chips are lower bounds and say how far it got; failures are named; the button still loads', () => {
    render(<UsersToolbar total={total({ loaded: 5, failed: 1, complete: false })} onLoad={() => undefined} />);
    expect(screen.getByText('5 of 12 roles read')).toBeTruthy();
    expect(screen.getByText('1 failed')).toBeTruthy();
    expect(screen.getByText(/≥ 4/, { selector: '.user-chip strong' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Load users' })).toBeTruthy();
  });

  it('no roles listed: the button is disabled and nothing claims a total', () => {
    render(<UsersToolbar total={total({ roles: 0, loaded: 0, complete: false })} onLoad={() => undefined} />);
    expect((screen.getByRole('button', { name: 'Load users' }) as HTMLButtonElement).disabled).toBe(true);
    expect(screen.queryByText(/^Total:/)).toBeNull();
  });

  it('a list longer than the bulk limit says that it is read in parts, 150 per click', () => {
    render(<UsersToolbar total={total({ roles: 200, loaded: 200 })} onLoad={() => undefined} />);
    expect(screen.getByText('150 roles per click')).toBeTruthy();
  });

  it('a short list does not carry that note', () => {
    render(<UsersToolbar total={total()} onLoad={() => undefined} />);
    expect(screen.queryByText(/roles per click/)).toBeNull();
  });
});
