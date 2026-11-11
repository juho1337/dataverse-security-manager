import { act, renderHook, waitFor } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { applyMatrixFilters, NO_FILTERS } from '../application/roleFilters';
import type { RoleFamily } from '../domain/access';
import type { PrivilegeCells, RoleRow } from '../domain/privileges';
import { PRIVILEGE_IDS } from '../domain/privileges';
import type { ReadResult, SecurityDataReader } from '../ports/securityDataReader';
import { BULK_LIMIT, useRoleDetails } from './useRoleDetails';

const family = (id: string): ReadResult<RoleFamily> => ({ status: 'ok', data: { rootRoleId: id, name: id, instances: [] } });

/** A reader whose loadRoleDetails stays pending until released, so the number of reads in flight can be observed. */
function gatedReader() {
  let inflight = 0;
  let peak = 0;
  const calls: string[] = [];
  const waiting: (() => void)[] = [];
  const reader = {
    listTables: async () => ({ status: 'ok', data: [] }),
    loadRoleMatrix: async () => ({ status: 'error', errorClass: 'unknown', message: 'unused' }),
    loadRoleDetails: (_t: string, id: string) => {
      calls.push(id);
      inflight++;
      peak = Math.max(peak, inflight);
      return new Promise<ReadResult<RoleFamily>>((resolve) => waiting.push(() => { inflight--; resolve(family(id)); }));
    },
  } as unknown as SecurityDataReader;
  return { reader, calls, peak: () => peak, releaseOne: () => waiting.shift()?.(), pending: () => waiting.length };
}

describe('bulk loading of role assignments', () => {
  it('reads at most four roles at the same time and every queued role once', async () => {
    const g = gatedReader();
    const { result } = renderHook(() => useRoleDetails(g.reader, 'account'));
    const ids = Array.from({ length: 10 }, (_, i) => `r${i}`);
    let queued = 0;
    act(() => { queued = result.current.ensureMany(ids); });
    expect(queued).toBe(10);
    expect(g.pending()).toBe(4);
    for (let i = 0; i < 10; i++) {
      await act(async () => { g.releaseOne(); await Promise.resolve(); });
    }
    await waitFor(() => expect(Object.keys(result.current.states)).toHaveLength(10));
    expect(g.peak()).toBe(4);
    expect([...g.calls].sort()).toEqual([...ids].sort());
    // Asking again loads nothing.
    let again = -1;
    act(() => { again = result.current.ensureMany(ids); });
    expect(again).toBe(0);
  });

  it('queues at most BULK_LIMIT roles per call', () => {
    const g = gatedReader();
    const { result } = renderHook(() => useRoleDetails(g.reader, 'account'));
    let queued = 0;
    act(() => { queued = result.current.ensureMany(Array.from({ length: BULK_LIMIT + 40 }, (_, i) => `r${i}`)); });
    expect(queued).toBe(BULK_LIMIT);
  });
});

describe('filter performance on a large role list', () => {
  const cells = Object.fromEntries(PRIVILEGE_IDS.map((p, i) => [p, i % 3 === 0 ? { kind: 'depth', depth: 'Basic' } : { kind: 'noGrant' }])) as PrivilegeCells;
  const roles: RoleRow[] = Array.from({ length: 5000 }, (_, i) => ({ roleId: `r${i}`, name: `Role ${String(i).padStart(4, '0')}`, cells }));
  const loaded = new Map<string, ReadResult<RoleFamily>>(roles.slice(0, 300).map((r) => [r.roleId, family(r.roleId)]));

  it('filters 5000 roles by privilege, depth and holder well within a frame budget', () => {
    const t0 = performance.now();
    const o = applyMatrixFilters(roles, { ...NO_FILTERS, privileges: ['Create'], depths: ['Basic'], holder: 'x' }, (id) => loaded.get(id));
    const ms = performance.now() - t0;
    expect(o.rows).toHaveLength(0);
    expect(o.notChecked.length).toBe(4700);
    expect(ms).toBeLessThan(500); // generous: it is a regression tripwire, not a benchmark
  });
});

describe('refreshing the users of a list longer than the bulk limit', () => {
  it('continues where the previous click stopped, so every role is reached by repeated clicks', async () => {
    const g = gatedReader();
    const { result } = renderHook(() => useRoleDetails(g.reader, 'account'));
    const ids = Array.from({ length: BULK_LIMIT + 50 }, (_, i) => `r${i}`);
    let first = 0;
    act(() => { first = result.current.refreshMany(ids); });
    expect(first).toBe(BULK_LIMIT);
    for (let i = 0; i < BULK_LIMIT; i++) await act(async () => { g.releaseOne(); await Promise.resolve(); });
    await waitFor(() => expect(g.calls).toHaveLength(BULK_LIMIT));
    expect(g.calls.slice(0, BULK_LIMIT)).toEqual(ids.slice(0, BULK_LIMIT));
    let second = 0;
    act(() => { second = result.current.refreshMany(ids); });
    expect(second).toBe(BULK_LIMIT);
    await waitFor(() => expect(g.calls.length).toBeGreaterThan(BULK_LIMIT));
    // The second click starts with the roles the first one did not reach.
    expect(g.calls[BULK_LIMIT]).toBe(`r${BULK_LIMIT}`);
  });
});
