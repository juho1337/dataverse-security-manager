import type { ApprovedPlan, OperationResult, Outcome } from '../../domain/operations';
import { normalizeId } from '../../domain/operations';
import type { UserAccess } from '../../domain/buMove/types';
import type { ReadResult } from '../../ports/accessReader';
import type { SecurityDataWriter } from '../../ports/securityDataWriter';
import type { PlanItem } from './planner';

// Applies a CONFIRMED assignment plan (issue #270). A fresh read first (nothing already in the wanted state is sent, so no duplicate
// association), the writes in plan order, a stop at the first failed or uncertain write, and a fresh read at the end. An item is `succeeded`
// ONLY when that read shows the wanted state; a successful API response alone is `notVerified`.

/** A fresh read of the user's access. */
export type RereadUser = () => Promise<ReadResult<UserAccess>>;

export interface AssignmentItemResult {
  readonly item: PlanItem;
  readonly outcome: Outcome;
  readonly message: string;
  /** Whether the user was found holding the role directly after the final read; null when that read could not tell. */
  readonly heldAfter: boolean | null;
  /** Whether the user held the role directly in the complete read made just before applying (absent when nothing was read, i.e. nothing was sent). */
  readonly heldBefore?: boolean;
  /** True when nothing needed sending because the fresh read before applying already showed the wanted state. */
  readonly noChange?: boolean;
}

export interface AssignmentResult {
  readonly userId: string;
  readonly items: readonly AssignmentItemResult[];
  /** Whether the final read was complete. */
  readonly verified: boolean;
  readonly overall: Outcome;
}

export interface ApplyAssignmentsOptions {
  readonly userId: string;
  readonly items: readonly PlanItem[];
  readonly approval: ApprovedPlan;
  readonly writer: SecurityDataWriter;
  readonly reread: RereadUser;
  readonly isCancelled?: () => boolean;
  readonly onProgress?: (text: string) => void;
  /** When set nothing is sent and every item is reported as not attempted with this reason (for example: the history could not be written). */
  readonly abortReason?: string;
}

interface Held {
  readonly ids: ReadonlySet<string>;
  readonly complete: boolean;
}

const UNREADABLE: ReadResult<UserAccess> = { status: 'error', errorClass: 'unknown', message: 'The read failed.' };

function heldOf(result: ReadResult<UserAccess>): Held | null {
  if (result.status === 'error') return null;
  return { ids: new Set(result.data.directRoles.map((g) => normalizeId(g.role.id))), complete: result.status === 'ok' && result.data.isComplete };
}

function overallOf(items: readonly AssignmentItemResult[], verified: boolean): Outcome {
  // Items that needed no change (already in the wanted state when read) neither help nor hurt the overall result.
  const relevant = items.filter((i) => !i.noChange);
  if (relevant.length === 0) return 'skipped';
  if (relevant.every((i) => i.outcome === 'succeeded')) return 'succeeded';
  if (relevant.every((i) => i.outcome === 'succeeded' || i.outcome === 'notVerified')) return 'notVerified';
  if (!verified) return relevant.some((i) => i.outcome === 'failed' || i.outcome === 'uncertain') ? 'partiallyApplied' : 'notVerified';
  if (relevant.every((i) => i.outcome === 'failed' || i.outcome === 'skipped') && !relevant.some((i) => i.outcome === 'succeeded')) return 'failed';
  return 'partiallyApplied';
}

export async function applyAssignments(options: ApplyAssignmentsOptions): Promise<AssignmentResult> {
  const { userId, approval, writer, reread } = options;
  const planned = options.items.filter((i) => i.status === 'planned' && i.write);
  const skipAll = (message: string): AssignmentResult => ({
    userId,
    items: planned.map((item) => ({ item, outcome: 'skipped' as const, message, heldAfter: null })),
    verified: true,
    overall: planned.length === 0 ? 'skipped' : 'failed',
  });
  if (planned.length === 0) return skipAll('There is nothing to apply.');
  if (options.abortReason) return skipAll(options.abortReason);

  // Before sending: what the user holds right now. A change made meanwhile (by someone else, or an earlier run) is not repeated.
  const before = heldOf(await reread().catch(() => UNREADABLE));
  if (!before) return skipAll('The user’s roles could not be read before applying, so nothing was sent.');
  if (!before.complete) return skipAll('The user’s roles could not be read completely before applying, so nothing was sent.');

  const sent = new Map<string, OperationResult>();
  const noop = new Map<string, string>();
  let stopReason: string | null = null;
  for (const item of planned) {
    if (stopReason) break;
    if (options.isCancelled?.()) {
      stopReason = 'Cancelled before this change was attempted.';
      break;
    }
    const held = before.ids.has(item.roleId);
    if (item.action === 'assign' && held) {
      noop.set(item.roleId, 'Already assigned when read just before applying; nothing was sent.');
      continue;
    }
    if (item.action === 'unassign' && !held) {
      noop.set(item.roleId, 'Not assigned when read just before applying; nothing was sent.');
      continue;
    }
    options.onProgress?.(item.write?.description ?? '');
    let write: OperationResult;
    try {
      write = item.action === 'assign' ? await writer.assignRole(approval, userId, item.roleId) : await writer.unassignRole(approval, userId, item.roleId);
    } catch {
      // The port promises results, not exceptions; if it throws anyway the request may or may not have been applied.
      write = { outcome: 'uncertain', message: 'The write ended with an unexpected error; whether it was applied is not known until it is read again.', failure: 'execution' };
    }
    sent.set(item.roleId, write);
    if (write.outcome === 'failed') stopReason = 'An earlier change failed; this change was not attempted.';
    else if (write.outcome === 'uncertain') stopReason = 'An earlier change has an uncertain result; this change was not attempted.';
  }

  const after = heldOf(await reread().catch(() => UNREADABLE));
  const items: AssignmentItemResult[] = [];
  for (const item of planned) {
    const wanted = item.action === 'assign';
    const write = sent.get(item.roleId);
    // Presence is proof; absence is proof only when the read was complete.
    const heldNow = after ? after.ids.has(item.roleId) : null;
    const known: boolean | null = heldNow === null ? null : heldNow || after?.complete ? heldNow : null;
    if (!write) {
      const unchanged = noop.get(item.roleId);
      items.push({ item, outcome: 'skipped', message: unchanged ?? stopReason ?? 'Not attempted.', heldAfter: known, ...(unchanged ? { noChange: true } : {}) });
    } else if (known === null) {
      items.push({ item, outcome: write.outcome === 'failed' ? 'failed' : 'notVerified', message: `${write.message} Not verified: the user’s roles could not be re-read completely.`, heldAfter: null });
    } else if (known === wanted && after?.complete !== true) {
      // The role is seen, but an incomplete read cannot prove the whole state: accepted, not verified.
      items.push({ item, outcome: 'notVerified', message: `${write.message} Not verified: the user’s roles could not be re-read completely.`, heldAfter: known });
    } else if (known === wanted) {
      items.push({ item, outcome: 'succeeded', message: 'Confirmed by a re-read.', heldAfter: known });
    } else {
      items.push({
        item,
        outcome: 'failed',
        message: write.outcome === 'failed' ? write.message : `The request was accepted but the re-read does not show the role ${wanted ? 'assigned' : 'removed'}.`,
        heldAfter: known,
      });
    }
  }
  const verified = after?.complete === true;
  // What the complete read just before applying showed (the user's role list is complete here, otherwise nothing was sent).
  const withBefore = items.map((i) => ({ ...i, heldBefore: before.ids.has(i.item.roleId) }));
  return { userId, items: withBefore, verified, overall: overallOf(withBefore, verified) };
}
