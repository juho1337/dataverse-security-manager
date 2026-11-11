import { approvePlan, type ApprovedPlan } from '../../domain/operations';
import type { PrivilegeCells, RoleMatrix, RoleRow } from '../../domain/privileges';
import { evaluateEditability, startEdit, toWritePlan, type EditableRoleInfo, type EditSession } from '../../domain/roleEditing';
import type { SecurityDataReader } from '../../ports/securityDataReader';
import type { SecurityDataWriter } from '../../ports/securityDataWriter';
import { canonicalDepth } from '../operations/states';
import { HISTORY_BLOCKED_MESSAGE, openLedger, recordedWriter, type LedgerStep } from '../operations/ledger';
import type { OperationRecorder } from '../operations/recorder';
import { plannedWrite } from '../../domain/operations';
import { applyRoleEdit, type RoleEditResult } from './apply';

// The application side of in-matrix role editing (issue #267): what a matrix row needs to be editable, how a confirmed plan is approved and
// applied, and how the result is verified by re-reading the table's matrix. The UI only calls these; it holds no security rules.

/** Why a matrix row cannot be edited, or an edit session for it. Unknown managed state or lineage is never treated as editable. */
export type EditStart = { readonly ok: true; readonly session: EditSession } | { readonly ok: false; readonly reason: string; readonly redirectToRoleId?: string };

export function beginRoleEdit(matrix: RoleMatrix, row: RoleRow, matrixIncomplete: boolean): EditStart {
  if (!matrix.privilegeCatalog) return { ok: false, reason: 'The privileges of this table could not be identified, so a change cannot be made.' };
  if (row.isManaged === undefined) return { ok: false, reason: 'Whether this role is managed could not be read, so it is not offered for editing.' };
  if (row.parentRootRoleId === undefined) {
    return { ok: false, reason: 'The lineage of this role could not be read, so it is not clear whether it is a root role. It is not offered for editing.' };
  }
  const role: EditableRoleInfo = {
    roleId: row.roleId,
    name: row.name,
    isManaged: row.isManaged,
    isRootRole: row.parentRootRoleId === null,
    // A copy whose root is not in the loaded data has no root to redirect to: the refusal says so instead of naming a role that is not shown.
    ...(row.parentRootRoleId !== null && row.lineage?.rootMissing !== true ? { rootRoleId: row.parentRootRoleId } : {}),
    privilegeDataIncomplete: matrixIncomplete,
  };
  // Managed roles, incomplete data and Business Unit copies are refused up front, with the reason (and the root to edit instead).
  const editable = evaluateEditability(role);
  if (!editable.canEdit) return { ok: false, reason: editable.reason, ...(editable.redirectToRoleId ? { redirectToRoleId: editable.redirectToRoleId } : {}) };
  return { ok: true, session: startEdit(role, matrix.table.logicalName, row.cells, matrix.privilegeCatalog) };
}

export interface ConfirmedEdit {
  readonly session: EditSession;
  readonly writer: SecurityDataWriter;
  readonly reader: SecurityDataReader;
  /** Who confirmed the preview (shown in the audit and the operation history). */
  readonly actor: string;
  /** The environment the preview was confirmed for; the write boundary compares it with the approved environment. */
  readonly environmentId: string;
  readonly now?: () => number;
  readonly isCancelled?: () => boolean;
  readonly onProgress?: (text: string) => void;
  /** The operation history. Without it the edit works as before and is not recorded. */
  readonly recorder?: OperationRecorder;
}

/** Re-reads the matrix of the edited table and returns the privilege cells of one role; null when the read failed or the role is gone. */
export async function rereadRole(reader: SecurityDataReader, tableLogicalName: string, roleId: string): Promise<PrivilegeCells | null> {
  const result = await reader.loadRoleMatrix(tableLogicalName);
  if (result.status === 'error') return null;
  return result.data.roles.find((r) => r.roleId === roleId)?.cells ?? null;
}

export interface AppliedEdit {
  readonly approval: ApprovedPlan;
  readonly result: RoleEditResult;
}

/**
 * Called ONLY after a person confirmed the preview. Approves exactly the current plan for the environment, applies it through the approved
 * writer (the write boundary re-checks the confirmation, the identity and the exact request), re-reads the role and returns what was found.
 * Returns null when there is nothing to apply.
 */
export async function confirmAndApply(options: ConfirmedEdit): Promise<AppliedEdit | null> {
  const plan = toWritePlan(options.session);
  if (!plan) return null;
  const approval = approvePlan(plan, options.environmentId, options.actor, (options.now ?? Date.now)());
  const table = options.session.table;
  const roleId = options.session.role.roleId;
  // The intent goes into the ledger before anything is sent; when that fails nothing is sent.
  const ledger = openLedger(options.recorder, approval);
  // The state of the edited cells RIGHT BEFORE the write (a fresh read, not the matrix loaded when staging, which may be stale). When this read
  // fails nothing is recorded as `before` and the operation is simply not restorable; the write itself is not held up by it.
  const preCells = ledger ? await rereadRole(options.reader, table, roleId).catch(() => null) : null;
  const blocked = ledger !== null && !(await ledger.begin());
  const result = await applyRoleEdit({
    session: options.session,
    approval,
    writer: ledger && !blocked ? recordedWriter(options.writer, ledger) : options.writer,
    ...(blocked ? { abortReason: HISTORY_BLOCKED_MESSAGE } : {}),
    reread: () => rereadRole(options.reader, table, roleId).catch(() => null),
    ...(options.isCancelled ? { isCancelled: options.isCancelled } : {}),
    ...(options.onProgress ? { onProgress: options.onProgress } : {}),
  });
  if (ledger && !blocked) {
    // `succeeded` here means the re-read showed the wanted depth; an accepted request alone is recorded as not verified.
    const steps: LedgerStep[] = result.items.map((i) => {
      const cell = preCells?.[i.change.privilege];
      const state = (depth: ReturnType<typeof canonicalDepth>) => ({ kind: 'privilegeDepth' as const, table, roleId, privilegeId: i.change.privilegeId, privilege: i.change.privilege, depth });
      return {
        key: i.change.target === null
          ? plannedWrite.removePrivilege(roleId, i.change.privilegeId, '').key
          : plannedWrite.addPrivilege(roleId, i.change.privilegeId, i.change.target, '').key,
        outcome: i.outcome,
        message: i.message,
        // before: only a cell that was actually read (known) before the write; after: only what the re-read showed.
        ...(cell && cell.kind !== 'unknown' && cell.kind !== 'notApplicable' ? { before: state(canonicalDepth(cell)) } : {}),
        ...(i.foundKnown ? { after: state(canonicalDepth(i.foundDepth)) } : {}),
      };
    });
    await ledger.finish(steps);
  }
  return { approval, result };
}
