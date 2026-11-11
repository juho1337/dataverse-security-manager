import { planBuMove, BuMovePlanError } from '../../domain/buMove/planner';
import type { BuMovePlan, BuMoveRequest } from '../../domain/buMove/types';
import { approvePlan, normalizeId } from '../../domain/operations';
import type { ReadResult } from '../../ports/securityDataReader';
import type { SecurityDataWriter } from '../../ports/securityDataWriter';
import { HISTORY_BLOCKED_MESSAGE, openLedger, recordedWriter, type LedgerStep } from '../operations/ledger';
import { placementState, roleHeldState } from '../operations/states';
import type { OperationRecorder } from '../operations/recorder';
import { executeBuMove, type BuMoveResult } from './execute';
import type { RetryCandidate } from './reconcile';
import type { BuManagerReader, PlanningData } from './ports';
import { userStateReader } from './ports';
import { writesForPlan, type BuMoveWrites } from './writePlan';

// The application side of the BU Manager (issues #271, #273): a dry-run plan from a FRESH read, and the confirmed execution. The UI only
// calls these; it holds no security rules. Planning never writes. Execution needs a person's confirmation of exactly this plan.

export interface PlannedMove {
  readonly plan: BuMovePlan;
  readonly writes: BuMoveWrites;
  /** Data gaps behind the plan (partial reads). Shown with the preview; a gap is never read as "nothing to worry about". */
  readonly notes: readonly string[];
  readonly userIds: readonly string[];
  /** Every role of the environment with its business unit, for the custom restore strategy's picker (the planner offers no candidates until a role is chosen). */
  readonly roleOptions: readonly RoleOption[];
  /** Set for a retry: only these step keys are planned and sent. */
  readonly only?: ReadonlySet<string>;
  /** For a retry: the operation it retries (recorded in the history as the source). */
  readonly sourceOperationId?: string;
}

export interface RoleOption {
  readonly id: string;
  readonly name: string;
  readonly businessUnitName: string;
}

export type PlanOutcome = { readonly ok: true; readonly planned: PlannedMove } | { readonly ok: false; readonly message: string };

/** Roles a person picked by hand (any role of the environment): the reader must read their privileges before they are compared. */
function chosenRoleIds(request: BuMoveRequest): string[] {
  const ids = [...request.choices, ...request.users.flatMap((u) => u.choices)].flatMap((c) => (c.chosenRoleId ? [c.chosenRoleId] : []));
  return [...new Set(ids)];
}

/** Reads the planning data again and plans. Never reuses an earlier plan or earlier data. */
export async function planMove(reader: BuManagerReader, request: BuMoveRequest): Promise<PlanOutcome> {
  const userIds = request.users.map((u) => u.userId);
  if (userIds.length === 0) return { ok: false, message: 'Select at least one user to move.' };
  let loaded: ReadResult<PlanningData>;
  try {
    loaded = await reader.loadPlanningData(userIds, request.targetBusinessUnitId, chosenRoleIds(request));
  } catch {
    return { ok: false, message: 'The data needed for the preview could not be read.' };
  }
  if (loaded.status === 'error') return { ok: false, message: loaded.message };
  const notes = loaded.status === 'partial' ? loaded.notes : [];
  try {
    const plan = planBuMove(loaded.data.snapshot, loaded.data.privileges, request, loaded.data.privilegesComplete && loaded.status === 'ok');
    const bu = new Map(loaded.data.snapshot.businessUnits.map((b) => [b.id, b.name]));
    const roleOptions = loaded.data.snapshot.roles
      .map((r): RoleOption => ({ id: r.id, name: r.name, businessUnitName: bu.get(r.businessUnitId) ?? 'unknown business unit' }))
      .sort((a, b) => a.name.localeCompare(b.name) || a.businessUnitName.localeCompare(b.businessUnitName) || a.id.localeCompare(b.id));
    return { ok: true, planned: { plan, writes: writesForPlan(plan), notes, userIds, roleOptions } };
  } catch (e) {
    if (e instanceof BuMovePlanError) return { ok: false, message: e.message };
    return { ok: false, message: 'The preview could not be built.' };
  }
}

export interface ConfirmedMove {
  readonly planned: PlannedMove;
  readonly writer: SecurityDataWriter;
  readonly reader: Pick<BuManagerReader, 'loadUserAccess'>;
  /** Who confirmed (shown in the audit and operation history). */
  readonly actor: string;
  /** The environment the preview was confirmed for; the write boundary compares it with the approved environment. */
  readonly environmentId: string;
  readonly now?: () => number;
  readonly isCancelled?: () => boolean;
  readonly onProgress?: (text: string) => void;
  /** The operation history. Without it the move works as before and is not recorded. */
  readonly recorder?: OperationRecorder;
}

/** Called ONLY after a person confirmed the preview. Approves exactly this plan for the environment, then executes and verifies it. Null when nothing can be sent. */
export async function confirmAndRun(c: ConfirmedMove): Promise<BuMoveResult | null> {
  if (!c.planned.writes.plan) return null;
  // A retry names the operation it retries; the ledger keeps that link (no rollback is implied: a retry is a new, separately confirmed operation).
  const retryContext = c.planned.only && c.planned.sourceOperationId ? { context: { source: 'retry' as const, sourceOperationId: c.planned.sourceOperationId } } : {};
  const approval = approvePlan(c.planned.writes.plan, c.environmentId, c.actor, (c.now ?? Date.now)(), retryContext);
  // The intent goes into the ledger before anything is sent; when that fails nothing is sent.
  const ledger = openLedger(c.recorder, approval);
  const blocked = ledger !== null && !(await ledger.begin());
  const result = await executeBuMove({
    plan: c.planned.plan,
    approval,
    writer: ledger && !blocked ? recordedWriter(c.writer, ledger) : c.writer,
    ...(blocked ? { abortReason: HISTORY_BLOCKED_MESSAGE } : {}),
    readState: userStateReader(c.reader),
    ...(c.planned.only ? { only: c.planned.only } : {}),
    ...(c.now ? { now: c.now } : {}),
    ...(c.isCancelled ? { isCancelled: c.isCancelled } : {}),
    ...(c.onProgress ? { onProgress: c.onProgress } : {}),
  });
  if (ledger && !blocked) {
    // `succeeded` means a fresh read showed the state; an accepted request alone is recorded as not verified. The step's own failure class is kept.
    // A move step records the user's placement (Business Unit and, when the read was complete, the direct role ids) as read before the first
    // step and after the last one. Only a move that was actually sent gets states: an already-satisfied step changed nothing.
    const steps: LedgerStep[] = result.users.flatMap((u) =>
      u.steps.map((st) => ({
        key: st.key,
        outcome: st.outcome,
        message: st.message,
        failure: st.failure,
        ...(st.kind === 'moveUser' && st.sent && u.before && u.after
          ? { before: placementState(u.userId, u.before), after: placementState(u.userId, u.after) }
          : st.kind === 'moveUser' && !st.sent && st.outcome === 'succeeded' && u.before
            ? { before: placementState(u.userId, u.before), after: placementState(u.userId, u.before) } // verified no-op: nothing changed, the state is the same
            : {}),
        // A role step that was sent records whether the user held the role in the complete reads before the first step and after the last.
        ...(st.kind === 'assignRole' && st.sent && st.roleId && u.before?.rolesComplete && u.after?.rolesComplete
          ? {
              before: roleHeldState(u.userId, st.roleId, u.before.directRoleIds.map(normalizeId).includes(normalizeId(st.roleId))),
              after: roleHeldState(u.userId, st.roleId, u.after.directRoleIds.map(normalizeId).includes(normalizeId(st.roleId))),
            }
          : st.kind === 'assignRole' && !st.sent && st.outcome === 'succeeded' && st.roleId && u.before?.rolesComplete
            ? (() => {
                const held = roleHeldState(u.userId, st.roleId, u.before.directRoleIds.map(normalizeId).includes(normalizeId(st.roleId)));
                return { before: held, after: held }; // verified no-op: already held
              })()
            : {}),
      })),
    );
    await ledger.finish(steps);
  }
  return result;
}

/**
 * A retry of what a read proved is not applied (see reconcile.ts). It reuses the reviewed plan of the original move, restricted to those
 * steps, and needs a new confirmation; the executor reads every user first, so nothing already applied is sent again. Null when nothing is left.
 */
export function planRetryOf(previous: PlannedMove, candidates: readonly RetryCandidate[]): PlannedMove | null {
  const only = new Set(candidates.flatMap((c) => c.steps.map((s) => s.key)));
  // Retrying a MOVE can remove roles the user holds right now (a read before the move says nothing about what the move does to them). So a
  // retry that includes the move also includes every planned role assignment of that user; the executor reads first and sends only what is missing.
  const full = writesForPlan(previous.plan).plan?.writes ?? [];
  for (const c of candidates) {
    if (!c.steps.some((s) => s.kind === 'moveUser')) continue;
    for (const w of full) if (w.kind === 'assignRole' && normalizeId(w.userId) === normalizeId(c.userId)) only.add(w.key);
  }
  const ids = new Set(candidates.map((c) => c.userId));
  const plan: BuMovePlan = { ...previous.plan, users: previous.plan.users.filter((u) => ids.has(u.user.id)) };
  const writes = writesForPlan(plan, only);
  if (!writes.plan) return null;
  return { plan, writes, notes: ['This is a retry of the steps a read showed were not applied. The decisions are those you reviewed for the original move.'], userIds: [...ids], roleOptions: previous.roleOptions, only };
}
