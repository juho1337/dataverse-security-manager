import { describe, expect, it } from 'vitest';
import type { CellValue, PrivilegeCells, PrivilegeId } from './privileges';
import { PRIVILEGE_IDS } from './privileges';
import {
  canRedo,
  canUndo,
  changeKind,
  changes,
  currentDepth,
  discard,
  evaluateEditability,
  expectedDepths,
  hasChanges,
  orderedChanges,
  preview,
  redo,
  revertPrivilege,
  stage,
  startEdit,
  toWritePlan,
  undo,
  verifyAfterApply,
  type EditSession,
  type EditableRoleInfo,
  type PrivilegeCatalog,
} from './roleEditing';

const ROLE = '11111111-1111-1111-1111-111111111111';
const priv = (n: number) => `00000000-0000-0000-0000-${String(n).padStart(12, '0')}`;
const CATALOG: PrivilegeCatalog = Object.fromEntries(PRIVILEGE_IDS.filter((p) => p !== 'Share').map((p, i) => [p, priv(i + 1)]));

const editable: EditableRoleInfo = { roleId: ROLE, name: 'Test role', isManaged: false, isRootRole: true, privilegeDataIncomplete: false };

function cells(over: Partial<Record<PrivilegeId, CellValue>> = {}): PrivilegeCells {
  const base = Object.fromEntries(PRIVILEGE_IDS.map((p) => [p, { kind: 'noGrant' } as CellValue])) as Record<PrivilegeId, CellValue>;
  return { ...base, ...over };
}
const depth = (d: 'None' | 'Basic' | 'Local' | 'Deep' | 'Global'): CellValue => ({ kind: 'depth', depth: d });

function session(over: Partial<Record<PrivilegeId, CellValue>> = { Read: depth('Basic') }, role: EditableRoleInfo = editable): EditSession {
  return startEdit(role, 'account', cells(over), CATALOG);
}
function must(r: ReturnType<typeof stage>): EditSession {
  if (!r.ok) throw new Error(r.reason);
  return r.session;
}

describe('editability', () => {
  it('allows only a non-managed root role with complete data', () => {
    expect(evaluateEditability(editable)).toEqual({ canEdit: true });
    expect(evaluateEditability({ ...editable, isManaged: true })).toMatchObject({ canEdit: false });
    expect(evaluateEditability({ ...editable, privilegeDataIncomplete: true })).toMatchObject({ canEdit: false });
  });

  it('blocks a Business Unit copy and names the root to edit instead', () => {
    const r = evaluateEditability({ ...editable, isRootRole: false, rootRoleId: 'root-id', rootRoleName: 'Sales' });
    expect(r).toMatchObject({ canEdit: false, redirectToRoleId: 'root-id' });
    expect(r.canEdit === false && r.reason).toMatch(/Sales/);
  });

  it('blocks a copy whose root is not loaded, without a redirect', () => {
    const r = evaluateEditability({ ...editable, isRootRole: false });
    expect(r).toMatchObject({ canEdit: false });
    expect(r.canEdit === false && r.redirectToRoleId).toBeUndefined();
  });

  it('refuses to stage on a role that may not be edited', () => {
    const r = stage(session({ Read: depth('Basic') }, { ...editable, isManaged: true }), 'Read', 'Global');
    expect(r.ok).toBe(false);
  });
});

describe('staging', () => {
  it('keeps original and staged depth side by side and classifies the change', () => {
    const s = must(stage(session(), 'Read', 'Local'));
    expect(currentDepth(s, 'Read')).toBe('Local');
    expect(changes(s)).toMatchObject([{ privilege: 'Read', original: 'Basic', target: 'Local', kind: 'increase' }]);
    expect(changeKind('Local', 'Basic')).toBe('decrease');
    expect(changeKind(null, 'Basic')).toBe('add');
    expect(changeKind('Basic', null)).toBe('remove');
  });

  it('treats None and noGrant as not held, so granting from either is an add', () => {
    const s = session({ Read: depth('None'), Write: { kind: 'noGrant' } });
    expect(changes(must(stage(s, 'Read', 'Basic')))[0]).toMatchObject({ original: null, kind: 'add' });
    expect(changes(must(stage(s, 'Write', 'Basic')))[0]).toMatchObject({ original: null, kind: 'add' });
  });

  it('staging the original value again clears the staged change', () => {
    const s = must(stage(must(stage(session(), 'Read', 'Deep')), 'Read', 'Basic'));
    expect(hasChanges(s)).toBe(false);
  });

  it('refuses unknown and not-applicable cells and privileges missing from the catalog', () => {
    expect(stage(session({ Read: { kind: 'unknown' } }), 'Read', 'Basic')).toMatchObject({ ok: false });
    expect(stage(session({ Assign: { kind: 'notApplicable' } }), 'Assign', 'Basic')).toMatchObject({ ok: false });
    const r = stage(session({ Share: { kind: 'noGrant' } }), 'Share', 'Basic');
    expect(r).toMatchObject({ ok: false });
  });

  it('is immutable: staging returns a new session and leaves the previous one unchanged', () => {
    const a = session();
    const b = must(stage(a, 'Read', 'Deep'));
    expect(hasChanges(a)).toBe(false);
    expect(hasChanges(b)).toBe(true);
  });
});

describe('undo, redo, revert, discard', () => {
  it('undoes and redoes one change at a time', () => {
    const s1 = must(stage(session(), 'Read', 'Local'));
    const s2 = must(stage(s1, 'Write', 'Basic'));
    expect(canUndo(s2)).toBe(true);
    const u = undo(s2);
    expect(changes(u).map((c) => c.privilege)).toEqual(['Read']);
    expect(canRedo(u)).toBe(true);
    expect(changes(redo(u)).map((c) => c.privilege)).toEqual(['Read', 'Write']);
  });

  it('a new change after an undo drops the redo history', () => {
    const s1 = must(stage(session(), 'Read', 'Local'));
    const u = undo(s1);
    expect(canRedo(must(stage(u, 'Write', 'Basic')))).toBe(false);
  });

  it('reverts one privilege (undoable) and discards everything including history', () => {
    const s = must(stage(must(stage(session(), 'Read', 'Local')), 'Write', 'Basic'));
    const r = revertPrivilege(s, 'Read');
    expect(changes(r).map((c) => c.privilege)).toEqual(['Write']);
    expect(changes(undo(r)).map((c) => c.privilege)).toEqual(['Read', 'Write']);
    const d = discard(s);
    expect(hasChanges(d)).toBe(false);
    expect(canUndo(d) || canRedo(d)).toBe(false);
  });

  it('undo with nothing to undo is a no-op', () => {
    const s = session();
    expect(undo(s)).toBe(s);
    expect(redo(s)).toBe(s);
  });
});

describe('preview and write plan', () => {
  const s = must(stage(must(stage(must(stage(session({ Read: depth('Basic'), Delete: depth('Deep') }), 'Delete', null)), 'Write', 'Local')), 'Read', 'Global'));

  it('previews exactly the staged changes of the one role instance', () => {
    const p = preview(s);
    expect(p).toMatchObject({ roleId: ROLE, roleName: 'Test role', table: 'account' });
    expect(p.lines.map((l) => l.text)).toEqual([
      'account Read: Basic -> Global',
      'account Write: not held -> Local',
      'account Delete: Deep -> not held',
    ]);
  });

  it('orders additions and increases before reductions', () => {
    expect(orderedChanges(s).map((c) => c.kind)).toEqual(['add', 'increase', 'remove']);
  });

  it('builds one planned write per change for this role id, never for other roles', () => {
    const plan = toWritePlan(s);
    expect(plan?.writes.map((w) => w.kind)).toEqual(['addPrivilege', 'addPrivilege', 'removePrivilege']);
    for (const w of plan?.writes ?? []) expect('roleId' in w && w.roleId).toBe(ROLE);
  });

  it('builds no plan when nothing is staged', () => {
    expect(toWritePlan(session())).toBeNull();
  });

  it('the plan hash changes when a staged value changes', () => {
    const other = must(stage(s, 'Read', 'Deep'));
    expect(toWritePlan(other)?.hash).not.toBe(toWritePlan(s)?.hash);
  });

  it('exposes the expected end state for verification', () => {
    expect(expectedDepths(s)).toEqual({ Read: 'Global', Write: 'Local', Delete: null });
  });
});

describe('verification after apply', () => {
  const s = must(stage(session({ Read: depth('Basic') }), 'Read', 'Local'));

  it('verifies when the re-read shows the staged depth and the untouched cells unchanged', () => {
    expect(verifyAfterApply(s, cells({ Read: depth('Local') }))).toEqual({ status: 'verified' });
  });

  it('reports a mismatch with expected and actual', () => {
    expect(verifyAfterApply(s, cells({ Read: depth('Basic') }))).toMatchObject({
      status: 'mismatch',
      differences: [{ privilege: 'Read', expected: 'Local', actual: 'Basic' }],
    });
  });

  it('is unverifiable, never a pass, when a staged cell comes back unknown', () => {
    expect(verifyAfterApply(s, cells({ Read: { kind: 'unknown' } }))).toEqual({ status: 'unverifiable', privileges: ['Read'] });
  });
});
