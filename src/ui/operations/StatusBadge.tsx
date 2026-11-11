import type { OperationStatus, StepOutcome } from '../../domain/history/types';
import { operationStatusLabel, statusLabel } from './labels';

/** Outcome as text plus a symbol (colour only reinforces it). `whole` uses the wording of a whole operation. */
export function StatusBadge({ status, whole = false }: { readonly status: OperationStatus | StepOutcome; readonly whole?: boolean }) {
  const l = whole ? operationStatusLabel(status as OperationStatus) : statusLabel(status);
  return (
    <span className={`ops-badge ops-${status}`} title={l.hint}>
      <span aria-hidden="true">{l.symbol}</span> {l.label}
    </span>
  );
}
