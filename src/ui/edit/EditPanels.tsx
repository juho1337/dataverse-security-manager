import { useEffect, useRef } from 'react';
import type { Outcome } from '../../domain/operations';
import { changes, orderedChanges, type EditSession, type HeldDepth, type StagedChange } from '../../domain/roleEditing';
import { DEPTH_LABEL, PRIVILEGE_LABEL } from '../labels';
import { changedSessions, type RoleEditing, type RoleResult } from './useRoleEditing';

export const depthText = (d: HeldDepth): string => (d === null ? 'Not held' : DEPTH_LABEL[d]);

/** "Read: User -> Business Unit": the change in the labels people see (the domain keeps the canonical ids). */
export const changeText = (c: StagedChange): string => `${PRIVILEGE_LABEL[c.privilege]}: ${depthText(c.original)} → ${depthText(c.target)}`;

const KIND_TEXT: Record<StagedChange['kind'], string> = { add: 'Add', increase: 'Increase', decrease: 'Decrease', remove: 'Remove' };

const plural = (n: number, one: string, many: string): string => `${n} ${n === 1 ? one : many}`;
const totalChanges = (sessions: Iterable<EditSession>): number => [...sessions].reduce((n, s) => n + changes(s).length, 0);

/** Edit toolbar: what is being edited, the staged changes before/after, Undo / Redo / Discard / Preview. */
export function EditBar({ editing }: { readonly editing: RoleEditing }) {
  const phase = editing.phase;
  if (phase.kind !== 'editing') return null;
  const all = [...phase.sessions.values()];
  const total = totalChanges(all);
  const single = all.length === 1 ? all[0] : undefined;
  const table = all[0]?.table ?? '';
  const last = phase.sessions.get(phase.last);
  return (
    <section className="edit-bar" aria-label="Role editing">
      <p>
        {single ? (
          <strong>Editing {single.role.name}</strong>
        ) : (
          <strong>Editing {all.length} roles</strong>
        )}{' '}
        on <code>{table}</code>. Nothing is saved until you preview and confirm.{' '}
        <span aria-live="polite">{total === 0 ? 'No changes staged.' : `${total} change${total === 1 ? '' : 's'} staged.`}</span>
      </p>
      <div role="group" aria-label="Editing actions" className="edit-actions">
        <button type="button" onClick={() => editing.undo()} disabled={!editing.canUndo()} title={last && !single ? `Undo the last change to ${last.role.name}` : undefined}>Undo</button>
        <button type="button" onClick={() => editing.redo()} disabled={!editing.canRedo()} title={last && !single ? `Redo the last undone change to ${last.role.name}` : undefined}>Redo</button>
        <button type="button" onClick={() => editing.discard()}>Discard</button>
        <button type="button" className="primary" onClick={() => editing.openPreview()} disabled={total === 0}>Preview changes</button>
      </div>
      {editing.notice && <p role="alert" className="msg msg-warn">{editing.notice}</p>}
      {single && total > 0 && (
        <ul className="staged-list" aria-label="Staged changes">
          {changes(single).map((c) => (
            <li key={c.privilege}>
              <span className="staged-kind">{KIND_TEXT[c.kind]}</span> {changeText(c)}
            </li>
          ))}
        </ul>
      )}
      {!single && (
        <ul className="staged-list staged-roles" aria-label="Staged changes">
          {all.map((s) => {
            const list = changes(s);
            return (
              <li key={s.role.roleId}>
                <strong>{s.role.name}</strong>: {list.length === 0 ? 'no changes' : plural(list.length, 'change', 'changes')}{' '}
                <button type="button" className="link-button" onClick={() => editing.discardRole(s.role.roleId)} aria-label={`Remove ${s.role.name} from the edit`}>Remove</button>
                {list.length > 0 && (
                  <ul>
                    {list.map((c) => (
                      <li key={c.privilege}>
                        <span className="staged-kind">{KIND_TEXT[c.kind]}</span> {changeText(c)}
                      </li>
                    ))}
                  </ul>
                )}
              </li>
            );
          })}
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
  const all = [...phase.sessions.values()];
  const count = totalChanges(all);
  const single = all.length === 1 ? all[0] : undefined;
  return (
    <div className="edit-footer" role="group" aria-label="Preview the staged changes">
      <span>
        {single ? (
          <>Editing <strong>{single.role.name}</strong>: </>
        ) : (
          <>Editing <strong>{all.length} roles</strong>: </>
        )}
        {count === 0 ? 'nothing pending yet.' : `${count} pending change${count === 1 ? '' : 's'}.`}
      </span>
      <button type="button" className="primary" onClick={() => editing.openPreview()} disabled={count === 0}>
        {count === 0 ? 'Preview (nothing staged)' : `Preview ${count} change${count === 1 ? '' : 's'}`}
      </button>
    </div>
  );
}

function PreviewTable({ session }: { readonly session: EditSession }) {
  // The order in which the changes are sent: additions and increases first, reductions last.
  const list = orderedChanges(session);
  return (
    <table className="preview-table">
      <caption className="sr-only">Changes to {session.role.name} in the order they are applied</caption>
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
  const sessions = changedSessions(phase.sessions);
  const single = sessions.length === 1 ? sessions[0] : undefined;
  const table = sessions[0]?.table ?? '';
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
        {single ? (
          <>
            <p>
              Role <strong>{single.role.name}</strong> on table <code>{single.table}</code>. These changes will be sent to <strong>{environmentLabel}</strong>.
              Only this role record is changed; its Business Unit copies are not touched.
            </p>
            <PreviewTable session={single} />
          </>
        ) : (
          <>
            <p>
              {sessions.length} roles on table <code>{table}</code>. These changes will be sent to <strong>{environmentLabel}</strong>.
              Only these role records are changed; their Business Unit copies are not touched.
            </p>
            <p className="hint">
              The roles are changed one after the other, each with its own check and history entry. If a role does not end fully verified, the roles after it are not changed.
            </p>
            {sessions.map((s) => (
              <section key={s.role.roleId} aria-label={`Changes to ${s.role.name}`}>
                <h3>{s.role.name}</h3>
                <PreviewTable session={s} />
              </section>
            ))}
          </>
        )}
        <p className="hint">After applying, {single ? 'the role is' : 'each role is'} read again and every change is checked against what Dataverse then holds.</p>
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

function ResultBody({ role }: { readonly role: RoleResult & { readonly applied: NonNullable<RoleResult['applied']> } }) {
  const { result } = role.applied;
  const bad = result.overall !== 'succeeded';
  return (
    <>
      <p role={bad ? 'alert' : 'status'} className={`msg ${bad ? 'msg-warn' : 'msg-ok'}`}>
        <strong>{OUTCOME_TEXT[result.overall]}.</strong> {OVERALL_TEXT[result.overall]}
        {!result.verified && ' The re-read could not be fully interpreted.'}
      </p>
      <table className="preview-table">
        <caption className="sr-only">Result of each change to {role.session.role.name}</caption>
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

function NotAttempted({ session }: { readonly session: EditSession }) {
  return (
    <p role="alert" className="msg msg-warn">
      <strong>Not attempted.</strong> An earlier role did not end fully verified, so no change was sent to {session.role.name}. Its staged changes were not applied.
    </p>
  );
}

function UnknownOutcome({ session }: { readonly session: EditSession }) {
  return (
    <p role="alert" className="msg msg-error">
      <strong>Unknown outcome.</strong> The change to {session.role.name} ended with an unexpected error. What was written is not known: read the role again before trying anything else.
    </p>
  );
}

function RoleResultSection({ r, showName }: { readonly r: RoleResult; readonly showName: boolean }) {
  return (
    <section aria-label={`Result for ${r.session.role.name}`}>
      <h3>{showName ? '' : 'Result for '}{r.session.role.name} on <code>{r.session.table}</code></h3>
      {r.applied ? <ResultBody role={{ session: r.session, applied: r.applied }} /> : r.state === 'unknown' ? <UnknownOutcome session={r.session} /> : <NotAttempted session={r.session} />}
    </section>
  );
}

/** Applying, per-change result (verified / failed / not attempted / not verified / uncertain) and the unknown-outcome case. */
export function ResultPanel({ editing }: { readonly editing: RoleEditing }) {
  const phase = editing.phase;
  if (phase.kind === 'applying') {
    const todo = changedSessions(phase.sessions);
    const index = todo.findIndex((s) => s.role.roleId === phase.current);
    const name = phase.sessions.get(phase.current)?.role.name ?? '';
    return (
      <section className="edit-result" aria-label="Applying changes">
        <p role="status" className="hint">
          Applying changes to {name}
          {todo.length > 1 ? ` (role ${index + 1} of ${todo.length})` : ''}… Do not close this window.
        </p>
      </section>
    );
  }
  if (phase.kind === 'unknown') {
    return (
      <section className="edit-result" aria-label="Edit result">
        <p role="alert" className="msg msg-error">{phase.message}</p>
        {phase.results.length > 1 && phase.results.map((r) => <RoleResultSection key={r.session.role.roleId} r={r} showName />)}
        <button type="button" onClick={() => editing.finish()}>Close and reload the role{phase.results.length > 1 ? 's' : ''}</button>
      </section>
    );
  }
  if (phase.kind !== 'done') return null;
  const many = phase.results.length > 1;
  const verified = phase.results.filter((r) => r.applied?.result.overall === 'succeeded').length;
  return (
    <section className="edit-result" aria-label="Edit result">
      {many && (
        <p role={verified === phase.results.length ? 'status' : 'alert'} className={`msg ${verified === phase.results.length ? 'msg-ok' : 'msg-warn'}`}>
          <strong>{verified} of {phase.results.length} roles verified.</strong>{' '}
          {verified === phase.results.length ? 'Every role was changed and confirmed by reading it again.' : 'The roles after the first one that did not complete were not changed. The details are below.'}
        </p>
      )}
      {phase.results.map((r) => <RoleResultSection key={r.session.role.roleId} r={r} showName={many} />)}
      <button type="button" className="primary" onClick={() => editing.finish()}>Close and reload the role{many ? 's' : ''}</button>
    </section>
  );
}
