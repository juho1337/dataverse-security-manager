import { act, render, renderHook, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { PRIVILEGE_IDS, type CellValue, type PrivilegeCells, type PrivilegeId, type RoleMatrix, type RoleRow } from '../../domain/privileges';
import { startEdit } from '../../domain/roleEditing';
import type { SecurityDataReader } from '../../ports/securityDataReader';
import type { SecurityDataWriter } from '../../ports/securityDataWriter';
import { ResultPanel } from './EditPanels';
import { useRoleEditing, type RoleEditing } from './useRoleEditing';

// Review findings of the several-roles edit: staging never reaches a session of another table, and a role whose apply call threw is shown
// as unknown (not as "not attempted").

const ROLE = '11111111-1111-1111-1111-111111111111';
const catalog = Object.fromEntries(PRIVILEGE_IDS.map((p, i) => [p, `00000000-0000-0000-0000-${String(i + 1).padStart(12, '0')}`])) as Record<PrivilegeId, string>;
const cells = (): PrivilegeCells => Object.fromEntries(PRIVILEGE_IDS.map((p) => [p, { kind: 'noGrant' } as CellValue])) as PrivilegeCells;
const row = (roleId = ROLE, name = 'Test role'): RoleRow => ({ roleId, name, cells: cells(), isManaged: false, parentRootRoleId: null });
const matrix = (table: string, rows: RoleRow[]): RoleMatrix => ({ table: { logicalName: table, displayName: table, supported: true }, roles: rows, privilegeCatalog: catalog });

const reader = {} as unknown as SecurityDataReader;
const writer = {} as unknown as SecurityDataWriter;
const config = { reader, writer, actor: 'Owner', environmentId: '00000000-0000-4000-8000-000000000002', onReload: () => undefined };

describe('staging across tables', () => {
  it('refuses to add the same role from another table while changes on the first table are staged, and stages nothing there', () => {
    const { result } = renderHook(() => useRoleEditing(config));
    let first = false;
    act(() => { first = result.current.begin(matrix('account', [row()]), row(), false); });
    expect(first).toBe(true);
    act(() => result.current.stage(ROLE, 'Read', 'Local'));
    let second = true;
    act(() => { second = result.current.begin(matrix('contact', [row()]), row(), false); });
    expect(second).toBe(false);
    expect(result.current.notice).toMatch(/account/);
    // The session on account is untouched: its staged change is still the only one.
    const session = result.current.sessionFor(ROLE, 'account');
    expect(session?.staged.size).toBe(1);
    expect(result.current.sessionFor(ROLE, 'contact')).toBeNull();
  });

  it('adds a second role of the same table', () => {
    const { result } = renderHook(() => useRoleEditing(config));
    const other = row('22222222-2222-2222-2222-222222222222', 'Other role');
    act(() => { result.current.begin(matrix('account', [row(), other]), row(), false); });
    let added = false;
    act(() => { added = result.current.begin(matrix('account', [row(), other]), other, false); });
    expect(added).toBe(true);
    expect(result.current.phase.kind === 'editing' && result.current.phase.sessions.size).toBe(2);
  });
});

describe('a role whose apply call threw', () => {
  const sessionOf = (id: string, name: string) => startEdit({ roleId: id, name, isManaged: false, isRootRole: true, privilegeDataIncomplete: false }, 'account', cells(), catalog);

  it('is shown as an unknown outcome, and only the roles after it as not attempted', () => {
    const a = sessionOf('a', 'Role A');
    const b = sessionOf('b', 'Role B');
    const c = sessionOf('c', 'Role C');
    const editing = {
      phase: {
        kind: 'unknown',
        sessions: new Map([['a', a], ['b', b], ['c', c]]),
        message: 'The change ended with an unexpected error.',
        results: [{ session: b, applied: null, state: 'unknown' }, { session: c, applied: null }],
      },
      finish: () => undefined,
    } as unknown as RoleEditing;
    render(<ResultPanel editing={editing} />);
    expect(screen.getByText(/Unknown outcome\./)).toBeTruthy();
    expect(screen.getByText(/The change to Role B ended with an unexpected error/)).toBeTruthy();
    expect(screen.getAllByText(/Not attempted\./)).toHaveLength(1);
  });
});
