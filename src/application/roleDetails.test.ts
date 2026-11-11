import { describe, expect, it } from 'vitest';
import { FixtureReader } from '../adapters/fixture/fixtureReader';
import type { RoleFamily } from '../domain/access';
import type { ReadResult } from '../ports/securityDataReader';
import { describeCounts, describeFamily, describeTotal, totalUsers } from './roleDetails';

const reader = new FixtureReader();

async function load(table: string, role: string): Promise<Exclude<ReadResult<RoleFamily>, { status: 'error' }>> {
  const r = await reader.loadRoleDetails(table, role);
  if (r.status === 'error') throw new Error(r.message);
  return r;
}

describe('describeFamily', () => {
  it('counts the whole logical role over all copies and each copy on its own', async () => {
    const view = describeFamily(await load('contoso_project', 'r-contrib'));
    expect(view.complete).toBe(true);
    expect([view.counts.uniqueUsers, view.counts.paths]).toEqual([5, 12]);
    expect(view.instances.map((i) => [i.instance.businessUnitName, i.counts.uniqueUsers, i.counts.paths])).toEqual([
      ['Contoso', 4, 8],
      ['North', 3, 4], // Ben, Ann, Eva counted; Finn is disabled; paths: 2 direct + 2 team members
    ]);
    expect(view.differing).toEqual(['Delete']);
  });

  it('is incomplete when the read was partial, and carries the notes', async () => {
    const view = describeFamily(await load('contoso_budget', 'r-contrib'));
    expect(view.complete).toBe(false);
    expect(view.notes.join(' ')).toContain('lower bounds');
    expect(view.counts.unresolved).toBe(1);
  });

  it('is incomplete when a referenced user is unresolved even if the read claimed to be complete', async () => {
    const partial = await load('contoso_budget', 'r-contrib');
    const view = describeFamily({ status: 'ok', data: partial.data });
    expect(view.complete).toBe(false);
  });
});

describe('describeCounts', () => {
  it('says who holds the role in plain words: users, teams, application users, and disabled ones only when there are any (no assignment paths)', async () => {
    const view = describeFamily(await load('contoso_project', 'r-contrib'));
    expect(describeCounts(view.counts, true)).toBe('5 unique users · 3 direct · 2 teams (4 users from teams) · 1 application user · 1 disabled');
    expect(describeCounts(view.counts, true)).not.toMatch(/path/);
  });

  it('marks every figure as a lower bound for incomplete data', async () => {
    const view = describeFamily(await load('contoso_budget', 'r-contrib'));
    expect(describeCounts(view.counts, false)).toMatch(/^≥ 5 unique users · ≥ \d+ direct · ≥ \d+ teams \(≥ \d+ users from teams\) · ≥ \d+ application users/);
  });
});

describe('totalUsers and describeTotal (the total next to the table title)', () => {
  const person = (id: string, status: 'Enabled' | 'ApplicationUser' = 'Enabled') => ({ userId: id, name: id, status }) as const;
  const family = (root: string, direct: string[], teams: Array<{ id: string; members: string[] }>): ReadResult<RoleFamily> => ({
    status: 'ok',
    data: {
      rootRoleId: root,
      name: root,
      instances: [
        {
          roleId: root,
          businessUnitId: 'bu',
          businessUnitName: 'BU',
          cells: {} as never,
          directUsers: direct.map((d) => person(d)),
          teams: teams.map((t) => ({ teamId: t.id, name: t.id, teamType: 'Owner', businessUnitId: 'bu', members: t.members.map((m) => person(m)) })),
        },
      ],
    },
  });
  const done = (result: ReadResult<RoleFamily>) => ({ phase: 'done', result }) as const;

  it('counts a person once even when several roles reach them, and keeps direct and via-team numbers apart', () => {
    const states = {
      a: done(family('a', ['u1', 'u2'], [{ id: 't1', members: ['u2', 'u3'] }])),
      b: done(family('b', ['u2', 'u4'], [])),
    } as const;
    const t = totalUsers(['a', 'b'], (id) => states[id as 'a' | 'b']);
    expect([t.counts.uniqueUsers, t.counts.directUsers, t.counts.teams, t.counts.usersViaTeams]).toEqual([4, 3, 1, 2]);
    expect([t.roles, t.loaded, t.loading, t.failed, t.complete]).toEqual([2, 2, 0, 0, true]);
    expect(describeTotal(t)).toBe('Total: 4 unique users · 3 direct · 1 team (2 users from teams) · 0 application users (all 2 roles read)');
  });

  it('counts a family once when several listed rows (the root and its copies) return it', () => {
    const f = done(family('a', ['u1'], []));
    const t = totalUsers(['row1', 'row2'], () => f);
    expect(t.counts.uniqueUsers).toBe(1);
    expect(t.loaded).toBe(2);
  });

  it('is a lower bound with progress while roles are not read, loading or failed', () => {
    const states: Record<string, ReturnType<typeof done> | { phase: 'loading' } | undefined> = {
      a: done(family('a', ['u1'], [])),
      b: { phase: 'loading' },
      c: done({ status: 'error', errorClass: 'unknown', message: 'x' }),
      d: undefined,
    };
    const t = totalUsers(['a', 'b', 'c', 'd'], (id) => states[id] as never);
    expect([t.loaded, t.loading, t.failed, t.complete]).toEqual([1, 1, 1, false]);
    expect(describeTotal(t)).toBe('Total: ≥ 1 unique users · ≥ 1 direct · ≥ 0 teams (≥ 0 users from teams) · ≥ 0 application users (1 of 4 roles read, 1 failed)');
  });

  it('says when nothing was read yet, is empty for no roles, and a partial read is never complete', () => {
    expect(describeTotal(totalUsers(['a'], () => undefined))).toBe('Users not loaded yet');
    expect(describeTotal(totalUsers(['a'], () => ({ phase: 'loading' })))).toBe('Reading users…');
    expect(describeTotal(totalUsers([], () => undefined))).toBe('');
    const partial = done({ ...(family('a', ['u1'], []) as { status: 'ok'; data: RoleFamily }), status: 'partial', notes: ['x'] } as never);
    expect(totalUsers(['a'], () => partial).complete).toBe(false);
  });
});
