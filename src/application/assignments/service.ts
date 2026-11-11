import { approvePlan, type ApprovedPlan } from '../../domain/operations';
import type { AccessReader } from '../../ports/accessReader';
import type { SecurityDataWriter } from '../../ports/securityDataWriter';
import { HISTORY_BLOCKED_MESSAGE, openLedger, recordedWriter, type LedgerStep } from '../operations/ledger';
import { roleHeldState } from '../operations/states';
import type { OperationRecorder } from '../operations/recorder';
import { applyAssignments, type AssignmentResult } from './apply';
import type { AssignmentPlan } from './planner';

// The application side of direct role assignment (issue #270): approve exactly the previewed plan, apply it through the approved writer and
// verify by fresh reads. The UI calls only this; it holds no rules.

export interface ConfirmedAssignments {
  readonly plan: AssignmentPlan;
  readonly writer: SecurityDataWriter;
  readonly reader: Pick<AccessReader, 'loadUserAccess'>;
  /** Who confirmed the preview (recorded in the approval and the history). */
  readonly actor: string;
  /** The environment the preview was confirmed for; the write boundary compares it with the approved environment. */
  readonly environmentId: string;
  readonly now?: () => number;
  readonly isCancelled?: () => boolean;
  readonly onProgress?: (text: string) => void;
  /** The operation history. Without it the change works as before and is not recorded. */
  readonly recorder?: OperationRecorder;
}

export interface AppliedAssignments {
  readonly approval: ApprovedPlan;
  readonly result: AssignmentResult;
}

/** Called ONLY after a person confirmed the preview. Null when there is nothing to write. */
export async function confirmAndApplyAssignments(options: ConfirmedAssignments): Promise<AppliedAssignments | null> {
  const { plan } = options;
  if (!plan.plan) return null;
  const approval = approvePlan(plan.plan, options.environmentId, options.actor, (options.now ?? Date.now)());
  // The intent goes into the ledger before anything is sent; when that fails nothing is sent.
  const ledger = openLedger(options.recorder, approval);
  const blocked = ledger !== null && !(await ledger.begin());
  const result = await applyAssignments({
    userId: plan.userId,
    items: plan.items,
    approval,
    writer: ledger && !blocked ? recordedWriter(options.writer, ledger) : options.writer,
    ...(blocked ? { abortReason: HISTORY_BLOCKED_MESSAGE } : {}),
    reread: () => options.reader.loadUserAccess(plan.userId),
    ...(options.isCancelled ? { isCancelled: options.isCancelled } : {}),
    ...(options.onProgress ? { onProgress: options.onProgress } : {}),
  });
  if (ledger && !blocked) {
    // `succeeded` means a fresh read showed the wanted state; an accepted request alone is recorded as not verified.
    const steps: LedgerStep[] = result.items.flatMap((i) =>
      i.item.write
        ? [{
            key: i.item.write.key,
            outcome: i.outcome,
            message: i.message,
            // before: the complete read made just before applying; after: only what the final re-read showed (null = it could not tell).
            ...(i.heldBefore !== undefined ? { before: roleHeldState(plan.userId, i.item.roleId, i.heldBefore) } : {}),
            ...(i.heldAfter !== null ? { after: roleHeldState(plan.userId, i.item.roleId, i.heldAfter) } : {}),
          }]
        : [],
    );
    await ledger.finish(steps);
  }
  return { approval, result };
}
