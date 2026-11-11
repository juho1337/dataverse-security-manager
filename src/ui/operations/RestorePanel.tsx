import { useEffect, useRef, useState } from 'react';
import type { RestoreResult } from '../../application/operations/restore';
import type { RestoreItem, RestorePlan } from '../../domain/history/restore';
import type { OperationRecord, TargetState } from '../../domain/history/types';
import { Icon } from '../Icon';
import { humanize, nameOrShort, NO_NAMES, type NameMap } from './names';
import { StatusBadge } from './StatusBadge';
import type { RestoreController, RestoreWiring } from './useRestore';


/** A target state in plain words (ids are shortened; the full ids are in the report and the exports). */
export function stateText(s: TargetState | null, names: NameMap = NO_NAMES): string {
  if (s === null) return 'Could not be read';
  if (s.kind === 'privilegeDepth') return s.depth === 'None' ? 'Not held' : `${s.depth} depth`;
  if (s.kind === 'roleHeld') return s.held ? 'Role held' : 'Role not held';
  // The roles are named by id, not counted: two different role sets of the same size must not look alike.
  const roles = s.roleIds === null ? 'roles not read completely' : s.roleIds.length === 0 ? 'no direct roles' : `direct roles ${[...s.roleIds].map((r) => nameOrShort(r, names)).sort().join(', ')}`;
  return `Business Unit ${nameOrShort(s.businessUnitId, names)}, ${roles}`;
}

/** The target in words: the role and the user by name when their names were read, otherwise by shortened id. */
function targetText(i: RestoreItem, names: NameMap = NO_NAMES): string {
  const d = i.desired;
  if (d.kind === 'privilegeDepth') return `${d.privilege} on ${d.table}, role ${nameOrShort(d.roleId, names)}`;
  if (d.kind === 'roleHeld') return `Direct role ${nameOrShort(d.roleId, names)} of user ${nameOrShort(d.userId, names)}`;
  return `Business Unit placement of user ${nameOrShort(d.userId, names)}`;
}

/** What each kind of write does, as a short label for the step list and the colour of its chip. */
const VERB: Readonly<Record<string, { readonly label: string; readonly tone: 'add' | 'remove' | 'change' }>> = {
  addPrivilege: { label: 'Add privilege', tone: 'add' },
  removePrivilege: { label: 'Remove privilege', tone: 'remove' },
  assignRole: { label: 'Add role', tone: 'add' },
  unassignRole: { label: 'Remove role', tone: 'remove' },
  moveUser: { label: 'Move user', tone: 'change' },
};

const KIND_LABEL: Readonly<Record<RestoreItem['kind'], string>> = {
  privilege: 'Privilege depth',
  assignment: 'Role assignment',
  placement: 'Business Unit move',
};

const STATUS_TEXT: Readonly<Record<RestoreItem['status'], string>> = {
  restore: 'Will be restored',
  alreadyRestored: 'Already in the earlier state',
  blocked: 'Blocked',
};

/** Modal confirmation of exactly what will be sent. Cancel has the initial focus; Escape cancels; focus stays inside the dialog. */
function ConfirmDialog({ plan, names, environmentLabel, onCancel, onConfirm }: { readonly plan: RestorePlan; readonly names: NameMap; readonly environmentLabel: string; readonly onCancel: () => void; readonly onConfirm: () => void }) {
  const [ack, setAck] = useState(false);
  const cancelRef = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    cancelRef.current?.focus();
  }, []);
  const writes = plan.plan?.writes ?? [];
  const sideEffects = [...new Set(plan.items.filter((i) => i.status === 'restore').flatMap((i) => i.notVerified))];
  return (
    <div className="dialog-backdrop">
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="restore-confirm-title"
        className="dialog restore-dialog"
        onKeyDown={(e) => {
          if (e.key === 'Escape') {
            e.preventDefault();
            onCancel();
          } else if (e.key === 'Tab') {
            const focusable = Array.from(e.currentTarget.querySelectorAll<HTMLElement>('button, input, [href], select, textarea')).filter((el) => !el.hasAttribute('disabled'));
            const first = focusable[0];
            const last = focusable[focusable.length - 1];
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
          <span className="rd-icon" aria-hidden="true"><Icon name="restore" /></span>
          <div>
            <h2 id="restore-confirm-title">Confirm the restore</h2>
            <p className="rd-env">
              Environment: <strong className="rd-chip">{environmentLabel}</strong>
            </p>
          </div>
        </header>
        <p className="rd-lead">
          These {writes.length} change{writes.length === 1 ? '' : 's'} will be sent, in this order, to <strong>{environmentLabel}</strong>:
        </p>
        <ol className="ops-writes rd-steps" aria-label="Changes in the order they are applied">
          {writes.map((w) => {
            const verb = VERB[w.kind] ?? { label: 'Change', tone: 'change' as const };
            return (
              <li key={w.key}>
                <span className={`rd-verb rd-verb-${verb.tone}`}>{verb.label}</span>
                <span className="rd-step-text">{humanize(w.description, names)}</span>
              </li>
            );
          })}
        </ol>
        {sideEffects.length > 0 && sideEffects.map((t) => <p key={t} className="hint">{t}</p>)}
        <ul className="rd-safety" aria-label="How a restore is kept safe">
          <li><span className="rd-ok" aria-hidden="true"><Icon name="check" /></span> Before sending, every target is read again: if anything changed since this preview, nothing is sent.</li>
          <li><span className="rd-ok" aria-hidden="true"><Icon name="check" /></span> Afterwards every target is read again and judged against the state it had before the operation.</li>
          <li className="rd-caution"><span className="rd-warn" aria-hidden="true"><Icon name="warn" /></span> There is no automatic rollback of a restore. If a step fails, the steps already applied stay applied and the result shows which.</li>
        </ul>
        <label className="rd-ack">
          <input type="checkbox" checked={ack} onChange={(e) => setAck(e.target.checked)} /> I have read the preview, including what is blocked and what is not verified.
        </label>
        <div className="dialog-actions">
          <button type="button" ref={cancelRef} onClick={onCancel}>Cancel</button>
          <button type="button" className="primary" onClick={onConfirm} disabled={!ack}>Confirm and restore</button>
        </div>
      </div>
    </div>
  );
}

function PreviewBody({ plan, byId, names }: { readonly plan: RestorePlan; readonly byId: ReadonlyMap<string, OperationRecord>; readonly names: NameMap }) {
  const restorable = plan.operations.filter((o) => o.eligible && plan.restoredOperationIds.includes(o.operationId)).length;
  const nothing = plan.plan === null;
  return (
    <>
      <p className={`rp-summary ${nothing ? 'rp-summary-none' : 'rp-summary-ok'}`}>
        <span aria-hidden="true" className="rp-summary-icon"><Icon name={nothing ? 'warn' : 'check'} /></span>
        <span>
          {restorable} of {plan.operations.length} selected operation{plan.operations.length === 1 ? '' : 's'} can be restored, with{' '}
          {plan.writes.length} change{plan.writes.length === 1 ? '' : 's'} to send. An operation is restored as a whole: when one part cannot be restored, the rest of that operation is withheld.
        </span>
      </p>
      {nothing && <p role="alert" className="msg msg-warn">Nothing can be restored from this selection. Nothing will be sent.</p>}
      <h4>Selected operations</h4>
      <table className="ops-table">
        <caption className="ops-sr">Selected operations and whether each can be restored</caption>
        <thead>
          <tr><th scope="col">Operation</th><th scope="col">Started</th><th scope="col">Restore</th><th scope="col">Why</th></tr>
        </thead>
        <tbody>
          {plan.operations.map((o) => {
            const ok = o.eligible && plan.restoredOperationIds.includes(o.operationId);
            return (
              <tr key={o.operationId}>
                <th scope="row"><code>{o.operationId}</code></th>
                <td>{byId.get(o.operationId) ? new Date(byId.get(o.operationId)!.startedAtMs).toISOString().replace('T', ' ').slice(0, 16) + ' UTC' : ''}</td>
                <td><span className={`rp-badge ${ok ? 'rp-badge-ok' : 'rp-badge-no'}`}>{ok ? 'Can be restored' : 'Cannot be restored'}</span></td>
                <td>{ok ? 'Every change is verified and the target is still where the operation left it.' : o.reason ?? 'Nothing to restore.'}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
      {plan.items.length > 0 && (
        <>
          <h4>What would change</h4>
          <table className="ops-table">
            <caption className="ops-sr">Targets of the restore: state now and state it would return to</caption>
            <thead>
              <tr>
                <th scope="col">Target</th>
                <th scope="col">Type</th>
                <th scope="col">Status</th>
                <th scope="col">Now</th>
                <th scope="col">Will become</th>
                <th scope="col">Note</th>
              </tr>
            </thead>
            <tbody>
              {plan.items.map((i) => (
                <tr key={i.id} data-status={i.status}>
                  <th scope="row">{targetText(i, names)}</th>
                  <td>{KIND_LABEL[i.kind]}</td>
                  <td><span className={`rp-badge rp-badge-${i.status}`}>{STATUS_TEXT[i.status]}</span></td>
                  <td>{stateText(i.current, names)}</td>
                  <td>
                    {i.status === 'restore' ? <><span className="rp-arrow" aria-hidden="true"><Icon name="arrow" /></span>{stateText(i.desired, names)}</> : 'Unchanged'}
                    {i.status === 'restore' && i.kind === 'placement' && (
                      <ul className="ops-list" aria-label="Changes to this user, in order">
                        {i.writes.map((w) => <li key={w.key}>{humanize(w.description, names)}</li>)}
                      </ul>
                    )}
                  </td>
                  <td>
                    {i.reason ?? ''}
                    {i.notVerified.map((t) => <span key={t} className="ops-note"> {t}</span>)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </>
      )}
    </>
  );
}

function ResultBody({ plan, result, names }: { readonly plan: RestorePlan; readonly result: RestoreResult; readonly names: NameMap }) {
  const ok = result.items.filter((i) => i.outcome === 'succeeded').length;
  const total = result.items.length;
  const withheld = plan.items.filter((i) => i.status !== 'restore');
  const headline =
    result.overall === 'succeeded'
      ? `Restored and verified: ${ok} of ${total} target${total === 1 ? '' : 's'} read back in the earlier state.`
      : result.overall === 'skipped' || result.items.every((i) => i.outcome === 'skipped')
        ? 'Nothing was sent: no target was changed.'
        : result.overall === 'failed'
          ? `No target was fully restored (${ok} of ${total} verified), but some changes may already have been applied. Read the results below and the targets before doing anything else.`
          : `Not fully restored: ${ok} of ${total} target${total === 1 ? '' : 's'} verified. Read the details below before relying on it.`;
  return (
    <>
      <p role="status" className={result.overall === 'succeeded' ? 'msg msg-ok' : 'msg msg-warn'}>
        <StatusBadge status={result.overall} whole /> {headline}
      </p>
      {result.stoppedReason && <p role="alert" className="msg msg-warn">{result.stoppedReason}</p>}
      <p>
        {result.history === 'recorded' && <>The restore was recorded as its own operation <code>{result.operationId}</code> in the history (source: restore). </>}
        {result.history === 'blocked' && <>The history could not be written, so nothing was sent and no history entry exists. </>}
        {result.history === 'saveFailed' && <>The restore ran as operation <code>{result.operationId}</code>, but its history entry could not be saved completely: it may be missing or incomplete, so check the targets directly. </>}
        {result.history === 'none' && <>No history entry was kept for this restore. </>}
        It names the operations it reverses:{' '}
        {plan.restoredOperationIds.map((id, n) => <span key={id}>{n > 0 ? ', ' : ''}<code>{id}</code></span>)}.
        {result.restoredOperationIds.length > 0
          ? ` Fully restored and verified: ${result.restoredOperationIds.join(', ')}.`
          : ' No operation was fully restored.'}
      </p>
      <table className="ops-table">
        <caption className="ops-sr">Result per target</caption>
        <thead>
          <tr><th scope="col">Target</th><th scope="col">Result</th><th scope="col">Found by the re-read</th><th scope="col">Detail</th></tr>
        </thead>
        <tbody>
          {result.items.map((i) => (
            <tr key={i.item.id}>
              <th scope="row">{targetText(i.item, names)}</th>
              <td><StatusBadge status={i.outcome} /></td>
              <td>{stateText(i.found, names)}</td>
              <td>{i.message}</td>
            </tr>
          ))}
        </tbody>
      </table>
      {withheld.length > 0 && (
        <>
          <h4>Not part of this restore</h4>
          <ul className="ops-list">
            {withheld.map((i) => <li key={i.id}>{targetText(i, names)}: {STATUS_TEXT[i.status]}. {i.reason ?? ''}</li>)}
          </ul>
        </>
      )}
    </>
  );
}

/** The restore section of the Operations screen: start (from the selection), preview, confirm, run, result. */
export function RestorePanel({ wiring, controller, selected, history }: {
  readonly wiring: RestoreWiring | null;
  readonly controller: RestoreController;
  readonly selected: readonly OperationRecord[];
  readonly history: readonly OperationRecord[];
}) {
  const { phase, notice, names } = controller;
  const byId = new Map(selected.map((r) => [r.operationId, r]));
  const selectionKey = selected.map((r) => r.operationId).join('|');
  const previewKey = phase.kind === 'preview' ? phase.operationIds.join('|') : null;
  const startRef = useRef<HTMLButtonElement>(null);

  // A preview belongs to the selection it was built for: a different selection discards it.
  const closeRef = useRef(controller.close);
  closeRef.current = controller.close;
  useEffect(() => {
    if (previewKey !== null && previewKey !== selectionKey) closeRef.current();
  }, [previewKey, selectionKey]);

  const busy = phase.kind === 'planning' || phase.kind === 'running';
  return (
    <fieldset className="ops-restore">
      <legend>Restore</legend>
      {!wiring ? (
        <p className="ops-note">Restore is available only while connected to a Dataverse environment with write access. It is not offered in demo mode.</p>
      ) : (
        <p className="ops-note">
          Select operations above, then preview a restore. The tool returns verified changes to the state it read before them, only when the target is still where the operation left
          it. You see exactly what would change before anything is sent.
        </p>
      )}
      {notice && <p role="alert" className="msg msg-warn">{notice}</p>}

      {(phase.kind === 'idle' || phase.kind === 'error') && (
        <p className="ops-actions">
          <button type="button" ref={startRef} className="ops-primary" disabled={!wiring || selected.length === 0 || busy} onClick={() => void controller.preview(selected, history)}>
            Preview restore of selected operations ({selected.length})
          </button>
          {wiring && selected.length === 0 && <span className="ops-note"> Select one or more operations first.</span>}
        </p>
      )}
      {phase.kind === 'error' && <p role="alert" className="msg msg-error">{phase.message}</p>}
      {phase.kind === 'planning' && <p role="status">Reading the current state of every target...</p>}

      {(phase.kind === 'preview' || phase.kind === 'confirm') && (
        <section aria-label="Restore preview" className="ops-restore-preview">
          <h3>Restore preview</h3>
          <PreviewBody plan={phase.plan} byId={byId} names={names} />
          <p className="ops-actions">
            <button type="button" onClick={controller.close}>Cancel</button>{' '}
            <button type="button" className="ops-primary" onClick={controller.openConfirm} disabled={phase.plan.plan === null}>Continue to confirmation</button>
          </p>
        </section>
      )}
      {phase.kind === 'confirm' && wiring && (
        <ConfirmDialog plan={phase.plan} names={names} environmentLabel={wiring.environmentLabel} onCancel={controller.cancelConfirm} onConfirm={() => void controller.confirm()} />
      )}
      {phase.kind === 'running' && (
        <p role="status" aria-live="polite">Restoring... {phase.progress}</p>
      )}
      {phase.kind === 'done' && (
        <section aria-label="Restore result" className="ops-restore-result">
          <h3>Restore result</h3>
          <ResultBody plan={phase.plan} result={phase.result} names={names} />
          <p className="ops-actions"><button type="button" onClick={controller.close}>Close result</button></p>
        </section>
      )}
      {phase.kind === 'unknown' && (
        <section aria-label="Restore result">
          <p role="alert" className="msg msg-error">{phase.message}</p>
          <p className="ops-actions"><button type="button" onClick={controller.close}>Close</button></p>
        </section>
      )}
    </fieldset>
  );
}
