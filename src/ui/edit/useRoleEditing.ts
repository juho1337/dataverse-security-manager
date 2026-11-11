import { useCallback, useRef, useState } from 'react';
import { beginRoleEdit, confirmAndApply, type AppliedEdit } from '../../application/roleEditing/service';
import type { PrivilegeId, RoleMatrix, RoleRow } from '../../domain/privileges';
import { canRedo, canUndo, redo, stage, undo, type EditSession, type HeldDepth } from '../../domain/roleEditing';
import type { SecurityDataReader } from '../../ports/securityDataReader';
import type { SecurityDataWriter } from '../../ports/securityDataWriter';
import { useOperationRecorder } from '../operations/RecorderContext';

// Edit state of the Role Analyzer (issue #267, several roles at once). The domain (domain/roleEditing.ts) holds the rules for ONE role; this
// hook holds one edit session per role of the selected table and sequences the screens: idle -> editing -> previewing -> applying -> done.
// Nothing is written by staging or by opening the preview; the only write path is `confirm`, called after the person pressed Confirm in the
// preview. The roles are applied one after the other, each through the normal single-role path (own approval, own history entry, own re-read);
// after a role that did not end fully verified the rest are NOT attempted.

/** One edit session per role, in the order the roles were first touched (the order they are applied in). */
export type Sessions = ReadonlyMap<string, EditSession>;

/** What happened to one role of an apply: its result, or null when it was not attempted because an earlier role did not complete. */
export interface RoleResult {
  readonly session: EditSession;
  readonly applied: AppliedEdit | null;
  /** Set when `applied` is null: the role was not attempted, or its apply call threw and what was written is not known. */
  readonly state?: 'unknown';
}

export type EditPhase =
  | { readonly kind: 'idle' }
  /** `last` is the role touched last: Undo and Redo act on it. */
  | { readonly kind: 'editing'; readonly sessions: Sessions; readonly last: string }
  | { readonly kind: 'previewing'; readonly sessions: Sessions; readonly last: string }
  | { readonly kind: 'applying'; readonly sessions: Sessions; readonly current: string }
  | { readonly kind: 'done'; readonly sessions: Sessions; readonly results: readonly RoleResult[] }
  /** The apply call itself threw: what was applied is not known until the roles are read again. */
  | { readonly kind: 'unknown'; readonly sessions: Sessions; readonly results: readonly RoleResult[]; readonly message: string };

/** The sessions that have staged changes, in apply order. */
export const changedSessions = (sessions: Sessions): EditSession[] => [...sessions.values()].filter((s) => s.staged.size > 0);

export interface RoleEditingConfig {
  readonly reader: SecurityDataReader;
  /** Null when there is no writer (demo mode, or a host without the Dataverse API): editing is then not offered at all. */
  readonly writer: SecurityDataWriter | null;
  /** Who confirms (recorded in the approval and, later, the operation history). */
  readonly actor: string;
  /** The environment the preview is confirmed for; the write boundary compares it with the approved environment. */
  readonly environmentId: string;
  /** Reload the matrix after an apply (the re-read result is shown first). */
  readonly onReload: () => void;
}

export interface RoleEditing {
  readonly available: boolean;
  readonly phase: EditPhase;
  /** A reason an edit could not start or a change was refused; null when there is nothing to say. */
  readonly notice: string | null;
  /** The edit session of a role on a table, if that role is being edited (the same role id on another table is a different session). */
  sessionFor(roleId: string, table: string): EditSession | null;
  /** Adds the role to the edit (the others stay as they are). True when the role is now part of the edit on this table, false when it was refused. */
  begin(matrix: RoleMatrix, row: RoleRow, matrixIncomplete: boolean): boolean;
  stage(roleId: string, privilege: PrivilegeId, depth: HeldDepth): void;
  /** Undo and Redo act on the role touched last. */
  undo(): void;
  redo(): void;
  canUndo(): boolean;
  canRedo(): boolean;
  /** Drops every staged change of every role. */
  discard(): void;
  /** Drops one role from the edit; the others stay. */
  discardRole(roleId: string): void;
  openPreview(): void;
  cancelPreview(): void;
  confirm(): Promise<void>;
  finish(): void;
}

const sessionsOf = (p: EditPhase): Sessions | null => (p.kind === 'idle' ? null : p.sessions);
const withSession = (sessions: Sessions, session: EditSession): Sessions => new Map(sessions).set(session.role.roleId, session);

export function useRoleEditing(config: RoleEditingConfig): RoleEditing {
  const [phase, setPhaseState] = useState<EditPhase>({ kind: 'idle' });
  const [notice, setNotice] = useState<string | null>(null);
  // The latest phase, readable synchronously by event handlers (a click always follows the render that produced its button).
  const phaseRef = useRef<EditPhase>(phase);
  const applying = useRef(false);
  const setPhase = useCallback((next: EditPhase) => {
    phaseRef.current = next;
    setPhaseState(next);
  }, []);
  const { reader, writer, actor, environmentId, onReload } = config;
  const recorder = useOperationRecorder();

  const editing = (): { sessions: Sessions; last: string } | null => {
    const p = phaseRef.current;
    return p.kind === 'editing' ? { sessions: p.sessions, last: p.last } : null;
  };

  return {
    available: writer !== null,
    phase,
    notice,

    sessionFor(roleId, table) {
      const s = sessionsOf(phase)?.get(roleId);
      return s && s.table === table ? s : null;
    },

    begin(matrix, row, incomplete) {
      const p = phaseRef.current;
      if (p.kind !== 'idle' && p.kind !== 'editing') return false;
      setNotice(null);
      if (p.kind === 'editing') {
        // All roles of one edit are on one table (the same role id on another table is a different set of privileges).
        const other = [...p.sessions.values()][0];
        if (other && other.table !== matrix.table.logicalName) {
          setNotice(`Changes to roles on ${other.table} are still staged. Apply or discard them before editing roles on another table.`);
          return false;
        }
        if (p.sessions.has(row.roleId)) return true;
      }
      const start = beginRoleEdit(matrix, row, incomplete);
      if (!start.ok) {
        setNotice(start.reason);
        return false;
      }
      setPhase({ kind: 'editing', sessions: withSession(p.kind === 'editing' ? p.sessions : new Map(), start.session), last: row.roleId });
      return true;
    },

    stage(roleId, privilege, depth) {
      const e = editing();
      const s = e?.sessions.get(roleId);
      if (!e || !s) return;
      const r = stage(s, privilege, depth);
      if (!r.ok) {
        setNotice(r.reason);
        return;
      }
      setNotice(null);
      setPhase({ kind: 'editing', sessions: withSession(e.sessions, r.session), last: roleId });
    },

    undo() {
      const e = editing();
      const s = e?.sessions.get(e.last);
      if (e && s) setPhase({ kind: 'editing', sessions: withSession(e.sessions, undo(s)), last: e.last });
    },

    redo() {
      const e = editing();
      const s = e?.sessions.get(e.last);
      if (e && s) setPhase({ kind: 'editing', sessions: withSession(e.sessions, redo(s)), last: e.last });
    },

    canUndo() {
      const s = phase.kind === 'editing' ? phase.sessions.get(phase.last) : undefined;
      return s ? canUndo(s) : false;
    },

    canRedo() {
      const s = phase.kind === 'editing' ? phase.sessions.get(phase.last) : undefined;
      return s ? canRedo(s) : false;
    },

    discard() {
      const p = phaseRef.current;
      if (p.kind !== 'editing' && p.kind !== 'previewing') return;
      setNotice(null);
      setPhase({ kind: 'idle' });
    },

    discardRole(roleId) {
      const e = editing();
      if (!e || !e.sessions.has(roleId)) return;
      const rest = new Map(e.sessions);
      rest.delete(roleId);
      setNotice(null);
      const keys = [...rest.keys()];
      const fallback = keys[keys.length - 1];
      setPhase(fallback === undefined ? { kind: 'idle' } : { kind: 'editing', sessions: rest, last: rest.has(e.last) ? e.last : fallback });
    },

    openPreview() {
      const e = editing();
      if (e && changedSessions(e.sessions).length > 0) setPhase({ kind: 'previewing', sessions: e.sessions, last: e.last });
    },

    cancelPreview() {
      const p = phaseRef.current;
      if (p.kind === 'previewing') setPhase({ kind: 'editing', sessions: p.sessions, last: p.last });
    },

    async confirm() {
      const p = phaseRef.current;
      if (p.kind !== 'previewing' || !writer || applying.current) return;
      applying.current = true;
      const { sessions, last } = p;
      const todo = changedSessions(sessions);
      const results: RoleResult[] = [];
      try {
        let stopped = false;
        for (const session of todo) {
          if (stopped) {
            results.push({ session, applied: null });
            continue;
          }
          setPhase({ kind: 'applying', sessions, current: session.role.roleId });
          const applied = await confirmAndApply({ session, writer, reader, actor, environmentId, ...(recorder ? { recorder } : {}) });
          results.push({ session, applied });
          // A role that did not end fully verified stops the run: the roles after it are not touched.
          if (!applied || applied.result.overall !== 'succeeded') stopped = true;
        }
        if (results.length === 0) setPhase({ kind: 'editing', sessions, last });
        else setPhase({ kind: 'done', sessions, results });
      } catch {
        // The role being applied when the call threw has no result: what was applied there is not known. Roles after it were not attempted.
        const known = new Set(results.map((r) => r.session.role.roleId));
        const [unknownRole, ...rest] = todo.filter((s) => !known.has(s.role.roleId));
        setPhase({
          kind: 'unknown',
          sessions,
          results: [
            ...results,
            ...(unknownRole ? [{ session: unknownRole, applied: null, state: 'unknown' as const }] : []),
            ...rest.map((session) => ({ session, applied: null })),
          ],
          message: 'The change ended with an unexpected error. What was applied is not known: read the role again before trying anything else.',
        });
      } finally {
        applying.current = false;
      }
    },

    finish() {
      const p = phaseRef.current;
      if (p.kind !== 'done' && p.kind !== 'unknown') return;
      setNotice(null);
      setPhase({ kind: 'idle' });
      onReload();
    },
  };
}
