import type { ApprovedPlan, OperationResult, Outcome } from '../../domain/operations';
import {
  heldDepthOf,
  orderedChanges,
  toWritePlan,
  type EditSession,
  type HeldDepth,
  type StagedChange,
} from '../../domain/roleEditing';
import type { PrivilegeCells } from '../../domain/privileges';
import type { SecurityDataWriter } from '../../ports/securityDataWriter';

// Applies a CONFIRMED role privilege plan (issue #266). Mirrors the XrmToolBox RoleEditApplier:
//  - the staged changes must be exactly the confirmed plan, otherwise nothing is sent;
//  - changes are sent in plan order, additions and increases first; reductions start only after every earlier addition is
//    confirmed by a re-read (an accepted request is not proof);
//  - it stops at the first failed or uncertain change; the rest are reported as not attempted;
//  - the role is re-read whatever happened, and a change is `succeeded` only when the re-read shows the wanted depth.
// Applying again only does what is still missing. The only write path is the SecurityDataWriter port.

/** Re-reads the privilege cells of one role record on the edited table; null when the read failed. */
export type RereadRole = (roleId: string) => Promise<PrivilegeCells | null>;

export interface RoleEditItemResult {
  readonly change: StagedChange;
  readonly outcome: Outcome;
  readonly message: string;
  /** Depth found when the role was re-read; null when not held or when the re-read failed or was unknown. */
  readonly foundDepth: HeldDepth;
  /** False when the depth was not actually read (the re-read failed or the cell is unknown): `foundDepth` is then meaningless, never "not held". */
  readonly foundKnown: boolean;
}

export interface RoleEditResult {
  readonly roleId: string;
  readonly items: readonly RoleEditItemResult[];
  /** Whether the re-read could be interpreted for the edited cells. */
  readonly verified: boolean;
  readonly overall: Outcome;
}

export interface ApplyRoleEditOptions {
  readonly session: EditSession;
  readonly approval: ApprovedPlan;
  readonly writer: SecurityDataWriter;
  readonly reread: RereadRole;
  readonly isCancelled?: () => boolean;
  readonly onProgress?: (text: string) => void;
  /** When set nothing is sent and every change is reported as not attempted with this reason (for example: the history could not be written). */
  readonly abortReason?: string;
}

function overallOf(items: readonly RoleEditItemResult[], verified: boolean): Outcome {
  if (items.length === 0) return 'skipped';
  if (items.every((i) => i.outcome === 'succeeded')) return 'succeeded';
  if (items.every((i) => i.outcome === 'succeeded' || i.outcome === 'notVerified')) return 'notVerified';
  if (!verified) return items.some((i) => i.outcome === 'failed' || i.outcome === 'uncertain') ? 'partiallyApplied' : 'notVerified';
  if (items.every((i) => i.outcome === 'failed' || i.outcome === 'skipped')) return 'failed';
  return 'partiallyApplied';
}

function describe(c: StagedChange): string {
  return `${c.table} ${c.privilege}: ${c.original ?? 'not held'} -> ${c.target ?? 'not held'}`;
}

export async function applyRoleEdit(options: ApplyRoleEditOptions): Promise<RoleEditResult> {
  const { session, approval, writer, reread } = options;
  const ordered = orderedChanges(session);
  const roleId = session.role.roleId;
  const skipAll = (message: string): RoleEditResult => ({
    roleId,
    items: ordered.map((change) => ({ change, outcome: 'skipped' as const, message, foundDepth: null, foundKnown: false })),
    verified: true,
    overall: ordered.length === 0 ? 'skipped' : 'failed',
  });

  if (options.abortReason) return skipAll(options.abortReason);
  const current = toWritePlan(session);
  if (!current) return skipAll('There is nothing to apply, or this role may not be edited. Nothing was written.');
  // The session may have changed after the confirmation (an edit undone or added). Writing only part of what was confirmed, for example
  // a removal whose replacement addition was undone, could remove access without establishing the replacement.
  if (current.hash !== approval.planHash) {
    return skipAll('The staged changes no longer match the plan you confirmed. Nothing was written; review and confirm again.');
  }

  const sent = new Map<string, { readonly outcome: Outcome; readonly message: string }>();
  let stopReason: string | null = null;
  let checkpointDone = false;

  const foundIn = (cells: PrivilegeCells, change: StagedChange): { readonly known: boolean; readonly depth: HeldDepth } => {
    const cell = cells[change.privilege];
    return cell.kind === 'unknown' ? { known: false, depth: null } : { known: true, depth: heldDepthOf(cell) };
  };

  for (const change of ordered) {
    if (stopReason) break;
    if (options.isCancelled?.()) {
      stopReason = 'Cancelled before this change was attempted.';
      break;
    }
    const reduction = change.kind === 'remove' || change.kind === 'decrease';
    if (reduction && !checkpointDone && sent.size > 0) {
      checkpointDone = true;
      const cells = await reread(roleId).catch(() => null);
      if (!cells) {
        stopReason = 'An earlier addition could not be confirmed by a re-read, so reductions were not started.';
        break;
      }
      const unconfirmed = ordered.filter((c) => sent.has(c.privilege) && (c.kind === 'add' || c.kind === 'increase')).find((c) => {
        const f = foundIn(cells, c);
        return !f.known || f.depth !== c.target;
      });
      if (unconfirmed) {
        stopReason = `The earlier change "${describe(unconfirmed)}" is not confirmed by a re-read, so reductions were not started.`;
        break;
      }
    }
    // Cancellation may have been requested while the checkpoint re-read was pending: check again right before sending.
    if (options.isCancelled?.()) {
      stopReason = 'Cancelled before this change was attempted.';
      break;
    }
    options.onProgress?.(`Applying ${describe(change)}`);
    let write: OperationResult;
    try {
      write =
        change.target === null
          ? await writer.removePrivilege(approval, roleId, change.privilegeId)
          : await writer.addPrivilege(approval, roleId, change.privilegeId, change.target);
    } catch {
      // The port promises results, not exceptions; if it throws anyway the request may or may not have been applied.
      // Treat it as uncertain, stop, and let the final re-read report what really happened.
      write = { outcome: 'uncertain', message: 'The write ended with an unexpected error; whether it was applied is not known until it is read again.', failure: 'execution' };
    }
    sent.set(change.privilege, { outcome: write.outcome, message: write.message });
    if (write.outcome === 'failed') stopReason = 'An earlier change failed; this change was not attempted.';
    else if (write.outcome === 'uncertain') stopReason = 'An earlier change has an uncertain result; this change was not attempted.';
  }

  // Re-read whatever happened: after a failure or cancellation it shows exactly what was applied.
  const cells = await reread(roleId).catch(() => null);
  const items: RoleEditItemResult[] = [];
  let verified = cells !== null;
  for (const change of ordered) {
    const result = sent.get(change.privilege);
    if (!result) {
      const found = cells ? foundIn(cells, change) : null;
      const untouched = found?.known === true && found.depth === change.original;
      items.push({
        change,
        outcome: 'skipped',
        message: `${stopReason ?? 'Not attempted.'}${untouched || !found ? '' : ' The re-read shows a different value than before.'}`,
        foundDepth: found?.known ? found.depth : null,
        foundKnown: found?.known === true,
      });
      continue;
    }
    if (!cells) {
      items.push({
        change,
        outcome: result.outcome === 'failed' ? 'failed' : 'notVerified',
        message: `${result.message} Not verified: the role could not be re-read.`,
        foundDepth: null,
        foundKnown: false,
      });
      continue;
    }
    const found = foundIn(cells, change);
    if (!found.known) {
      verified = false;
      items.push({ change, outcome: result.outcome === 'failed' ? 'failed' : 'notVerified', message: `${result.message} Not verified: the re-read could not interpret this value.`, foundDepth: null, foundKnown: false });
    } else if (found.depth === change.target) {
      items.push({ change, outcome: 'succeeded', message: 'Confirmed by a re-read.', foundDepth: found.depth, foundKnown: true });
    } else {
      items.push({
        change,
        outcome: 'failed',
        message: result.outcome === 'failed' ? result.message : 'The request was accepted but the re-read does not show the wanted depth.',
        foundDepth: found.depth,
        foundKnown: true,
      });
    }
  }
  return { roleId, items, verified, overall: overallOf(items, verified) };
}
