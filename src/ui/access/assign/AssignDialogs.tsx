import { useEffect, useRef } from 'react';
import { Icon } from '../../Icon';
import type { Outcome } from '../../../domain/operations';
import { RECORD_ACCESS_NOTE } from './AssignRoles';
import type { RoleAssignments } from './useRoleAssignments';

const ACTION_TEXT = { assign: 'Add', unassign: 'Remove' } as const;

const OUTCOME_TEXT: Record<Outcome, string> = {
  succeeded: 'Verified',
  failed: 'Failed',
  skipped: 'Not attempted',
  partiallyApplied: 'Partly applied',
  notVerified: 'Accepted, not verified',
  uncertain: 'Uncertain',
};

const OVERALL_TEXT: Record<Outcome, string> = {
  succeeded: 'Every change was applied and confirmed by reading the user’s roles again.',
  failed: 'No change was applied.',
  skipped: 'Nothing needed to be sent.',
  partiallyApplied: 'Some changes were applied and some were not. The table shows which.',
  notVerified: 'Dataverse accepted the changes, but they could not be confirmed by a re-read. Treat them as not verified.',
  uncertain: 'The outcome is uncertain. Read the user’s roles again before trying anything else.',
};

/** Modal preview of exactly what confirming will send. Cancel is the safe default focus; Escape cancels. */
export function AssignPreviewDialog({ assign, environmentLabel }: { readonly assign: RoleAssignments; readonly environmentLabel: string }) {
  const phase = assign.phase;
  const cancelRef = useRef<HTMLButtonElement>(null);
  const confirmRef = useRef<HTMLButtonElement>(null);
  const open = phase.kind === 'previewing';
  const invoker = useRef<HTMLElement | null>(null);
  const cancelled = useRef(false);
  useEffect(() => {
    if (open) {
      // Remember what opened the preview so cancelling returns the keyboard user to it.
      invoker.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
      cancelRef.current?.focus();
    } else if (cancelled.current) {
      // The trigger is disabled while the preview is open, so focus can only return once the dialog has closed.
      cancelled.current = false;
      const target = invoker.current;
      invoker.current = null;
      if (target?.isConnected) target.focus();
    }
  }, [open]);
  const cancel = () => {
    cancelled.current = true;
    assign.cancelPreview();
  };
  if (phase.kind !== 'previewing') return null;
  const { plan } = phase;
  const writes = plan.items.filter((i) => i.status === 'planned');
  const notSent = plan.items.filter((i) => i.status !== 'planned');
  return (
    <div className="dialog-backdrop">
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="assign-preview-title"
        className="dialog restore-dialog"
        onKeyDown={(e) => {
          if (e.key === 'Escape') {
            e.preventDefault();
            cancel();
          } else if (e.key === 'Tab') {
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
        <header className="rd-head">
          <span className="rd-icon" aria-hidden="true"><Icon name="roles" /></span>
          <div>
            <h2 id="assign-preview-title">Review role changes</h2>
            <p className="rd-env">Direct roles of <strong>{plan.userName}</strong></p>
          </div>
        </header>
        <p className="rd-lead">
          These changes will be sent to <strong className="rd-chip">{environmentLabel}</strong>, in this order.
        </p>
        <table className="preview-table">
          <caption className="sr-only">Role changes in the order they are applied</caption>
          <thead>
            <tr><th scope="col">Change</th><th scope="col">Role</th><th scope="col">Business unit</th><th scope="col">Note</th></tr>
          </thead>
          <tbody>
            {writes.map((i) => (
              <tr key={i.roleId}>
                <th scope="row"><span className={`rd-verb ${i.action === 'assign' ? 'rd-verb-add' : 'rd-verb-remove'}`}>{ACTION_TEXT[i.action]}</span></th>
                <td><strong>{i.roleName}</strong></td>
                <td>{i.businessUnitName}</td>
                <td>{i.reason}</td>
              </tr>
            ))}
          </tbody>
        </table>
        {notSent.length > 0 && (
          <>
            <h3>Not sent</h3>
            <ul aria-label="Changes that are not sent">
              {notSent.map((i) => <li key={i.roleId}><strong>{i.roleName}</strong>: {i.reason}</li>)}
            </ul>
          </>
        )}
        {plan.warnings.map((w) => <p key={w} className="msg msg-warn" role="note">{w}</p>)}
        <p className="hint">{RECORD_ACCESS_NOTE}</p>
        <p className="hint rd-caution-note"><span className="rd-warn" aria-hidden="true"><Icon name="warn" /></span><span>After applying, the user’s roles are read again and every change is checked against what Dataverse then holds. There is no automatic undo; a removed role has to be assigned again.</span></p>
        <div className="dialog-actions">
          <button type="button" ref={cancelRef} onClick={cancel}>Cancel</button>
          <button type="button" ref={confirmRef} className="primary" onClick={() => void assign.confirm()}>Confirm and apply</button>
        </div>
      </div>
    </div>
  );
}

/** Applying, per-change result (verified / failed / not attempted / not verified / uncertain) and the unknown-outcome case. */
export function AssignResultPanel({ assign }: { readonly assign: RoleAssignments }) {
  const phase = assign.phase;
  const regionRef = useRef<HTMLElement>(null);
  const showing = phase.kind === 'applying' || phase.kind === 'done' || phase.kind === 'unknown';
  // The result is drawn below the user's roles, often outside the visible part of the page: bring it into view when it appears.
  useEffect(() => {
    if (showing) regionRef.current?.scrollIntoView?.({ block: 'start', behavior: 'smooth' });
  }, [showing, phase.kind]);
  if (phase.kind === 'applying') {
    return (
      <section className="edit-result assign-result" aria-label="Applying role changes" ref={regionRef}>
        <p role="status" className="hint assign-applying"><span className="spin-icon" aria-hidden="true"><Icon name="spinner" /></span>Applying role changes for {phase.plan.userName}… Do not close this window.</p>
      </section>
    );
  }
  if (phase.kind === 'unknown') {
    return (
      <section className="edit-result assign-result" aria-label="Role change result" ref={regionRef}>
        <p role="alert" className="msg msg-error">{phase.message}</p>
        <button type="button" onClick={() => assign.finish()}>Close and reload the user</button>
      </section>
    );
  }
  if (phase.kind !== 'done') return null;
  const { result } = phase.applied;
  const bad = result.overall !== 'succeeded';
  return (
    <section className="edit-result assign-result" aria-label="Role change result" ref={regionRef}>
      <div className="assign-result-head">
        <h3>Result for {phase.plan.userName}</h3>
        <button type="button" className="primary" onClick={() => assign.finish()}>Close and reload the user</button>
      </div>
      <p role={bad ? 'alert' : 'status'} className={`msg assign-banner ${bad ? 'msg-warn' : 'msg-ok'}`}>
        <span className="assign-banner-icon" aria-hidden="true"><Icon name={bad ? 'warn' : 'check'} /></span>
        <span>
          <strong>{OUTCOME_TEXT[result.overall]}.</strong> {OVERALL_TEXT[result.overall]}
          {!result.verified && ' The re-read was not complete.'}
        </span>
      </p>
      <table className="preview-table">
        <caption className="sr-only">Result of each change</caption>
        <thead>
          <tr><th scope="col">Role</th><th scope="col">Intended</th><th scope="col">Found after re-read</th><th scope="col">Outcome</th><th scope="col">Detail</th></tr>
        </thead>
        <tbody>
          {result.items.map((i) => (
            <tr key={i.item.roleId} data-outcome={i.outcome}>
              <th scope="row">{i.item.roleName} <span className="access-result-meta">({i.item.businessUnitName})</span></th>
              <td>{i.item.action === 'assign' ? 'Assigned' : 'Removed'}</td>
              <td>{i.heldAfter === null ? 'Unknown (not read)' : i.heldAfter ? 'Assigned directly' : 'Not assigned directly'}</td>
              <td><strong className={`rp-badge ${i.outcome === 'succeeded' ? 'rp-badge-ok' : i.outcome === 'failed' ? 'rp-badge-no' : 'rp-badge-warn'}`}>{OUTCOME_TEXT[i.outcome]}</strong></td>
              <td>{i.message}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <p className="hint">{RECORD_ACCESS_NOTE}</p>
    </section>
  );
}
