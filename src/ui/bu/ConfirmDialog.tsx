import { useEffect, useRef, useState } from 'react';
import type { PlannedMove } from '../../application/buManager/service';

/** Modal confirmation of exactly what will be sent. Cancel has the initial focus; Escape cancels; focus stays inside the dialog. */
export function ConfirmDialog({ planned, environmentLabel, notice, onCancel, onConfirm }: {
  readonly planned: PlannedMove;
  readonly environmentLabel: string;
  readonly notice: string | null;
  readonly onCancel: () => void;
  readonly onConfirm: (acknowledged: boolean) => void;
}) {
  const [ack, setAck] = useState(false);
  const cancelRef = useRef<HTMLButtonElement>(null);
  const confirmRef = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    cancelRef.current?.focus();
  }, []);
  const writes = planned.writes.plan?.writes ?? [];
  return (
    <div className="dialog-backdrop">
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="bu-confirm-title"
        className="dialog"
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
        <h2 id="bu-confirm-title">Confirm the move</h2>
        <p>
          These {writes.length} change{writes.length === 1 ? '' : 's'} will be sent, in this order, to <strong>{environmentLabel}</strong> for{' '}
          {planned.writes.included.length} user{planned.writes.included.length === 1 ? '' : 's'}. After each step the user is read again and the step is checked against what Dataverse then holds.
        </p>
        <ol className="bu-writes" aria-label="Changes in the order they are applied">
          {writes.map((w) => <li key={w.key}>{w.description}</li>)}
        </ol>
        <p className="hint">There is no automatic rollback. If a step fails, the steps already applied stay applied and the result shows which.</p>
        <label>
          <input type="checkbox" checked={ack} onChange={(e) => setAck(e.target.checked)} /> I have read the risks and warnings in the preview.
        </label>
        {notice && <p role="alert" className="msg msg-warn">{notice}</p>}
        <div className="dialog-actions">
          <button type="button" ref={cancelRef} onClick={onCancel}>Cancel</button>
          <button type="button" ref={confirmRef} className="primary" onClick={() => onConfirm(ack)} disabled={!ack}>Confirm and move</button>
        </div>
      </div>
    </div>
  );
}
