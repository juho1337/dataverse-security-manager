import { createWritePlan, plannedWrite, type GrantDepth, type PlannedWrite, type WritePlan } from './operations';
import { PRIVILEGE_IDS, type CellValue, type PrivilegeCells, type PrivilegeId } from './privileges';

// Staged editing of the privileges of ONE concrete role record on ONE table (issue #266). Pure and host-free: staging only
// records a wish, original and staged value are kept side by side, and nothing here writes. Mirrors the XrmToolBox
// RoleEditSession / RoleEditability rules. An edit always targets one explicitly identified role id; it is never widened to the
// Business Unit copies of a role.

/** Depth a role holds a privilege at, or null when it does not hold it (a removal as a target). */
export type HeldDepth = GrantDepth | null;

export interface EditableRoleInfo {
  /** The concrete role record being edited (one Business Unit instance). */
  readonly roleId: string;
  readonly name: string;
  readonly isManaged: boolean;
  /** True for a root role; false for a Business Unit copy inherited from a root. */
  readonly isRootRole: boolean;
  /** For a copy: the root role to edit instead, when it is present in the loaded data. */
  readonly rootRoleId?: string;
  readonly rootRoleName?: string;
  /** The privileges of the roles could not be read completely, so a change could not be checked afterwards. */
  readonly privilegeDataIncomplete: boolean;
}

export type EditTarget =
  | { readonly canEdit: true }
  | { readonly canEdit: false; readonly reason: string; readonly redirectToRoleId?: string };

/**
 * Conservative on purpose: only a non-managed root role with completely read privileges is editable. What happens to the root and to
 * sibling copies when a copy is changed directly is not verified against a real environment, so a copy is blocked and the root named.
 */
export function evaluateEditability(role: EditableRoleInfo): EditTarget {
  if (role.isManaged) return { canEdit: false, reason: 'Managed roles belong to a solution and cannot be edited here.' };
  if (role.privilegeDataIncomplete) {
    return {
      canEdit: false,
      reason: 'The privileges of the roles could not be read completely, so a change cannot be checked afterwards. Reload the data first.',
    };
  }
  if (role.isRootRole) return { canEdit: true };
  if (!role.rootRoleId) {
    return {
      canEdit: false,
      reason: 'This is a Business Unit copy of a role whose root role is not in the loaded data, so the correct role to edit cannot be identified.',
    };
  }
  return {
    canEdit: false,
    reason: `This is a Business Unit copy, inherited from the root role${role.rootRoleName ? ` "${role.rootRoleName}"` : ''}. Edit the root role instead; direct changes to a copy are not offered because their effect on the root and on the other copies is not verified.`,
    redirectToRoleId: role.rootRoleId,
  };
}

/** Privilege ids (Dataverse privilege GUIDs) of the table, by operation. Absent = the table has no such privilege. */
export type PrivilegeCatalog = Readonly<Partial<Record<PrivilegeId, string>>>;

export type ChangeKind = 'add' | 'increase' | 'decrease' | 'remove';

const DEPTH_ORDER: Record<GrantDepth, number> = { Basic: 1, Local: 2, Deep: 3, Global: 4 };

export interface StagedChange {
  readonly table: string;
  readonly privilege: PrivilegeId;
  readonly privilegeId: string;
  /** Depth the role has now; null when it does not hold the privilege. */
  readonly original: HeldDepth;
  /** Depth wanted; null removes the privilege. */
  readonly target: HeldDepth;
  readonly kind: ChangeKind;
}

export function changeKind(original: HeldDepth, target: HeldDepth): ChangeKind {
  if (target === null) return 'remove';
  if (original === null) return 'add';
  return DEPTH_ORDER[target] > DEPTH_ORDER[original] ? 'increase' : 'decrease';
}

/** Why a cell cannot be edited, or null when it can. */
export function cellEditProblem(cell: CellValue): string | null {
  if (cell.kind === 'unknown') return 'This value could not be read, so it cannot be edited. Reload the data first.';
  if (cell.kind === 'notApplicable') return 'The table has no such privilege, so it cannot be granted.';
  return null;
}

/** The depth held according to a matrix cell: `None` and `noGrant` both mean the role does not hold the privilege. */
export function heldDepthOf(cell: CellValue): HeldDepth {
  if (cell.kind === 'depth' && cell.depth !== 'None') return cell.depth;
  return null;
}

export function describeDepth(depth: HeldDepth): string {
  return depth === null ? 'not held' : depth;
}

export function describeChange(c: StagedChange): string {
  return `${c.table} ${c.privilege}: ${describeDepth(c.original)} -> ${describeDepth(c.target)}`;
}

type StagedMap = ReadonlyMap<PrivilegeId, StagedChange>;

/** Immutable edit session. Every function returns a new session; the previous value stays valid. */
export interface EditSession {
  readonly role: EditableRoleInfo;
  readonly table: string;
  readonly original: PrivilegeCells;
  readonly catalog: PrivilegeCatalog;
  readonly staged: StagedMap;
  readonly past: readonly StagedMap[];
  readonly future: readonly StagedMap[];
}

export function startEdit(role: EditableRoleInfo, table: string, original: PrivilegeCells, catalog: PrivilegeCatalog): EditSession {
  return { role, table, original, catalog, staged: new Map(), past: [], future: [] };
}

export type StageResult = { readonly ok: true; readonly session: EditSession } | { readonly ok: false; readonly reason: string };

function push(session: EditSession, next: StagedMap): EditSession {
  return { ...session, staged: next, past: [...session.past, session.staged], future: [] };
}

/**
 * Stage a new depth for one privilege (null removes it). Refused, with a reason, when the role may not be edited, the cell is unknown or
 * not applicable, or the privilege has no id in the catalog. Staging the original value again clears the staged change.
 */
export function stage(session: EditSession, privilege: PrivilegeId, target: HeldDepth): StageResult {
  const editable = evaluateEditability(session.role);
  if (!editable.canEdit) return { ok: false, reason: editable.reason };
  const cell = session.original[privilege];
  const problem = cellEditProblem(cell);
  if (problem) return { ok: false, reason: problem };
  const privilegeId = session.catalog[privilege];
  if (!privilegeId) return { ok: false, reason: `${session.table} has no ${privilege} privilege, so it cannot be granted.` };

  const original = heldDepthOf(cell);
  const current = session.staged.get(privilege);
  const currentTarget = current ? current.target : original;
  if (currentTarget === target) return { ok: true, session };
  const next = new Map(session.staged);
  if (original === target) next.delete(privilege);
  else next.set(privilege, { table: session.table, privilege, privilegeId, original, target, kind: changeKind(original, target) });
  return { ok: true, session: push(session, next) };
}

/** Depth the matrix shows while editing (staged value when there is one). */
export function currentDepth(session: EditSession, privilege: PrivilegeId): HeldDepth {
  const c = session.staged.get(privilege);
  return c ? c.target : heldDepthOf(session.original[privilege]);
}

export function originalDepth(session: EditSession, privilege: PrivilegeId): HeldDepth {
  return heldDepthOf(session.original[privilege]);
}

export function isChanged(session: EditSession, privilege: PrivilegeId): boolean {
  return session.staged.has(privilege);
}

export function hasChanges(session: EditSession): boolean {
  return session.staged.size > 0;
}

/** Staged changes in the matrix's fixed privilege order. */
export function changes(session: EditSession): readonly StagedChange[] {
  return PRIVILEGE_IDS.flatMap((p) => {
    const c = session.staged.get(p);
    return c ? [c] : [];
  });
}

const KIND_ORDER: Record<ChangeKind, number> = { add: 0, increase: 1, decrease: 2, remove: 3 };

/**
 * Execution order: additions and depth increases first, reductions (decreases, removals) last, matrix order inside a group. A reduction
 * is only sent once every earlier addition is confirmed by a re-read, so a role is never left with less access than before or after.
 */
export function orderedChanges(session: EditSession): readonly StagedChange[] {
  return [...changes(session)].sort((a, b) => KIND_ORDER[a.kind] - KIND_ORDER[b.kind]);
}

export const canUndo = (s: EditSession): boolean => s.past.length > 0;
export const canRedo = (s: EditSession): boolean => s.future.length > 0;

export function undo(session: EditSession): EditSession {
  const previous = session.past[session.past.length - 1];
  if (!previous) return session;
  return { ...session, staged: previous, past: session.past.slice(0, -1), future: [session.staged, ...session.future] };
}

export function redo(session: EditSession): EditSession {
  const next = session.future[0];
  if (!next) return session;
  return { ...session, staged: next, past: [...session.past, session.staged], future: session.future.slice(1) };
}

/** Clears the staged change of one privilege (undoable). */
export function revertPrivilege(session: EditSession, privilege: PrivilegeId): EditSession {
  if (!session.staged.has(privilege)) return session;
  const next = new Map(session.staged);
  next.delete(privilege);
  return push(session, next);
}

/** Discards every staged change and the history. The role's original state is untouched. */
export function discard(session: EditSession): EditSession {
  return { ...session, staged: new Map(), past: [], future: [] };
}

/** An explicit, reviewable preview of what confirming would send. Nothing is written by building it. */
export interface EditPreview {
  readonly roleId: string;
  readonly roleName: string;
  readonly table: string;
  readonly lines: readonly { readonly privilege: PrivilegeId; readonly kind: ChangeKind; readonly text: string }[];
}

export function preview(session: EditSession): EditPreview {
  return {
    roleId: session.role.roleId,
    roleName: session.role.name,
    table: session.table,
    lines: changes(session).map((c) => ({ privilege: c.privilege, kind: c.kind, text: describeChange(c) })),
  };
}

function writeFor(session: EditSession, c: StagedChange): PlannedWrite {
  const description = `${session.role.name}: ${describeChange(c)}`;
  return c.target === null
    ? plannedWrite.removePrivilege(session.role.roleId, c.privilegeId, description)
    : plannedWrite.addPrivilege(session.role.roleId, c.privilegeId, c.target, description);
}

/**
 * The exact writes for the staged changes, to be confirmed by a person. Add, increase and decrease are all `addPrivilege` (it adds the
 * privilege or changes its depth). Returns null when nothing is staged or the role may not be edited.
 */
export function toWritePlan(session: EditSession): WritePlan | null {
  if (!evaluateEditability(session.role).canEdit) return null;
  const list = orderedChanges(session);
  if (list.length === 0) return null;
  return createWritePlan(list.map((c) => writeFor(session, c)));
}

/** What a re-read must show after a successful apply: the staged targets over the original, per privilege. */
export function expectedDepths(session: EditSession): Readonly<Partial<Record<PrivilegeId, HeldDepth>>> {
  const out: Partial<Record<PrivilegeId, HeldDepth>> = {};
  for (const c of changes(session)) out[c.privilege] = c.target;
  return out;
}

/** Compares a re-read matrix row with the staged expectation. Unknown cells make the result `unverifiable`, never a pass. */
export type VerifyResult =
  | { readonly status: 'verified' }
  | { readonly status: 'mismatch'; readonly differences: readonly { readonly privilege: PrivilegeId; readonly expected: HeldDepth; readonly actual: HeldDepth }[] }
  | { readonly status: 'unverifiable'; readonly privileges: readonly PrivilegeId[] };

export function verifyAfterApply(session: EditSession, reread: PrivilegeCells): VerifyResult {
  const unknown: PrivilegeId[] = [];
  const diffs: { privilege: PrivilegeId; expected: HeldDepth; actual: HeldDepth }[] = [];
  for (const p of PRIVILEGE_IDS) {
    const expected = currentDepth(session, p);
    const cell = reread[p];
    if (cell.kind === 'unknown') {
      if (session.staged.has(p) || session.original[p].kind !== 'unknown') unknown.push(p);
      continue;
    }
    if (cell.kind === 'notApplicable') continue;
    const actual = heldDepthOf(cell);
    if (actual !== expected) diffs.push({ privilege: p, expected, actual });
  }
  if (diffs.length > 0) return { status: 'mismatch', differences: diffs };
  if (unknown.length > 0) return { status: 'unverifiable', privileges: unknown };
  return { status: 'verified' };
}

/** The four depth columns, lowest to highest. */
export const GRANT_DEPTHS: readonly GrantDepth[] = ['Basic', 'Local', 'Deep', 'Global'];
