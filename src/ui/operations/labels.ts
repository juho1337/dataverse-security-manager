import type { OperationStatus, StepOutcome } from '../../domain/history/types';
import type { FailureClass } from '../../domain/operations';
import type { StepAction } from '../../domain/history/reconcile';

// Outcome is always shown as text plus a symbol; colour only reinforces it.

export interface StatusLabel {
  readonly symbol: string;
  readonly label: string;
  readonly hint: string;
}

const LABELS: Readonly<Record<OperationStatus | StepOutcome, StatusLabel>> = {
  succeeded: { symbol: '✓', label: 'Succeeded (verified)', hint: 'A re-read confirmed the end state.' },
  notVerified: { symbol: '?', label: 'Not verified', hint: 'Accepted by Dataverse; nothing confirmed the end state yet.' },
  uncertain: { symbol: '?!', label: 'Uncertain', hint: 'It may or may not have been applied.' },
  failed: { symbol: '✕', label: 'Failed', hint: 'It did not take effect.' },
  skipped: { symbol: '–', label: 'Skipped', hint: 'Nothing was sent.' },
  partiallyApplied: { symbol: '◐', label: 'Partially applied', hint: 'Only part of it took effect.' },
  inProgress: { symbol: '…', label: 'In progress', hint: 'Not finished.' },
  pending: { symbol: '…', label: 'Not attempted yet', hint: 'No result recorded.' },
};

export function statusLabel(status: OperationStatus | StepOutcome): StatusLabel {
  return LABELS[status];
}

/** The status of a whole operation: an operation that sent nothing is "No write", clearly apart from a verified success or a failure. */
export function operationStatusLabel(status: OperationStatus): StatusLabel {
  if (status === 'skipped') return { symbol: '–', label: 'No write', hint: 'Nothing was sent to Dataverse.' };
  if (status === 'inProgress') return { symbol: '…', label: 'Not finished', hint: 'No end was recorded; do not treat it as done.' };
  return LABELS[status];
}

/** The filter choices of the history list, in display order. */
export const STATUS_FILTERS: ReadonlyArray<{ readonly value: OperationStatus | 'all'; readonly label: string }> = [
  { value: 'all', label: 'All statuses' },
  { value: 'succeeded', label: 'Succeeded (verified)' },
  { value: 'failed', label: 'Failed' },
  { value: 'uncertain', label: 'Uncertain' },
  { value: 'notVerified', label: 'Not verified' },
  { value: 'partiallyApplied', label: 'Partially applied' },
  { value: 'skipped', label: 'No write' },
  { value: 'inProgress', label: 'Not finished' },
];

export function failureLabel(failure: FailureClass): string {
  return failure === 'none' ? 'None' : failure;
}

export const ACTION_LABEL: Readonly<Record<StepAction, string>> = {
  none: 'Nothing to do',
  reread: 'Read again',
  rereadThenRetry: 'Read again, then retry what is missing',
  retry: 'Safe to retry',
  review: 'Needs a person',
  inProgress: 'Still running',
};

/** Deterministic UTC display: 2026-11-02 10:00:00 UTC. */
export function formatTime(ms: number | undefined): string {
  if (ms === undefined || !Number.isFinite(ms) || Math.abs(ms) > 8.64e15) return '–';
  return new Date(ms).toISOString().replace('T', ' ').replace(/\.\d+Z$/, ' UTC');
}
