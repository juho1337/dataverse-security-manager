import { useEffect, useRef } from 'react';
import type { Outcome } from '../../domain/operations';
import { canRedo, canUndo, changes, orderedChanges, type EditSession, type HeldDepth, type StagedChange } from '../../domain/roleEditing';
import { DEPTH_LABEL, PRIVILEGE_LABEL } from '../labels';
import type { EditPhase, RoleEditing } from './useRoleEditing';

export const depthText = (d: HeldDepth): string => (d === null ? 'Not held' : DEPTH_LABEL[d]);

/** "Read: User -> Business Unit": the change in the labels people see (the domain keeps the canonical ids). */
export const changeText = (c: StagedChange): string => `${PRIVILEGE_LABEL[c.privilege]}: ${depthText(c.original)} → ${depthText(c.target)}`;

const KIND_TEXT: Record<StagedChange['kind'], string> = { add: 'Add', increase: 'Increase', decrease: 'Decrease', remove: 'Remove' };

/** Edit toolbar: what is being edited, the staged changes before/after, Undo / Redo / Discard / Preview. */
export function EditBar({ editing }: { readonly editing: RoleEditing }) {
  const phase = editing.phase;
  if (phase.kind !== 'editing') return null;
  const session = phase.session;
  const list = changes(session);
  return (
    <section className="edit-bar" aria-label="Role editing">
      <p>
        <strong>Editing {session.role.name}</strong> on <code>{session.table}</code>. Nothing is saved until you preview and confirm.{' '}
        <span aria-live="polite">{list.length === 0 ? 'No changes staged.' : `${list.length} change${list.length === 1 ? '' : 's'} staged.`}</span>
      </p>
      <div role="group" aria-label="Editing actions" className="edit-actions">
        <button type="button" onClick={() => editing.undo()} disabled={!canUndo(session)}>Undo</button>
        <button type="button" onClick={() => editing.redo()} disabled={!canRedo(session)}>Redo</button>
        <button type="button" onClick={() => editing.discard()}>Discard</button>
        <button type="button" className="primary" onClick={() => editing.openPreview()} disabled={list.length === 0}>Preview changes</button>
      </div>
      {editing.notice && <p role="alert" className="msg msg-warn">{editing.notice}</p>}
      {list.length > 0 && (
        <ul className="staged-list" aria-label="Staged changes">
          {list.map((c) => (
            <li key={c.privilege}>
              <span className="staged-kind">{KIND_TEXT[c.kind]}</span> {changeText(c)}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

/**
 * The same way forward below the table, pinned to the bottom of the view while editing: a long table pushes the edit toolbar out of sight, and
 * the person who has just changed a cell far down the list should find "Preview" where they are. Its button is named differently from the
 * toolbar's ("Preview 2 changes"), so the two are never confused; Undo, Redo and Discard stay in the toolbar.
 */
export function EditFooter({ editing }: { readonly editing: RoleEditing }) {
  const phase = editing.phase;
  if (phase.kind !== 'editing') return null;
  const count = changes(phase.session).length;
  return (
    <div className="edit-footer" role="group" aria-label="Preview the staged changes">
      <span>
        Editing <strong>{phase.session.role.name}</strong>: {count === 0 ? 'nothing pending yet.' : `${count} pending change${count === 1 ? '' : 's'}.`}
      </span>
      <button type="button" className="primary" onClick={() => editing.openPreview()} disabled={count === 0}>
        {count === 0 ? 'Preview (nothing staged)' : `Preview ${count} change${count === 1 ? '' : 's'}`}
      </button>
    </div>
  );
}

/** Modal preview of exactly what confirming will send. Cancel is the safe default focus; Escape cancels. */
export function PreviewDialog({ editing, environmentLabel }: { readonly editing: RoleEditing; readonly environmentLabel: string }) {
  const phase = editing.phase;
  const cancelRef = useRef<HTMLButtonElement>(null);
  const confirmRef = useRef<HTMLButtonElement>(null);
  const open = phase.kind === 'previewing';
  useEffect(() => {
    if (open) cancelRef.current?.focus();
  }, [open]);
  if (phase.kind !== 'previewing') return null;
  const session: EditSession = phase.session;
  // The order in which the changes are sent: additions and increases first, reductions last.
  const list = orderedChanges(session);
  return (
    <div className="dialog-backdrop">
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="preview-title"
        className="dialog"
        onKeyDown={(e) => {
          if (e.key === 'Escape') {
            e.preventDefault();
            editing.cancelPreview();
          } else if (e.key === 'Tab') {
            // Keep focus inside the dialog.
            const first = cancelRef.current;
            const last = confirmRef.current;
            if (e.shiftKey && document.activeElement === first) {
              e.preventDefault();
              last?.focus();
            } else if (!e.shiftKey && document.activeElement === last) {
              e.preventDefault();
              first?.focus();
            }
          }
        }}
      >
        <h2 id="preview-title">Review changes</h2>
        <p>
          Role <strong>{session.role.name}</strong> on table <code>{session.table}</code>. These changes will be sent to <strong>{environmentLabel}</strong>.
          Only this role record is changed; its Business Unit copies are not touched.
        </p>
        <table className="preview-table">
          <caption className="sr-only">Changes in the order they are applied</caption>
          <thead>
            <tr><th scope="col">Privilege</th><th scope="col">Current</th><th scope="col">New</th><th scope="col">Change</th></tr>
          </thead>
          <tbody>
            {list.map((c) => (
              <tr key={c.privilege}>
                <th scope="row">{PRIVILEGE_LABEL[c.privilege]}</th>
                <td>{depthText(c.original)}</td>
                <td>{depthText(c.target)}</td>
                <td>{KIND_TEXT[c.kind]}</td>
              </tr>
            ))}
          </tbody>
        </table>
        <p className="hint">After applying, the role is read again and every change is checked against what Dataverse then holds.</p>
        <div className="dialog-actions">
          <button type="button" ref={cancelRef} onClick={() => editing.cancelPreview()}>Cancel</button>
          <button type="button" ref={confirmRef} className="primary" onClick={() => void editing.confirm()}>Confirm and apply</button>
        </div>
      </div>
    </div>
  );
}

const OUTCOME_TEXT: Record<Outcome, string> = {
  succeeded: 'Verified',
  failed: 'Failed',
  skipped: 'Not attempted',
  partiallyApplied: 'Partly applied',
  notVerified: 'Accepted, not verified',
  uncertain: 'Uncertain',
};

const OVERALL_TEXT: Record<Outcome, string> = {
  succeeded: 'All changes were applied and confirmed by reading the role again.',
  failed: 'No change was applied.',
  skipped: 'Nothing was attempted.',
  partiallyApplied: 'Some changes were applied and some were not. The table shows which.',
  notVerified: 'Dataverse accepted the changes, but they could not be confirmed by a re-read. Treat them as not verified.',
  uncertain: 'The outcome is uncertain. Read the role again before trying anything else.',
};

function ResultBody({ phase }: { readonly phase: Extract<EditPhase, { kind: 'done' }> }) {
  const { result } = phase.applied;
  const bad = result.overall !== 'succeeded';
  return (
    <>
      <p role={bad ? 'alert' : 'status'} className={`msg ${bad ? 'msg-warn' : 'msg-ok'}`}>
        <strong>{OUTCOME_TEXT[result.overall]}.</strong> {OVERALL_TEXT[result.overall]}
        {!result.verified && ' The re-read could not be fully interpreted.'}
      </p>
      <table className="preview-table">
        <caption className="sr-only">Result of each change</caption>
        <thead>
          <tr><th scope="col">Privilege</th><th scope="col">Intended</th><th scope="col">Found after re-read</th><th scope="col">Outcome</th><th scope="col">Detail</th></tr>
        </thead>
        <tbody>
          {result.items.map((i) => (
            <tr key={i.change.privilege} data-outcome={i.outcome}>
              <th scope="row">{PRIVILEGE_LABEL[i.change.privilege]}</th>
              <td>{depthText(i.change.original)} {'→'} {depthText(i.change.target)}</td>
              <td>{i.foundKnown ? depthText(i.foundDepth) : 'Unknown (not read)'}</td>
              <td><strong>{OUTCOME_TEXT[i.outcome]}</strong></td>
              <td>{i.message}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </>
  );
}

/** Applying, per-change result (verified / failed / not attempted / not verified / uncertain) and the unknown-outcome case. */
export function ResultPanel({ editing }: { readonly editing: RoleEditing }) {
  const phase = editing.phase;
  if (phase.kind === 'applying') {
    return (
      <section className="edit-result" aria-label="Applying changes">
        <p role="status" className="hint">Applying changes to {phase.session.role.name}… Do not close this window.</p>
      </section>
    );
  }
  if (phase.kind === 'unknown') {
    return (
      <section className="edit-result" aria-label="Edit result">
        <p role="alert" className="msg msg-error">{phase.message}</p>
        <button type="button" onClick={() => editing.finish()}>Close and reload the role</button>
      </section>
    );
  }
  if (phase.kind !== 'done') return null;
  return (
    <section className="edit-result" aria-label="Edit result">
      <h3>Result for {phase.session.role.name} on <code>{phase.session.table}</code></h3>
      <ResultBody phase={phase} />
      <button type="button" className="primary" onClick={() => editing.finish()}>Close and reload the role</button>
    </section>
  );
}
