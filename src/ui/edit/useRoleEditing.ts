import { useCallback, useRef, useState } from 'react';
import { beginRoleEdit, confirmAndApply, type AppliedEdit } from '../../application/roleEditing/service';
import type { PrivilegeId, RoleMatrix, RoleRow } from '../../domain/privileges';
import { redo, stage, undo, type EditSession, type HeldDepth } from '../../domain/roleEditing';
import type { SecurityDataReader } from '../../ports/securityDataReader';
import type { SecurityDataWriter } from '../../ports/securityDataWriter';
import { useOperationRecorder } from '../operations/RecorderContext';

// Edit state of the Role Analyzer (issue #267). The domain (domain/roleEditing.ts) holds the rules; this hook only sequences the screens:
// idle -> editing -> previewing -> applying -> done. Nothing is written by staging or by opening the preview; the only write path is
// `confirm`, called after the person pressed Confirm in the preview.

export type EditPhase =
  | { readonly kind: 'idle' }
  | { readonly kind: 'editing'; readonly session: EditSession }
  | { readonly kind: 'previewing'; readonly session: EditSession }
  | { readonly kind: 'applying'; readonly session: EditSession }
  | { readonly kind: 'done'; readonly session: EditSession; readonly applied: AppliedEdit }
  /** The apply call itself threw: what was applied is not known until the role is read again. */
  | { readonly kind: 'unknown'; readonly session: EditSession; readonly message: string };

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
  /** The role currently being edited, if any. */
  readonly editingRoleId: string | null;
  begin(matrix: RoleMatrix, row: RoleRow, matrixIncomplete: boolean): void;
  stage(privilege: PrivilegeId, depth: HeldDepth): void;
  undo(): void;
  redo(): void;
  discard(): void;
  openPreview(): void;
  cancelPreview(): void;
  confirm(): Promise<void>;
  finish(): void;
}

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

  const editingSession = (): EditSession | null => (phaseRef.current.kind === 'editing' ? phaseRef.current.session : null);

  return {
    available: writer !== null,
    phase,
    notice,
    editingRoleId: phase.kind === 'idle' ? null : phase.session.role.roleId,

    begin(matrix, row, incomplete) {
      if (phaseRef.current.kind !== 'idle') return;
      setNotice(null);
      const start = beginRoleEdit(matrix, row, incomplete);
      if (!start.ok) {
        setNotice(start.reason);
        return;
      }
      setPhase({ kind: 'editing', session: start.session });
    },

    stage(privilege, depth) {
      const s = editingSession();
      if (!s) return;
      const r = stage(s, privilege, depth);
      if (!r.ok) {
        setNotice(r.reason);
        return;
      }
      setNotice(null);
      setPhase({ kind: 'editing', session: r.session });
    },

    undo() {
      const s = editingSession();
      if (s) setPhase({ kind: 'editing', session: undo(s) });
    },

    redo() {
      const s = editingSession();
      if (s) setPhase({ kind: 'editing', session: redo(s) });
    },

    discard() {
      const p = phaseRef.current;
      if (p.kind !== 'editing' && p.kind !== 'previewing') return;
      setNotice(null);
      setPhase({ kind: 'idle' });
    },

    openPreview() {
      const s = editingSession();
      if (s && s.staged.size > 0) setPhase({ kind: 'previewing', session: s });
    },

    cancelPreview() {
      const p = phaseRef.current;
      if (p.kind === 'previewing') setPhase({ kind: 'editing', session: p.session });
    },

    async confirm() {
      const p = phaseRef.current;
      if (p.kind !== 'previewing' || !writer || applying.current) return;
      applying.current = true;
      const session = p.session;
      setPhase({ kind: 'applying', session });
      try {
        const applied = await confirmAndApply({ session, writer, reader, actor, environmentId, ...(recorder ? { recorder } : {}) });
        setPhase(applied ? { kind: 'done', session, applied } : { kind: 'editing', session });
      } catch {
        setPhase({
          kind: 'unknown',
          session,
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
